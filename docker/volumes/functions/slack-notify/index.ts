// slack-notify — post task-event / report / approval notifications to Slack.
//
// SELF-HOST version: calls the Slack Web API DIRECTLY (Bearer bot token). The
// old Lovable connector gateway (LOVABLE_API_KEY / SLACK_API_KEY /
// X-Connection-Api-Key / connector-gateway.lovable.dev) is fully removed — it
// only worked inside Lovable and left this function throwing on a real
// self-host. The token is resolved from the server-only slack_config table
// (customer-bound, set from the app UI) or the SLACK_BOT_TOKEN env fallback.
//
// This file is intentionally self-contained (no ../_shared import), matching the
// other docker/volumes/functions. Mirrors worker/src/functions/slack.ts.
//
// Upstream bug FIXED (parity with the worker): the old handler silently no-op'd
// on type 'report' / 'approval_request' / 'approval_completed' (client sends
// prebuilt Block Kit blocks). This posts those to the configured channel.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

import { shouldPostChannel } from '../slack-interact/core.ts';
import { constantTimeSecret } from '../slack-interact/backend.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// App base URL (host root); overridable via APP_BASE_URL. The self-hosted app
// is served at the root of that host (the cloud worker uses /demo/).
const APP_URL = Deno.env.get('APP_BASE_URL') || 'https://livo-tw.com';

const SLACK_API = 'https://slack.com/api';

// ─── Slack bot token resolution (customer-bound wins, env fallback) ─────────
async function resolveSlackToken(supabase: any): Promise<string | undefined> {
  try {
    const { data } = await supabase
      .from('slack_config')
      .select('bot_token')
      .eq('id', 'singleton')
      .maybeSingle();
    if (data?.bot_token) return data.bot_token;
  } catch {
    // slack_config table may not exist on a pre-migration DB — fall through.
  }
  return Deno.env.get('SLACK_BOT_TOKEN') || undefined;
}

// ─── Slack Web API helpers ──────────────────────────────────────────────────
interface SlackCtx { token: string; usersCache: any[] | null; }

async function slackGet(sc: SlackCtx, method: string, params?: Record<string, string>): Promise<any> {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : '';
  const resp = await fetch(`${SLACK_API}/${method}${qs}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${sc.token}` },
  });
  return await resp.json();
}

async function slackPost(sc: SlackCtx, method: string, body: Record<string, unknown>): Promise<any> {
  const resp = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sc.token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  return await resp.json();
}

async function resolveChannelId(sc: SlackCtx, setting: string): Promise<string> {
  const name = setting.replace(/^#/, '');
  const data = await slackGet(sc, 'conversations.list', {
    limit: '200',
    exclude_archived: 'true',
    types: 'public_channel,private_channel',
  });
  if (data.ok && data.channels) {
    const found = data.channels.find((ch: any) => ch.name === name || ch.id === setting);
    if (found) return found.id;
  }
  return setting;
}

async function usersList(sc: SlackCtx): Promise<any[]> {
  if (sc.usersCache) return sc.usersCache;
  const all: any[] = [];
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

function findSlackUserByName(users: any[], name: string): any | undefined {
  const normalized = name.trim().toLowerCase();
  return users.find((u: any) => {
    if (u.deleted || u.is_bot) return false;
    const realName = (u.real_name || '').toLowerCase();
    const displayName = (u.profile?.display_name || '').toLowerCase();
    const profileRealName = (u.profile?.real_name || '').toLowerCase();
    return realName === normalized || displayName === normalized || profileRealName === normalized;
  });
}

async function findSlackUserId(sc: SlackCtx, email: string, name?: string): Promise<string | null> {
  if (email) {
    try {
      const data = await slackGet(sc, 'users.lookupByEmail', { email });
      if (data.ok && data.user) return data.user.id;
    } catch {
      // fall through to name matching
    }
  }
  if (name) {
    const users = await usersList(sc);
    const found = findSlackUserByName(users, name);
    if (found) return found.id;
  }
  return null;
}

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
  blocks: any[],
  username: string,
): Promise<any> {
  return slackPost(sc, 'chat.postMessage', {
    channel,
    text,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
    username,
  });
}

// ─── Payload + block builders ───────────────────────────────────────────────

interface NotifyPayload {
  type: string;
  eventType?: string;
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
  sourceChannelId?: string;
  dmTargets?: { email: string; name?: string; reason: string }[];
  blocks?: any[];
  reportContent?: string;
  reportTitle?: string;
  reportType?: string;
  channelTarget?: string;
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

const taskUrl = (taskKey: string): string =>
  `${APP_URL}/?task=${encodeURIComponent(taskKey)}`;

function buildBlocks(payload: NotifyPayload): any[] {
  const key = payload.taskKey || '';
  const taskLink = `<${taskUrl(key)}|${key} - ${payload.taskTitle || ''}>`;
  const project = payload.projectName || '—';
  const pEmoji = priorityEmoji[payload.priority || 'medium'] || '🟡';
  const { emoji, text: headerText } = typeLabel[payload.type] || { emoji: '📋', text: '任務通知' };

  const lines: string[] = [];
  lines.push(`${emoji} *${headerText}*`);
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

function buildDmBlocks(payload: NotifyPayload, reason: string): any[] {
  const key = payload.taskKey || '';
  const taskLink = `<${taskUrl(key)}|${key} - ${payload.taskTitle || ''}>`;
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
  sc: SlackCtx,
  email: string,
  reason: string,
  payload: NotifyPayload,
  memberName?: string,
): Promise<boolean> {
  try {
    const slackUserId = await findSlackUserId(sc, email, memberName);
    if (!slackUserId) {
      console.log(`[slack] DM: user not found for email=${email}, name=${memberName}`);
      return false;
    }
    const dmChannelId = await openDm(sc, slackUserId);
    if (!dmChannelId) return false;

    const blocks = buildDmBlocks(payload, reason);
    const msgData = await postMessage(
      sc,
      dmChannelId,
      `${reason}: ${payload.taskKey || ''} ${payload.taskTitle || ''}`,
      blocks,
      'LIVO',
    );
    return msgData.ok === true;
  } catch (err) {
    console.error('[slack] DM delivery failed');
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    if (req.method !== 'POST') return new Response(null, { status: 405 });
    const jwt = (req.headers.get('authorization') || '').replace(/^Bearer /i, '');
    if (!(await constantTimeSecret(jwt, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''))) {
      const { data: auth, error } = await supabase.auth.getUser(jwt);
      const { data: member } = auth?.user ? await supabase.from('members').select('id')
        .eq('auth_id', auth.user.id).eq('is_active', true).maybeSingle() : { data: null };
      if (error || !member) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: corsHeaders });
    }
    const { data: deliveryRow } = await supabase.from('system_settings').select('value').eq('key', 'slack_delivery').maybeSingle();
    const delivery = deliveryRow?.value;
    const token = await resolveSlackToken(supabase);
    if (!token) {
      return new Response(JSON.stringify({ error: 'slack_not_configured' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const payload: NotifyPayload = await req.json();
    // The database trigger already committed the durable event. Old UI and Slack
    // callers must not post it a second time or supply a different recipient.
    if (delivery?.enabled === true && TASK_EVENT_TYPES.includes(payload.type)) {
      return new Response(JSON.stringify({ accepted: true, managedBy: 'database' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (payload.type.startsWith('approval_') || payload.eventType?.startsWith('approval_')) {
      const { data: enabled, error } = await supabase.rpc('livo_approvals_enabled');
      if (error || enabled !== true) {
        return new Response(JSON.stringify({ skipped: 'approvals_disabled' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }
    const sc: SlackCtx = { token, usersCache: null };

    const { data: settings } = await supabase
      .from('backup_settings')
      .select('task_notify_channel, notify_channel, task_notify_types, dm_notify_enabled, dm_notify_start_hour, dm_notify_end_hour')
      .limit(1)
      .single();

    const s = settings as any;
    const taskNotifyChannel = s?.task_notify_channel || s?.notify_channel || '';
    const enabledTypes: string[] = s?.task_notify_types
      || ['task_created', 'status_changed', 'assignee_changed', 'comment_added'];

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    // ── type 'report' (upstream no-op bug FIXED) ──────────────────────────
    if (payload.type === 'report') {
      const target = payload.channelTarget || taskNotifyChannel;
      if (!target) return json({ error: 'no_channel_configured' });

      const title = payload.reportTitle || '報告';
      const blocks: any[] =
        Array.isArray(payload.blocks) && payload.blocks.length > 0
          ? payload.blocks
          : [
              { type: 'section', text: { type: 'mrkdwn', text: `📝 *${title}*\n\n${payload.reportContent || ''}` } },
              { type: 'divider' },
            ];

      const channelId = await resolveChannelId(sc, target);
      if (delivery?.enabled === true && !(Array.isArray(delivery.routes) && delivery.routes.some((r: any) => r.enabled !== false && r.channelId === channelId)))
        return json({ error: 'channel_not_allowed' }, 403);
      const res = await postMessage(sc, channelId, title, blocks, 'LIVO');
      if (!res.ok) {
        console.error('[slack] report post error:', res.error);
        return json({ error: res.error || 'slack_error' });
      }
      return json({ success: true });
    }

    // ── approval types (upstream no-op bug FIXED) ─────────────────────────
    if (payload.type === 'approval_request' || payload.type === 'approval_completed') {
      if (!taskNotifyChannel) return json({ error: 'no_channel_configured' });

      const blocks: any[] = Array.isArray(payload.blocks) ? payload.blocks : [];
      const fallbackText = `${payload.taskKey || ''} ${payload.taskTitle || ''}`.trim() || '簽核通知';

      const channelId = await resolveChannelId(sc, taskNotifyChannel);
      const res = await postMessage(sc, channelId, fallbackText, blocks, 'LIVO');
      if (!res.ok) {
        console.error('[slack] approval post error:', res.error);
        return json({ error: res.error || 'slack_error' });
      }
      return json({ success: true });
    }

    // ── the 5 task event types ────────────────────────────────────────────
    if (!TASK_EVENT_TYPES.includes(payload.type)) {
      return json({ error: `unknown notify type: ${payload.type}` });
    }

    // Channel notification if this type is enabled and a channel is set.
    if (taskNotifyChannel && enabledTypes.includes(payload.type)) {
      const channelId = await resolveChannelId(sc, taskNotifyChannel);
      if (shouldPostChannel(channelId, payload.sourceChannelId)) {
      const blocks = buildBlocks(payload);
      const fallbackText = `${payload.actorName ?? ''} - ${payload.taskKey || ''} ${payload.taskTitle || ''}`;
      const res = await postMessage(sc, channelId, fallbackText, blocks, 'LIVO');
      if (!res.ok) return json({ error: res.error || 'slack_error' }, 502);
      }
    }

    // DMs if targets specified and DM notifications are enabled.
    if (payload.dmTargets && payload.dmTargets.length > 0) {
      const dmEnabled = s?.dm_notify_enabled ?? true;
      if (dmEnabled) {
        const startHour = s?.dm_notify_start_hour ?? 0;
        const endHour = s?.dm_notify_end_hour ?? 24;
        const nowTW = new Date(Date.now() + 8 * 60 * 60 * 1000);
        const currentHour = nowTW.getUTCHours();
        const inWindow = startHour <= endHour
          ? (currentHour >= startHour && currentHour < endHour)
          : (currentHour >= startHour || currentHour < endHour);

        if (inWindow) {
          const results = await Promise.allSettled(
            payload.dmTargets.map((t) => sendTaskDm(sc, t.email, t.reason, payload, t.name)),
          );
          if (results.some(r => r.status === 'rejected' || r.value !== true)) return json({ error: 'dm_delivery_failed' }, 502);
        } else {
          console.log(`[slack] DM skipped: current hour ${currentHour} outside window ${startHour}-${endHour}`);
        }
      } else {
        console.log('[slack] DM skipped: dm_notify_enabled is false');
      }
    }

    return json({ success: true });
  } catch (err) {
    console.error('[slack] notify error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
