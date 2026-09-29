// Slack integration — port of the slack-notify / slack-channels / slack-digest
// Edge Functions. Talks to the Slack Web API directly (Bearer SLACK_BOT_TOKEN)
// instead of the old Lovable connector gateway.
//
// Exports (see index.ts):
//   handleSlackNotify(c)   — POST /api/functions/slack-notify   (member JWT)
//   handleSlackChannels(c) — POST /api/functions/slack-channels (member JWT)
//   runSlackDigest(env,ctx)— hourly cron entrypoint (scheduled())
//
// Upstream bug FIXED here: the old slack-notify silently no-op'd on
// type 'report' / 'approval_request' / 'approval_completed' (client sends
// prebuilt blocks). This port posts those to the configured channel.

import type { Context } from 'hono';
import type { AppContext, Ctx, Env } from '../env';
import { appBaseUrl, DEFAULT_WORKSPACE, isDemoWorkspace } from '../env';
import { TABLES } from '../tables';
import { rowToWire, type TableMeta } from '../meta';
import { checkProfessional } from '../license';

// ─── Table meta (defensive fallback while tables.ts is authoritative) ──────

const FALLBACK_META: TableMeta = { pk: 'id', clientAccess: 'full' };
const metaFor = (table: string): TableMeta => TABLES[table] ?? FALLBACK_META;

// ─── Slack bot token resolution ────────────────────────────────────────────
// Customer-bound token (slack_config.bot_token, row id = workspace id, set
// from the app UI) wins; falls back to env.SLACK_BOT_TOKEN (instance-level
// secret) ONLY for workspace 'default' — a beta tenant must never inherit the
// instance token or its messages would land in the seller's Slack. This is
// what lets a self-host customer bind their OWN workspace without editing env.
export async function resolveSlackToken(env: Env, workspaceId: string): Promise<string | undefined> {
  try {
    const row = await env.DB.prepare('SELECT bot_token FROM slack_config WHERE id = ? LIMIT 1')
      .bind(workspaceId)
      .first<{ bot_token: string | null }>();
    if (row?.bot_token) return row.bot_token;
  } catch {
    /* slack_config table may not exist on a pre-migration DB — fall through */
  }
  return workspaceId === DEFAULT_WORKSPACE ? env.SLACK_BOT_TOKEN || undefined : undefined;
}

// ─── Small coercion helpers (robust regardless of registry completeness) ───

function asBool(v: unknown, dflt: boolean): boolean {
  if (v === null || v === undefined) return dflt;
  return !!v;
}

function asNumber(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function asStringArray(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v !== '') {
    try {
      const p: unknown = JSON.parse(v);
      if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string');
    } catch {
      /* not JSON */
    }
  }
  return null;
}

// ─── License gate (shared canonical check_license port, professional) ──────

const LICENSE_REQUIRED_BODY = {
  error: 'license_required',
  message: '此功能需要專業版授權。請聯繫 service@livo-tw.com 升級。',
} as const;

// ─── Slack Web API helpers ─────────────────────────────────────────────────

const SLACK_API = 'https://slack.com/api';

type SlackBlock = Record<string, unknown>;

interface SlackUser {
  id: string;
  deleted?: boolean;
  is_bot?: boolean;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  channels?: { id: string; name?: string; is_private?: boolean; is_member?: boolean }[];
  channel?: { id: string };
  members?: SlackUser[];
  user?: SlackUser;
  response_metadata?: { next_cursor?: string };
}

/** Per-invocation Slack context (token + users.list cache). */
interface SlackCtx {
  token: string;
  usersCache: SlackUser[] | null;
}

async function slackGet(
  sc: SlackCtx,
  method: string,
  params?: Record<string, string>
): Promise<SlackApiResponse> {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : '';
  const resp = await fetch(`${SLACK_API}/${method}${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${sc.token}` },
  });
  return (await resp.json()) as SlackApiResponse;
}

async function slackPost(
  sc: SlackCtx,
  method: string,
  body: Record<string, unknown>
): Promise<SlackApiResponse> {
  const resp = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sc.token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  return (await resp.json()) as SlackApiResponse;
}

/** Resolve a channel setting (name, '#name' or ID) to a channel ID. */
async function resolveChannelId(sc: SlackCtx, setting: string): Promise<string> {
  const name = setting.replace(/^#/, '');
  const data = await slackGet(sc, 'conversations.list', {
    limit: '200',
    exclude_archived: 'true',
    types: 'public_channel,private_channel',
  });
  if (data.ok && data.channels) {
    const found = data.channels.find((ch) => ch.name === name || ch.id === setting);
    if (found) return found.id;
  }
  return setting;
}

/** Paginated users.list, cached per invocation. */
async function usersList(sc: SlackCtx): Promise<SlackUser[]> {
  if (sc.usersCache) return sc.usersCache;
  const all: SlackUser[] = [];
  let cursor = '';
  do {
    const params: Record<string, string> = { limit: '200' };
    if (cursor) params.cursor = cursor;
    const data = await slackGet(sc, 'users.list', params);
    if (!data.ok) {
      console.error('[slack] users.list error:', data.error);
      break;
    }
    all.push(...(data.members || []));
    cursor = data.response_metadata?.next_cursor || '';
  } while (cursor);
  sc.usersCache = all;
  return all;
}

async function lookupUserByEmail(sc: SlackCtx, email: string): Promise<SlackUser | null> {
  try {
    const data = await slackGet(sc, 'users.lookupByEmail', { email });
    if (data.ok && data.user) return data.user;
  } catch {
    /* fall through to name matching */
  }
  return null;
}

function findSlackUserByName(users: SlackUser[], name: string): SlackUser | undefined {
  const normalized = name.trim().toLowerCase();
  return users.find((u) => {
    if (u.deleted || u.is_bot) return false;
    const realName = (u.real_name || '').toLowerCase();
    const displayName = (u.profile?.display_name || '').toLowerCase();
    const profileRealName = (u.profile?.real_name || '').toLowerCase();
    return realName === normalized || displayName === normalized || profileRealName === normalized;
  });
}

/** Email lookup first, then name-match fallback via users.list. */
async function findSlackUserId(
  sc: SlackCtx,
  email: string,
  name: string | undefined
): Promise<string | null> {
  if (email) {
    const byEmail = await lookupUserByEmail(sc, email);
    if (byEmail) return byEmail.id;
  }
  if (name) {
    const users = await usersList(sc);
    const found = findSlackUserByName(users, name);
    if (found) return found.id;
  }
  return null;
}

/** conversations.open with a user → DM channel id. */
async function openDm(sc: SlackCtx, slackUserId: string): Promise<string | null> {
  const data = await slackPost(sc, 'conversations.open', { users: slackUserId });
  if (!data.ok || !data.channel) {
    console.error(`[slack] conversations.open failed for ${slackUserId} — ${data.error}`);
    return null;
  }
  return data.channel.id;
}

async function postMessage(
  sc: SlackCtx,
  channel: string,
  text: string,
  blocks: SlackBlock[],
  username: string,
  iconEmoji: string
): Promise<SlackApiResponse> {
  return slackPost(sc, 'chat.postMessage', {
    channel,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
    username,
    icon_emoji: iconEmoji,
  });
}

// ─── slack-notify: payload + block builders (faithful port) ────────────────

interface NotifyPayload {
  type: string;
  taskKey?: string;
  taskTitle?: string;
  taskId?: string;
  projectName?: string;
  actorName?: string;
  priority?: string;
  assigneeName?: string;
  statusName?: string;
  dueDate?: string;
  fromStatus?: string;
  toStatus?: string;
  oldAssignee?: string;
  newAssignee?: string;
  commentPreview?: string;
  dmTargets?: { email: string; name?: string; reason: string }[];
  /** Prebuilt Block Kit blocks from the client (report / approval types). */
  blocks?: SlackBlock[];
  // type 'report'
  reportContent?: string;
  reportTitle?: string;
  reportType?: string;
  channelTarget?: string;
  // approval types
  requestId?: string;
  action?: string;
  customMessage?: string;
}

const priorityEmoji: Record<string, string> = {
  highest: '🔴', high: '🟠', medium: '🟡', low: '🔵', lowest: '⚪',
  '最高': '🔴', '高': '🟠', '中': '🟡', '低': '🔵', '最低': '⚪',
};

const typeLabel: Record<string, { emoji: string; text: string }> = {
  task_created: { emoji: '✨', text: '新任務建立' },
  status_changed: { emoji: '🔀', text: '狀態變更' },
  assignee_changed: { emoji: '🔁', text: '指派變更' },
  priority_changed: { emoji: '⚡', text: '優先級變更' },
  comment_added: { emoji: '💬', text: '新評論' },
};

const TASK_EVENT_TYPES = [
  'task_created',
  'status_changed',
  'assignee_changed',
  'comment_added',
  'priority_changed',
];

const taskUrl = (env: Env, taskKey: string): string =>
  `${appBaseUrl(env)}/demo/?task=${encodeURIComponent(taskKey)}`;

function buildBlocks(env: Env, payload: NotifyPayload): SlackBlock[] {
  const key = payload.taskKey || '';
  const taskLink = `<${taskUrl(env, key)}|${key} - ${payload.taskTitle || ''}>`;
  const project = payload.projectName || '—';
  const pEmoji = priorityEmoji[payload.priority || 'medium'] || '🟡';
  const { emoji, text: headerText } = typeLabel[payload.type] || { emoji: '📋', text: '任務通知' };

  const lines: string[] = [];

  // Line 1: header
  lines.push(`${emoji} *${headerText}*`);
  // Line 2: task link
  lines.push(taskLink);

  switch (payload.type) {
    case 'task_created':
      lines.push(`🙋 建立者: ${payload.actorName ?? ''}`);
      if (payload.assigneeName) lines.push(`👤 經辦人: ${payload.assigneeName}`);
      if (payload.statusName) lines.push(`📊 狀態: ${payload.statusName}`);
      lines.push(`${pEmoji} 優先級: ${payload.priority || 'medium'}`);
      if (payload.dueDate) lines.push(`📅 到期日: ${payload.dueDate}`);
      break;

    case 'status_changed':
      lines.push(`🙋 變更者: ${payload.actorName ?? ''}`);
      lines.push(`📊 狀態: ${payload.fromStatus || '—'} → ${payload.toStatus || '—'}`);
      if (payload.assigneeName) lines.push(`👤 經辦人: ${payload.assigneeName}`);
      break;

    case 'assignee_changed':
      lines.push(`🙋 變更者: ${payload.actorName ?? ''}`);
      lines.push(`👤 指派: ${payload.oldAssignee || '未指派'} → ${payload.newAssignee || '未指派'}`);
      if (payload.statusName) lines.push(`📊 狀態: ${payload.statusName}`);
      break;

    case 'priority_changed': {
      const fromPEmoji = priorityEmoji[payload.fromStatus || 'medium'] || '🟡';
      const toPEmoji = priorityEmoji[payload.toStatus || 'medium'] || '🟡';
      lines.push(`🙋 變更者: ${payload.actorName ?? ''}`);
      lines.push(`${fromPEmoji} ${payload.fromStatus || '—'} → ${toPEmoji} ${payload.toStatus || '—'}`);
      if (payload.assigneeName) lines.push(`👤 經辦人: ${payload.assigneeName}`);
      if (payload.statusName) lines.push(`📊 狀態: ${payload.statusName}`);
      break;
    }

    case 'comment_added':
      lines.push(`🙋 評論者: ${payload.actorName ?? ''}`);
      if (payload.commentPreview) {
        lines.push(`💭 評論內容:`);
        lines.push(payload.commentPreview);
      }
      if (payload.assigneeName) lines.push(`👤 經辦人: ${payload.assigneeName}`);
      break;
  }

  // Last line: project
  lines.push(`📁 項目: ${project}`);

  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    { type: 'divider' },
  ];
}

const dmReasonEmoji: Record<string, string> = {
  '你被指派為經辦人': '🎯',
  '你被指派為驗收人': '✅',
  '你在留言中被提及': '💬',
};

function buildDmBlocks(env: Env, payload: NotifyPayload, reason: string): SlackBlock[] {
  const key = payload.taskKey || '';
  const taskLink = `<${taskUrl(env, key)}|${key} - ${payload.taskTitle || ''}>`;
  const pEmoji = priorityEmoji[payload.priority || 'medium'] || '🟡';
  const project = payload.projectName || '—';
  const headerIcon = dmReasonEmoji[reason] || typeLabel[payload.type]?.emoji || '🔔';

  const lines: string[] = [];
  lines.push(`${headerIcon} *${reason}*`);
  lines.push(taskLink);
  lines.push(`🙋 來自: ${payload.actorName ?? ''}`);
  lines.push(`${pEmoji} 優先級: ${payload.priority || 'medium'}`);

  if (payload.type === 'comment_added' && payload.commentPreview) {
    lines.push(`💭 評論內容:`);
    lines.push(payload.commentPreview);
  }

  lines.push(`📁 項目: ${project}`);

  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    { type: 'divider' },
  ];
}

async function sendTaskDm(
  env: Env,
  sc: SlackCtx,
  email: string,
  reason: string,
  payload: NotifyPayload,
  memberName?: string
): Promise<void> {
  try {
    const slackUserId = await findSlackUserId(sc, email, memberName);
    if (!slackUserId) {
      console.log(`[slack] DM: user not found for email=${email}, name=${memberName}`);
      return;
    }

    const dmChannelId = await openDm(sc, slackUserId);
    if (!dmChannelId) return;

    const blocks = buildDmBlocks(env, payload, reason);
    const msgData = await postMessage(
      sc,
      dmChannelId,
      `${reason}: ${payload.taskKey || ''} ${payload.taskTitle || ''}`,
      blocks,
      'PM 任務通知',
      ':bell:'
    );
    if (!msgData.ok) {
      console.error(`[slack] DM: failed to send message — ${msgData.error}`);
    }
  } catch (err) {
    console.error(`[slack] DM error for ${email}:`, err);
  }
}

// ─── Notify settings (backup_settings single row) ──────────────────────────

interface NotifySettings {
  taskNotifyChannel: string;
  enabledTypes: string[];
  dmEnabled: boolean;
  dmStartHour: number;
  dmEndHour: number;
}

async function loadNotifySettings(env: Env, workspaceId: string): Promise<NotifySettings> {
  // SELECT * (not an explicit column list): DBs created before the dm_notify_*
  // columns existed would make an explicit SELECT throw "no such column",
  // which killed every slack-notify call. Missing fields fall back to defaults.
  const raw = await env.DB.prepare('SELECT * FROM backup_settings WHERE workspace_id = ? LIMIT 1')
    .bind(workspaceId)
    .first<Record<string, unknown>>();

  const row = raw ? rowToWire(raw, metaFor('backup_settings')) : {};
  const channel =
    (typeof row.task_notify_channel === 'string' && row.task_notify_channel) ||
    (typeof row.notify_channel === 'string' && row.notify_channel) ||
    '';
  return {
    taskNotifyChannel: channel,
    enabledTypes: asStringArray(row.task_notify_types) || [
      'task_created',
      'status_changed',
      'assignee_changed',
      'comment_added',
    ],
    dmEnabled: asBool(row.dm_notify_enabled, true),
    dmStartHour: asNumber(row.dm_notify_start_hour, 0),
    dmEndHour: asNumber(row.dm_notify_end_hour, 24),
  };
}

// ─── handleSlackNotify ─────────────────────────────────────────────────────

export async function handleSlackNotify(c: Context<AppContext>): Promise<Response> {
  const env = c.env;
  const ws = c.get('auth').member.workspaceId;
  const token = await resolveSlackToken(env, ws);
  if (!token) return c.json({ error: 'slack_not_configured' });

  try {
    const payload = (await c.req.json()) as NotifyPayload;

    // License check — professional feature (caller's workspace)
    if (!(await checkProfessional(env, ws))) {
      return c.json(LICENSE_REQUIRED_BODY, 403);
    }

    const sc: SlackCtx = { token, usersCache: null };
    const settings = await loadNotifySettings(env, ws);

    // ── type 'report' (upstream no-op bug FIXED) ──────────────────────────
    if (payload.type === 'report') {
      const target = payload.channelTarget || settings.taskNotifyChannel;
      if (!target) return c.json({ error: 'no_channel_configured' });

      const title = payload.reportTitle || '報告';
      const blocks: SlackBlock[] =
        Array.isArray(payload.blocks) && payload.blocks.length > 0
          ? payload.blocks
          : [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: `📝 *${title}*\n\n${payload.reportContent || ''}` },
              },
              { type: 'divider' },
            ];

      const channelId = await resolveChannelId(sc, target);
      const res = await postMessage(sc, channelId, title, blocks, 'PM 任務通知', ':clipboard:');
      if (!res.ok) {
        console.error('[slack] report post error:', res.error);
        return c.json({ error: res.error || 'slack_error' });
      }
      return c.json({ success: true });
    }

    // ── approval types (upstream no-op bug FIXED) ─────────────────────────
    if (payload.type === 'approval_request' || payload.type === 'approval_completed') {
      if (!settings.taskNotifyChannel) return c.json({ error: 'no_channel_configured' });

      const blocks: SlackBlock[] = Array.isArray(payload.blocks) ? payload.blocks : [];
      const fallbackText =
        `${payload.taskKey || ''} ${payload.taskTitle || ''}`.trim() || '簽核通知';

      const channelId = await resolveChannelId(sc, settings.taskNotifyChannel);
      const res = await postMessage(sc, channelId, fallbackText, blocks, 'PM 任務通知', ':clipboard:');
      if (!res.ok) {
        console.error('[slack] approval post error:', res.error);
        return c.json({ error: res.error || 'slack_error' });
      }
      return c.json({ success: true });
    }

    // ── the 5 task event types (faithful port) ────────────────────────────
    if (!TASK_EVENT_TYPES.includes(payload.type)) {
      return c.json({ error: `unknown notify type: ${payload.type}` });
    }

    // Channel notification if this type is enabled and a channel is set
    if (settings.taskNotifyChannel && settings.enabledTypes.includes(payload.type)) {
      const channelId = await resolveChannelId(sc, settings.taskNotifyChannel);
      const blocks = buildBlocks(env, payload);
      const fallbackText = `${payload.actorName ?? ''} - ${payload.taskKey || ''} ${payload.taskTitle || ''}`;
      const res = await postMessage(sc, channelId, fallbackText, blocks, 'PM 任務通知', ':clipboard:');
      if (!res.ok) {
        console.error('[slack] channel error:', res.error);
      }
    }

    // DMs if targets specified and DM notifications are enabled
    if (payload.dmTargets && payload.dmTargets.length > 0) {
      if (settings.dmEnabled) {
        // Time window check (Taiwan time UTC+8), wrap-around supported
        const nowTW = new Date(Date.now() + 8 * 60 * 60 * 1000);
        const currentHour = nowTW.getUTCHours();
        const { dmStartHour: startHour, dmEndHour: endHour } = settings;
        const inWindow =
          startHour <= endHour
            ? currentHour >= startHour && currentHour < endHour
            : currentHour >= startHour || currentHour < endHour;

        if (inWindow) {
          await Promise.allSettled(
            payload.dmTargets.map((t) => sendTaskDm(env, sc, t.email, t.reason, payload, t.name))
          );
        } else {
          console.log(`[slack] DM skipped: current hour ${currentHour} outside window ${startHour}-${endHour}`);
        }
      } else {
        console.log('[slack] DM skipped: dm_notify_enabled is false');
      }
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('[slack] notify error:', err);
    return c.json({ error: String(err) }, 500);
  }
}

// ─── handleSlackChannels ───────────────────────────────────────────────────

export async function handleSlackChannels(c: Context<AppContext>): Promise<Response> {
  const token = await resolveSlackToken(c.env, c.get('auth').member.workspaceId);
  if (!token) return c.json({ error: 'slack_not_configured' });

  try {
    const sc: SlackCtx = { token, usersCache: null };
    const data = await slackGet(sc, 'conversations.list', {
      limit: '200',
      exclude_archived: 'true',
      types: 'public_channel,private_channel',
    });
    if (!data.ok) {
      return c.json({ error: data.error }, 500);
    }
    // is_member drives the frontend「需先 /invite bot 到此頻道」hint — the most
    // common customer-setup failure is picking a channel the bot isn't in.
    const channels = (data.channels || []).map((ch) => ({
      id: ch.id,
      name: ch.name,
      is_private: ch.is_private || false,
      is_member: ch.is_member || false,
    }));
    return c.json({ channels });
  } catch (err) {
    console.error('[slack] channels error:', err);
    return c.json({ error: String(err) }, 500);
  }
}

// ─── slack-digest (hourly cron) ────────────────────────────────────────────

interface TaskRow {
  task_key: string;
  title: string;
  priority: string | null;
  status_id: string | null;
  project_id: string | null;
  due_date: string | null;
  completed_at?: string | null;
}

interface TaskInfo {
  taskKey: string;
  title: string;
  priority: string;
  statusName: string;
  projectName: string;
  dueDate?: string;
}

async function queryTaskRows(env: Env, sql: string, binds: unknown[]): Promise<TaskRow[]> {
  const stmt = binds.length ? env.DB.prepare(sql).bind(...binds) : env.DB.prepare(sql);
  const { results } = await stmt.all<Record<string, unknown>>();
  const meta = metaFor('tasks');
  return (results || []).map((r) => rowToWire(r, meta) as unknown as TaskRow);
}

async function getAssignedTasks(
  env: Env,
  ws: string,
  memberId: string,
  doneStatusIds: string[]
): Promise<TaskRow[]> {
  let sql =
    'SELECT task_key, title, priority, status_id, project_id, due_date FROM tasks WHERE workspace_id = ? AND assignee_id = ?';
  const binds: unknown[] = [ws, memberId];
  if (doneStatusIds.length > 0) {
    sql += ` AND status_id NOT IN (${doneStatusIds.map(() => '?').join(',')})`;
    binds.push(...doneStatusIds);
  }
  return queryTaskRows(env, sql, binds);
}

async function getReviewTasks(
  env: Env,
  ws: string,
  memberId: string,
  reviewStatusIds: string[]
): Promise<TaskRow[]> {
  if (reviewStatusIds.length === 0) return [];
  const sql = `SELECT task_key, title, priority, status_id, project_id, due_date FROM tasks WHERE workspace_id = ? AND reviewer_id = ? AND status_id IN (${reviewStatusIds.map(() => '?').join(',')})`;
  return queryTaskRows(env, sql, [ws, memberId, ...reviewStatusIds]);
}

function enrichTasks(
  tasks: TaskRow[],
  statusMap: Map<string, string>,
  projectMap: Map<string, string>
): TaskInfo[] {
  return tasks.map((t) => ({
    taskKey: t.task_key,
    title: t.title,
    priority: t.priority || 'medium',
    statusName: statusMap.get(t.status_id || '') || '未知',
    projectName: projectMap.get(t.project_id || '') || '—',
    dueDate: t.due_date || undefined,
  }));
}

// ── Digest builder ──

function buildDigestBlocks(
  env: Env,
  memberName: string,
  assigned: TaskInfo[],
  review: TaskInfo[]
): SlackBlock[] {
  const link = (t: TaskInfo) => `<${taskUrl(env, t.taskKey)}|${t.taskKey}>`;
  const lines: string[] = [];
  lines.push(`📋 *${memberName} 的任務摘要*`);
  lines.push('');

  if (assigned.length > 0) {
    lines.push(`*待辦任務（${assigned.length} 項）：*`);
    for (const t of assigned.slice(0, 15)) {
      const pe = priorityEmoji[t.priority] || '🟡';
      const due = t.dueDate ? ` | 📅 ${t.dueDate}` : '';
      lines.push(`  ${pe} ${link(t)} ${t.title}${due}`);
    }
    if (assigned.length > 15) lines.push(`  _(還有 ${assigned.length - 15} 項)_`);
    lines.push('');
  }

  if (review.length > 0) {
    lines.push(`*待驗收任務（${review.length} 項）：*`);
    for (const t of review.slice(0, 10)) {
      const pe = priorityEmoji[t.priority] || '🟡';
      lines.push(`  ${pe} ${link(t)} ${t.title}`);
    }
    if (review.length > 10) lines.push(`  _(還有 ${review.length - 10} 項)_`);
    lines.push('');
  }

  if (assigned.length === 0 && review.length === 0) {
    lines.push('✅ 目前沒有待辦或待驗收任務，太棒了！');
  }

  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    { type: 'divider' },
  ];
}

// ── Report builders ──

interface ReportData {
  completed: TaskInfo[];
  inProgress: TaskInfo[];
  overdue: TaskInfo[];
  upcoming: TaskInfo[];
  allTasks: TaskInfo[];
}

function buildDefaultDailyReport(env: Env, memberName: string, data: ReportData): string {
  const link = (t: TaskInfo) => `<${taskUrl(env, t.taskKey)}|${t.taskKey}>`;
  const lines: string[] = [];
  lines.push(`📝 *${memberName} 的日報*  (${new Date().toISOString().split('T')[0]})`);
  lines.push('');

  lines.push('*✅ 今日完成：*');
  if (data.completed.length > 0) {
    for (const t of data.completed.slice(0, 10)) {
      lines.push(`  • ${link(t)} ${t.title}`);
    }
  } else {
    lines.push('  _（無）_');
  }
  lines.push('');

  lines.push('*🔄 進行中：*');
  if (data.inProgress.length > 0) {
    for (const t of data.inProgress.slice(0, 10)) {
      const due = t.dueDate ? ` (截止: ${t.dueDate})` : '';
      lines.push(`  • ${link(t)} ${t.title}${due}`);
    }
  } else {
    lines.push('  _（無）_');
  }
  lines.push('');

  lines.push('*📅 即將到期（3天內）：*');
  if (data.upcoming.length > 0) {
    for (const t of data.upcoming.slice(0, 10)) {
      lines.push(`  • ⚠️ ${link(t)} ${t.title} (${t.dueDate})`);
    }
  } else {
    lines.push('  _（無）_');
  }

  if (data.overdue.length > 0) {
    lines.push('');
    lines.push('*🚨 已逾期：*');
    for (const t of data.overdue.slice(0, 10)) {
      lines.push(`  • 🔴 ${link(t)} ${t.title} (${t.dueDate})`);
    }
  }

  return lines.join('\n');
}

function buildDefaultWeeklyReport(env: Env, memberName: string, data: ReportData): string {
  const link = (t: TaskInfo) => `<${taskUrl(env, t.taskKey)}|${t.taskKey}>`;
  const lines: string[] = [];
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  lines.push(
    `📊 *${memberName} 的週報*  (${weekStart.toISOString().split('T')[0]} ~ ${now.toISOString().split('T')[0]})`
  );
  lines.push('');

  lines.push('*✅ 本週完成：*');
  if (data.completed.length > 0) {
    for (const t of data.completed.slice(0, 15)) {
      lines.push(`  • ${link(t)} ${t.title}`);
    }
  } else {
    lines.push('  _（無）_');
  }
  lines.push('');

  lines.push('*🔄 未完成 / 進行中：*');
  if (data.inProgress.length > 0) {
    for (const t of data.inProgress.slice(0, 15)) {
      const due = t.dueDate ? ` (截止: ${t.dueDate})` : '';
      lines.push(`  • ${link(t)} ${t.title}${due}`);
    }
  } else {
    lines.push('  _（無）_');
  }
  lines.push('');

  lines.push('*📅 下週重點：*');
  if (data.upcoming.length > 0) {
    for (const t of data.upcoming.slice(0, 15)) {
      lines.push(`  • ${link(t)} ${t.title} (${t.dueDate})`);
    }
  } else {
    lines.push('  _（無）_');
  }

  if (data.overdue.length > 0) {
    lines.push('');
    lines.push('*🚨 已逾期：*');
    for (const t of data.overdue.slice(0, 10)) {
      lines.push(`  • 🔴 ${link(t)} ${t.title} (${t.dueDate})`);
    }
  }

  return lines.join('\n');
}

function applyCustomTemplate(template: string, data: ReportData): string {
  const format = (tasks: TaskInfo[]) =>
    tasks
      .map((t) => `• ${t.taskKey} ${t.title}${t.dueDate ? ` (${t.dueDate})` : ''}`)
      .join('\n') || '（無）';
  return template
    .replace(/\{\{completed_tasks\}\}/g, format(data.completed))
    .replace(/\{\{in_progress_tasks\}\}/g, format(data.inProgress))
    .replace(/\{\{overdue_tasks\}\}/g, format(data.overdue))
    .replace(/\{\{upcoming_deadlines\}\}/g, format(data.upcoming))
    .replace(/\{\{all_tasks\}\}/g, format(data.allTasks))
    .replace(/\{\{date\}\}/g, new Date().toISOString().split('T')[0] as string)
    .replace(/\{\{task_count\}\}/g, String(data.allTasks.length))
    .replace(/\{\{completed_count\}\}/g, String(data.completed.length))
    .replace(/\{\{in_progress_count\}\}/g, String(data.inProgress.length))
    .replace(/\{\{overdue_count\}\}/g, String(data.overdue.length));
}

// ── DM / channel send helpers for the digest ──

async function digestSendDm(
  sc: SlackCtx,
  slackUserId: string,
  text: string,
  blocks: SlackBlock[]
): Promise<void> {
  const dmChannelId = await openDm(sc, slackUserId);
  if (!dmChannelId) return;
  const res = await postMessage(sc, dmChannelId, text, blocks, 'LIVO', ':clipboard:');
  if (!res.ok) console.error('[slack] digest DM error:', res.error);
}

async function digestSendChannel(
  sc: SlackCtx,
  channelSetting: string,
  text: string,
  blocks: SlackBlock[]
): Promise<void> {
  const channelId = await resolveChannelId(sc, channelSetting);
  const res = await postMessage(sc, channelId, text, blocks, 'LIVO', ':clipboard:');
  if (!res.ok) console.error('[slack] digest channel error:', res.error);
}

// ── Main digest entrypoint (cron) ──

export async function runSlackDigest(env: Env, _ctx: Ctx): Promise<void> {
  try {
    const now = new Date();
    // Taiwan time (UTC+8): both hour and weekday computed in TW time so a
    // weekly digest configured for e.g. Monday 07:00 fires on TW Monday.
    const nowTW = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const adjustedHour = nowTW.getUTCHours();
    const currentDay = nowTW.getUTCDay(); // 0=Sun..6=Sat

    // Fetch prefs/configs first and filter by the current hour — on the 23/24
    // hourly runs where nothing is due, skip loading the lookup tables entirely.
    const [prefsRes, cfgRes] = await Promise.all([
      env.DB
        .prepare('SELECT * FROM user_notification_preferences WHERE enabled = 1')
        .all<Record<string, unknown>>(),
      env.DB.prepare('SELECT * FROM user_report_configs WHERE enabled = 1').all<Record<string, unknown>>(),
    ]);
    const digestPrefs = (prefsRes.results || [])
      .map((r) => rowToWire(r, metaFor('user_notification_preferences')))
      .filter((pref) => {
        if (asNumber(pref.hour, -1) !== adjustedHour) return false;
        if (pref.frequency === 'weekly' && currentDay !== asNumber(pref.weekday, -1)) return false;
        return true;
      });
    const reportConfigs = (cfgRes.results || [])
      .map((r) => rowToWire(r, metaFor('user_report_configs')))
      .filter((cfg) => {
        if (asNumber(cfg.hour, -1) !== adjustedHour) return false;
        if (cfg.report_type === 'weekly' && currentDay !== asNumber(cfg.weekday, -1)) return false;
        return true;
      });

    if (digestPrefs.length === 0 && reportConfigs.length === 0) {
      console.log(`[slack] digest done: sent=0 time=${now.toISOString()}`);
      return;
    }

    // Group the due rows by workspace — each workspace resolves its own token,
    // license, and lookup maps (tenant isolation; the demo workspace never
    // sends anything).
    type WireRow = Record<string, unknown>;
    const wsOf = (row: WireRow): string =>
      typeof row.workspace_id === 'string' && row.workspace_id !== ''
        ? row.workspace_id
        : DEFAULT_WORKSPACE;
    const byWorkspace = new Map<string, { prefs: WireRow[]; configs: WireRow[] }>();
    const wsBucket = (ws: string) => {
      let b = byWorkspace.get(ws);
      if (!b) {
        b = { prefs: [], configs: [] };
        byWorkspace.set(ws, b);
      }
      return b;
    };
    for (const pref of digestPrefs) wsBucket(wsOf(pref)).prefs.push(pref);
    for (const cfg of reportConfigs) wsBucket(wsOf(cfg)).configs.push(cfg);

    let sentCount = 0;

    for (const [ws, due] of byWorkspace) {
      // Never spray outbound messages from the public demo workspace.
      if (isDemoWorkspace(env, ws)) continue;
      // License check — professional feature (per workspace)
      if (!(await checkProfessional(env, ws))) continue;
      const token = await resolveSlackToken(env, ws);
      if (!token) continue; // Slack not configured for this workspace

      const sc: SlackCtx = { token, usersCache: null };

      // Load lookup data (workspace-scoped)
      const [statusRes, projectRes, memberRes] = await Promise.all([
        env.DB
          .prepare('SELECT id, name, is_done FROM statuses WHERE workspace_id = ?')
          .bind(ws)
          .all<Record<string, unknown>>(),
        env.DB
          .prepare('SELECT id, name FROM projects WHERE workspace_id = ?')
          .bind(ws)
          .all<Record<string, unknown>>(),
        env.DB
          .prepare('SELECT id, name, email FROM members WHERE workspace_id = ?')
          .bind(ws)
          .all<Record<string, unknown>>(),
      ]);

      const statusMap = new Map<string, string>();
      const doneStatusIds: string[] = [];
      const reviewStatusIds: string[] = [];
      for (const raw of statusRes.results || []) {
        const s = rowToWire(raw, metaFor('statuses'));
        const id = String(s.id ?? '');
        const name = typeof s.name === 'string' ? s.name : '';
        if (!id) continue;
        statusMap.set(id, name);
        if (s.is_done) doneStatusIds.push(id);
        // "驗收" or "Review" status for review tasks
        if (name.includes('驗收') || name.toLowerCase().includes('review')) {
          reviewStatusIds.push(id);
        }
      }

      const projectMap = new Map<string, string>();
      for (const p of projectRes.results || []) {
        projectMap.set(String(p.id ?? ''), typeof p.name === 'string' ? p.name : '');
      }

      const memberMap = new Map<string, { name: string; email: string }>();
      for (const m of memberRes.results || []) {
        memberMap.set(String(m.id ?? ''), {
          name: typeof m.name === 'string' ? m.name : '',
          email: typeof m.email === 'string' ? m.email : '',
        });
      }

      // ─── Part 1: Task Digest ─────────────────────────────────
      for (const pref of due.prefs) {
        // (already filtered to the current hour/weekday above)
        const userId = String(pref.user_id ?? '');
        const member = memberMap.get(userId);
        if (!member) continue;

        // Get tasks
        const includeAssigned = asBool(pref.include_assigned, true);
        const includeReview = asBool(pref.include_review, true);
        const assignedRaw = includeAssigned ? await getAssignedTasks(env, ws, userId, doneStatusIds) : [];
        const reviewRaw = includeReview ? await getReviewTasks(env, ws, userId, reviewStatusIds) : [];
        const assigned = enrichTasks(assignedRaw, statusMap, projectMap);
        const review = enrichTasks(reviewRaw, statusMap, projectMap);

        if (assigned.length === 0 && review.length === 0) continue;

        const slackUserId = await findSlackUserId(sc, member.email, member.name);
        if (!slackUserId) continue;

        const blocks = buildDigestBlocks(env, member.name, assigned, review);
        await digestSendDm(sc, slackUserId, `${member.name} 的任務摘要`, blocks);

        // Update last_sent_at (user_id is globally unique; ws predicate is hygiene)
        await env.DB.prepare(
          'UPDATE user_notification_preferences SET last_sent_at = ? WHERE user_id = ? AND workspace_id = ?'
        )
          .bind(now.toISOString(), userId, ws)
          .run();
        sentCount++;
      }

      // ─── Part 2: Auto Reports ────────────────────────────────
      for (const cfg of due.configs) {
        // (already filtered to the current hour/weekday above)
        const userId = String(cfg.user_id ?? '');
        const member = memberMap.get(userId);
        if (!member) continue;

        // Build report data based on scope (always workspace-scoped; the
        // all-tasks fall-through must not leak other tenants' tasks)
        const today = now.toISOString().split('T')[0] as string;
        const threeDaysLater = new Date(now.getTime() + 3 * 86400000)
          .toISOString()
          .split('T')[0] as string;
        const sevenDaysLater = new Date(now.getTime() + 7 * 86400000)
          .toISOString()
          .split('T')[0] as string;

        let sql =
          'SELECT task_key, title, priority, status_id, project_id, due_date, completed_at FROM tasks WHERE workspace_id = ?';
        const binds: unknown[] = [ws];
        const scopeProjectIds = asStringArray(cfg.scope_project_ids) || [];

        if (cfg.scope === 'assigned_to_me') {
          sql += ' AND assignee_id = ?';
          binds.push(userId);
        } else if (cfg.scope === 'specific_projects' && scopeProjectIds.length > 0) {
          sql += ` AND project_id IN (${scopeProjectIds.map(() => '?').join(',')})`;
          binds.push(...scopeProjectIds);
        } else if (cfg.scope === 'my_projects') {
          // Tasks where user is assignee OR reviewer (parity with the old fn)
          sql += ' AND (assignee_id = ? OR reviewer_id = ?)';
          binds.push(userId, userId);
        }

        const allTasks = await queryTaskRows(env, sql, binds);

        // Categorize
        const completed: TaskRow[] = [];
        const inProgress: TaskRow[] = [];
        const overdue: TaskRow[] = [];
        const upcoming: TaskRow[] = [];

        for (const t of allTasks) {
          const isDone = t.status_id !== null && doneStatusIds.includes(t.status_id);
          if (isDone) {
            // Check if completed recently (daily: today, weekly: this week)
            if (t.completed_at) {
              const completedDate = t.completed_at.split('T')[0] as string;
              if (cfg.report_type === 'daily' && completedDate === today) {
                completed.push(t);
              } else if (cfg.report_type === 'weekly') {
                const weekAgo = new Date(now.getTime() - 7 * 86400000)
                  .toISOString()
                  .split('T')[0] as string;
                if (completedDate >= weekAgo) completed.push(t);
              }
            }
            continue;
          }

          inProgress.push(t);

          if (t.due_date) {
            if (t.due_date < today) {
              overdue.push(t);
            } else {
              const limit = cfg.report_type === 'daily' ? threeDaysLater : sevenDaysLater;
              if (t.due_date <= limit) {
                upcoming.push(t);
              }
            }
          }
        }

        const reportData: ReportData = {
          completed: enrichTasks(completed, statusMap, projectMap),
          inProgress: enrichTasks(inProgress, statusMap, projectMap),
          overdue: enrichTasks(overdue, statusMap, projectMap),
          upcoming: enrichTasks(upcoming, statusMap, projectMap),
          allTasks: enrichTasks(allTasks, statusMap, projectMap),
        };

        // Build report text
        let reportText: string;
        if (cfg.template_key === 'custom' && typeof cfg.custom_template === 'string' && cfg.custom_template) {
          reportText = applyCustomTemplate(cfg.custom_template, reportData);
        } else if (cfg.report_type === 'weekly') {
          reportText = buildDefaultWeeklyReport(env, member.name, reportData);
        } else {
          reportText = buildDefaultDailyReport(env, member.name, reportData);
        }

        const blocks: SlackBlock[] = [
          { type: 'section', text: { type: 'mrkdwn', text: reportText } },
          { type: 'divider' },
        ];
        const summaryText = `${member.name} 的${cfg.report_type === 'daily' ? '日報' : '週報'}`;

        // Send
        if (cfg.send_target === 'channel' && typeof cfg.send_channel === 'string' && cfg.send_channel) {
          await digestSendChannel(sc, cfg.send_channel, summaryText, blocks);
        } else {
          const slackUserId = await findSlackUserId(sc, member.email, member.name);
          if (slackUserId) {
            await digestSendDm(sc, slackUserId, summaryText, blocks);
          }
        }

        // (id is globally unique; ws predicate is hygiene)
        await env.DB.prepare('UPDATE user_report_configs SET last_sent_at = ? WHERE id = ? AND workspace_id = ?')
          .bind(now.toISOString(), String(cfg.id ?? ''), ws)
          .run();
        sentCount++;
      }
    }

    console.log(`[slack] digest done: sent=${sentCount} time=${now.toISOString()}`);
  } catch (err) {
    console.error('[slack] digest error:', err);
  }
}

// ─── Customer self-bind Slack config (admin-gated; token write-only) ────────
//
// Lets a self-host customer connect their OWN Slack workspace from the app UI
// (系統管理 → 通知) instead of editing env. The bot token is stored in the
// server-only slack_config table and NEVER returned to the client.

/** GET /api/functions/slack-config — masked status only (member JWT). */
export async function handleSlackConfigStatus(c: Context<AppContext>): Promise<Response> {
  const env = c.env;
  const ws = c.get('auth').member.workspaceId;
  // The instance-level env token only ever applies to workspace 'default'
  // (mirrors resolveSlackToken) — never report it as configured to a tenant.
  const envConfigured = ws === DEFAULT_WORKSPACE && !!env.SLACK_BOT_TOKEN;
  try {
    const row = await env.DB.prepare(
      'SELECT team_name, configured_at FROM slack_config WHERE id = ? AND bot_token IS NOT NULL LIMIT 1'
    )
      .bind(ws)
      .first<{ team_name: string | null; configured_at: string | null }>();
    if (row) {
      return c.json({ configured: true, source: 'app', team: row.team_name, configuredAt: row.configured_at });
    }
    // No app-bound token — report whether an instance-level env token exists.
    return c.json({ configured: envConfigured, source: envConfigured ? 'env' : null, team: null });
  } catch {
    return c.json({ configured: envConfigured, source: envConfigured ? 'env' : null, team: null });
  }
}

/**
 * POST /api/functions/slack-config — set/clear the customer's bot token
 * (member JWT + demoGuard). Body {token}. Empty token disconnects. A non-empty
 * token is validated via auth.test before it is stored; the resolved team name
 * is saved for display. Never echoes the token back.
 */
export async function handleSlackConfigSet(c: Context<AppContext>): Promise<Response> {
  const env = c.env;
  const auth = c.get('auth');
  const ws = auth.member.workspaceId;
  try {
    const body = (await c.req.json().catch(() => ({}))) as { token?: unknown };
    const token = (body.token ?? '').toString().trim();

    if (!token) {
      // Disconnect: clear the stored token.
      await env.DB.prepare(
        `INSERT INTO slack_config (id, bot_token, team_name, configured_at, configured_by)
         VALUES (?, NULL, NULL, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET bot_token = NULL, team_name = NULL, configured_at = NULL, configured_by = NULL`
      )
        .bind(ws)
        .run();
      return c.json({ ok: true, configured: false });
    }

    if (!token.startsWith('xoxb-')) {
      return c.json({ ok: false, error: 'invalid_token', message: 'Bot Token 應以 xoxb- 開頭' }, 400);
    }

    // Validate against Slack before persisting.
    const test = (await slackGet({ token, usersCache: null }, 'auth.test')) as SlackApiResponse & {
      team?: string;
    };
    if (!test.ok) {
      return c.json(
        { ok: false, error: 'auth_failed', message: `Slack 驗證失敗：${test.error ?? 'unknown'}（請確認 token 正確且未被撤銷）` },
        400
      );
    }

    const teamName = test.team ?? '';
    await env.DB.prepare(
      `INSERT INTO slack_config (id, bot_token, team_name, configured_at, configured_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET bot_token = excluded.bot_token, team_name = excluded.team_name,
         configured_at = excluded.configured_at, configured_by = excluded.configured_by`
    )
      .bind(ws, token, teamName, new Date().toISOString(), auth?.member?.id ?? null)
      .run();

    return c.json({ ok: true, configured: true, team: teamName });
  } catch (e) {
    console.error('[slack-config] error:', e);
    return c.json({ ok: false, error: 'server_error', message: String(e) }, 500);
  }
}
