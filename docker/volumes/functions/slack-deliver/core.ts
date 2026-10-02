export type Row = Record<string, any>;
export interface Job extends Row {
  id: number; team_id: string; task_id: string; target_type: 'channel' | 'member';
  target_id: string; payload: Row; attempts: number;
}
export interface DeliveryStore {
  config(): Promise<Row | undefined>;
  claim(owner: string): Promise<Job | undefined>;
  finish(job: Job, owner: string, result: Row): Promise<boolean>;
  token(): Promise<string | undefined>;
  project(taskId: string): Promise<Row | undefined>;
  binding(memberId: string, teamId: string): Promise<string | undefined>;
  thread(taskId: string, teamId: string, channelId: string): Promise<string | undefined>;
  currentTask(taskId: string): Promise<Row | undefined>;
  queueWeekly(): Promise<number>;
  weeklyTasks(memberId: string, weekStart: string): Promise<Row[]>;
  canSend(job: Job, owner: string): Promise<boolean>;
}
export class DeliveryError extends Error {
  constructor(public code: string, public retryable = false, public uncertain = false, public retryAfter = 0) { super(code); }
}
export const escapeSlack = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function plainText(value: unknown): string {
  return String(value ?? '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|li)>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
}
const priorities: Record<string, string> = { highest: '最高', high: '高', medium: '中', low: '低', lowest: '最低', urgent: '最高', none: '未設定' };
export const THREAD_WINDOW_MS = 60 * 60 * 1000;
/** A fixed window from the Slack root timestamp; replies never renew it. */
export function activeThread(ts: string | undefined, now = Date.now()): string | undefined {
  if (!ts || !/^\d+\.\d+$/.test(ts)) return undefined;
  const age = now - Number(ts) * 1000;
  return age >= 0 && age < THREAD_WINDOW_MS ? ts : undefined;
}
export function memberAllowed(config: Row | undefined, memberId: string): boolean {
  return config?.enabled === true && config.dmEnabled === true &&
    (!Object.prototype.hasOwnProperty.call(config, 'dmMemberIds') ||
      (Array.isArray(config.dmMemberIds) && config.dmMemberIds.includes(memberId)));
}
const reasonText: Record<string, string> = {
  assigned: '任務已指派給你', reviewer_assigned: '你已被指定為驗收人',
  status_changed: '你負責的任務狀態已變更', due_soon: '你負責的任務即將到期',
  mention: '有人在任務中提及你', comment: '你參與的任務有新留言',
};
/** Recheck responsibilities after queueing; a delayed send must not alert a former owner. */
export function currentPersonalPayload(job: Job, task: Row | undefined): Row | undefined {
  if (!task) return undefined;
  const rules = job.payload.recipientRules;
  if (!Array.isArray(rules)) {
    if (job.payload.reason === 'due_soon' && (task.assignee_id !== job.target_id || task.completed_at ||
      task.statuses?.is_done || task.due_date !== job.payload.dueDate)) return undefined;
    if (job.payload.reason === 'comment' && task.assignee_id !== job.target_id && task.reviewer_id !== job.target_id) return undefined;
    return job.payload;
  }
  const current = rules.filter((r: Row) => ['assignee', 'reviewer'].includes(r.role) &&
    task[`${r.role}_id`] === job.target_id && (!r.statusId || r.statusId === task.status_id));
  return current.length ? { ...job.payload, recipientRules: current } : undefined;
}
export function notificationMessage(payload: Row, appBase: string) {
  const base = new URL(appBase);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new DeliveryError('invalid_app_url');
  const url = `${base.origin}${base.pathname.replace(/\/$/, '')}/?task=${encodeURIComponent(payload.taskKey)}`;
  const safe = (v: unknown, limit = 240) => escapeSlack(String(v ?? '').slice(0, limit));
  const lines = [payload.kind === 'created' ? '🆕 新任務建立' : payload.kind === 'comment' ? '💬 新評論'
    : payload.kind === 'personal' ? `[個人通知] ${payload.eventKind === 'created' ? '🆕 新任務建立' : payload.eventKind === 'updated' ? '🔄 任務更新' : '🔔 任務提醒'}` : '🔄 任務更新',
    `<${url}|${safe(payload.taskKey)} - ${safe(payload.taskTitle)}>`];
  if (payload.kind === 'created') {
    const details = [payload.assigneeName && `👤 ${safe(payload.assigneeName)}`,
      payload.priority && `🎯 ${safe(priorities[payload.priority] || payload.priority)}`,
      payload.dueDate && `📅 ${safe(payload.dueDate)}`].filter(Boolean);
    if (details.length) lines.push(details.join(' | '));
    lines.push(`✏️ 建立者: ${safe(payload.actorName)}`);
  }
  if (payload.kind === 'updated' || (payload.kind === 'personal' && payload.changes?.length)) {
    const changes = (payload.changes || []).slice(0, 8).map((c: Row) => {
      const value = (v: unknown) => c.field === 'priority' ? priorities[String(v)] || v || '未設定' : v || '未設定';
      return `${safe(c.label)}：${safe(value(c.before), 160)} → ${safe(value(c.after), 160)}`;
    });
    lines.push(`📋 變更內容: ${changes.join('\n• ')}`, `✏️ 操作者: ${safe(payload.actorName)}`);
  } else if (payload.kind === 'comment') {
    lines.push(`👤 ${payload.kind === 'comment' ? '評論者' : '操作者'}: ${safe(payload.actorName)}`,
      `🗨️ ${payload.kind === 'comment' ? '評論內容' : '提醒內容'}: ${safe(plainText(payload.content), 700)}`);
  }
  if (payload.kind === 'personal') {
    const reasons = Array.isArray(payload.recipientRules) ? payload.recipientRules.map((r: Row) =>
      r.code === 'handoff' ? `任務進入「${r.statusName}」，請你${r.role === 'reviewer' ? '驗收' : '接手處理'}` : reasonText[r.code])
      : [reasonText[payload.reason] || '你有一則任務通知'];
    lines.splice(2, 0, `📍 原因: ${[...new Set(reasons.filter(Boolean))].map(r => safe(r)).join('；')}`);
    if (!payload.changes?.length) lines.push(`✏️ 操作者: ${safe(payload.actorName)}`);
    if (payload.content) lines.push(`🗨️ 內容: ${safe(plainText(payload.content), 700)}`);
    const details = [payload.priority && `🎯 ${safe(priorities[payload.priority] || payload.priority)}`,
      payload.dueDate && `📅 ${safe(payload.dueDate)}`].filter(Boolean);
    if (details.length) lines.push(details.join(' | '));
  }
  lines.push(`📂 項目: ${safe(payload.projectName || payload.projectKey)}`);
  const text = lines.join('\n').slice(0, 2900);
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '開啟 LIVO 卡片' }, url },
      ...(payload.taskKey ? [{ type: 'button', action_id: 'livo_task_open', text: { type: 'plain_text', text: '處理任務' },
        value: JSON.stringify({ key: payload.taskKey }) }] : [])] }],
    unfurl_links: false, unfurl_media: false };
}
export function matchingChannels(config: Row | undefined, project: Row | undefined): string[] {
  if (!project || project.is_archived) return [];
  const routes = Array.isArray(config?.routes) ? config.routes : [];
  return [...new Set<string>(routes.filter((r: Row) => r.enabled !== false && /^[CG][A-Z0-9]+$/.test(r.channelId || '') &&
    ((r.projectId && r.projectId === project.id) || (r.lineId && r.lineId === project.line_id)))
    .map((r: Row) => r.channelId))];
}
export function routeAllowed(config: Row | undefined, project: Row | undefined, job: Job): boolean {
  if (config?.enabled !== true || config.teamId !== job.team_id) return false;
  const channels = matchingChannels(config, project);
  if (job.target_type === 'member') return memberAllowed(config, job.target_id) && channels.length > 0;
  return job.target_id !== job.payload.sourceChannelId && channels.includes(job.target_id);
}
/** Check every cursor, not just the first page; never guess on an incomplete read. */
export async function isChannelMember(slack: (method: string, args: Row) => Promise<Row>, channel: string, user: string): Promise<boolean> {
  let cursor = '';
  const cursors = new Set<string>(), deadline = Date.now() + 45000;
  do {
    if (cursors.has(cursor) || Date.now() >= deadline) throw new DeliveryError('membership_check_incomplete', true);
    cursors.add(cursor);
    const page = await slack('conversations.members', { channel, limit: '200', ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.members)) throw new DeliveryError('invalid_membership_response', true);
    if (page.members.includes(user)) return true;
    cursor = String(page.response_metadata?.next_cursor || '').trim();
  } while (cursor);
  return false;
}
export function failureResult(error: unknown, attempts: number): Row {
  const e = error instanceof DeliveryError ? error : new DeliveryError('delivery_result_unknown', false, true);
  return { status: e.uncertain ? 'review' : e.retryable && attempts < 8 ? 'pending' : 'failed', error: e.code,
    delay: Math.max(e.retryAfter, Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600)) };
}
export function slackTransport(token: string, fetcher: typeof fetch = fetch) {
  return async (method: string, args: Row): Promise<Row> => {
    const sending = method === 'chat.postMessage';
    const read = ['users.info', 'conversations.members'].includes(method);
    let res: Response;
    try {
      res = await fetcher(`https://slack.com/api/${method}${read ? '?' + new URLSearchParams(args) : ''}`, { method: read ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        ...(read ? {} : { body: JSON.stringify(args) }), signal: AbortSignal.timeout(12000) });
    } catch { throw new DeliveryError('slack_transport_error', !sending, sending); }
    if (res.status === 429) throw new DeliveryError('ratelimited', true, false, Math.max(1, Number(res.headers.get('retry-after')) || 60));
    let body: Row;
    try { body = await res.json(); } catch { throw new DeliveryError('invalid_slack_response', !sending, sending); }
    if (!res.ok || !body.ok) {
      const code = typeof body.error === 'string' && /^[a-z_]+$/.test(body.error) ? body.error : 'slack_error';
      if (['ratelimited', 'rate_limited'].includes(code)) throw new DeliveryError(code, true);
      const transient = ['internal_error', 'fatal_error', 'service_unavailable', 'fetch_members_failed', 'request_timeout'].includes(code);
      const uncertain = sending && (res.status >= 500 || transient);
      throw new DeliveryError(code, !sending && (res.status >= 500 || transient), uncertain);
    }
    return body;
  };
}

export function weeklyMessage(tasks: Row[], weekStart: string, appBase: string) {
  const base = new URL(appBase);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new DeliveryError('invalid_app_url');
  const home = `${base.origin}${base.pathname.replace(/\/$/, '')}/`;
  const overdue = tasks.filter(t => t.dueDate < weekStart), due = tasks.filter(t => t.dueDate >= weekStart);
  const blocks: Row[] = [{ type: 'section', text: { type: 'mrkdwn', text:
    `[個人通知] 📅 每週任務彙整\n${escapeSlack(weekStart)} 當週｜逾期 ${overdue.length} 張、當週到期 ${due.length} 張` } }];
  let shown = 0;
  for (const [label, rows] of [['逾期任務', overdue], ['當週到期', due]] as const) {
    let section = `*${label}*`;
    for (const task of rows) {
      const line = `\n• <${home}?task=${encodeURIComponent(task.taskKey)}|${escapeSlack(task.taskKey)} - ${escapeSlack(String(task.taskTitle).slice(0, 140))}>\n  📅 ${escapeSlack(task.dueDate)}｜${task.role === 'reviewer' ? '驗收人' : '指派人'}｜${escapeSlack(String(task.projectName).slice(0, 100))}`;
      if (section.length + line.length > 2800) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: section } }); section = `*${label}（續）*`;
      }
      if (blocks.length >= 47) break;
      section += line; shown++;
    }
    if (rows.length && blocks.length < 48) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: section } });
  }
  if (shown < tasks.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `另有 ${tasks.length - shown} 張，請開啟 LIVO 查看。` }] });
  blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '開啟 LIVO' }, url: home }] });
  return { text: `[個人通知] 每週任務彙整：逾期 ${overdue.length} 張、當週到期 ${due.length} 張`, blocks, unfurl_links: false, unfurl_media: false };
}

export async function deliverJob(job: Job, owner: string, store: DeliveryStore, appBase: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<string> {
  let result: Row;
  try {
    const config = await store.config();
    const weekly = job.payload.kind === 'weekly';
    const project = weekly ? undefined : await store.project(job.task_id);
    const weekTime = Date.parse(`${job.payload.weekStart}T00:00:00+08:00`);
    const allowed = weekly ? job.target_type === 'member' && config?.teamId === job.team_id && memberAllowed(config, job.target_id) &&
      config?.weekly?.enabled === true && Number.isFinite(weekTime) && now >= weekTime && now < weekTime + 7 * 86400000
      : routeAllowed(config, project, job);
    const payload = allowed && !weekly && job.target_type === 'member'
      ? currentPersonalPayload(job, await store.currentTask(job.task_id)) : job.payload;
    let tasks = allowed && weekly ? await store.weeklyTasks(job.target_id, job.payload.weekStart) : [];
    if (!allowed) result = { status: 'skipped', error: 'route_no_longer_allowed' };
    else if (!payload || (weekly && !tasks.length)) result = { status: 'skipped', error: 'recipient_no_longer_responsible' };
    else {
      const token = await store.token();
      if (!token) throw new DeliveryError('slack_not_configured');
      const slack = slackTransport(token, fetcher);
      const auth = await slack('auth.test', {});
      if (auth.team_id !== job.team_id) throw new DeliveryError('slack_workspace_mismatch');
      let channel = job.target_id;
      if (job.target_type === 'member') {
        const user = await store.binding(job.target_id, job.team_id);
        if (!user) throw new DeliveryError('recipient_not_verified');
        const info = (await slack('users.info', { user })).user;
        if (!info || info.deleted || info.is_bot || info.team_id !== job.team_id) throw new DeliveryError('recipient_unavailable');
        const membership = new Map<string, boolean>();
        const visible = async (p: Row | undefined) => {
          for (const id of matchingChannels(config, p)) {
            if (!membership.has(id)) membership.set(id, await isChannelMember(slack, id, user));
            if (membership.get(id)) return true;
          }
          return false;
        };
        if (weekly) {
          const visibleTasks: Row[] = [];
          for (const task of tasks) if (await visible({ id: task.projectId, line_id: task.lineId })) visibleTasks.push(task);
          tasks = visibleTasks;
        }
        if (weekly ? !tasks.length : !(await visible(project))) throw new DeliveryError('recipient_not_in_subscribed_channel');
        channel = (await slack('conversations.open', { users: user })).channel?.id;
        if (!channel) throw new DeliveryError('dm_channel_unavailable');
      }
      const thread = job.target_type === 'channel' ? activeThread(await store.thread(job.task_id, job.team_id, channel), now) : undefined;
      const message = weekly ? weeklyMessage(tasks, job.payload.weekStart, appBase) : notificationMessage(payload, appBase);
      if (!(await store.canSend(job, owner))) throw new DeliveryError('delivery_lease_lost', false, true);
      const sent = await slack('chat.postMessage', { channel, ...message, ...(thread ? { thread_ts: thread } : {}) });
      if (!/^\d+\.\d+$/.test(sent.ts || '')) throw new DeliveryError('missing_slack_receipt', false, true);
      result = { status: 'sent', channel, messageTs: sent.ts, threadTs: thread || sent.ts };
    }
  } catch (error) { result = failureResult(error, job.attempts); }
  // A database failure after posting must never be converted into a blind retry.
  // Keep the sending lease: expiry promotes it to review and blocks later replies.
  if (!(await store.finish(job, owner, result))) throw new DeliveryError('delivery_lease_lost', false, true);
  return result.status;
}
