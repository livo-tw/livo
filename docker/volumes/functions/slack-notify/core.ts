/**
 * Slack task-event and report notifications (slack-notify on Docker, the cloud
 * worker's /api/functions/slack-notify and its digests). Shared verbatim with
 * both server adapters by scripts/sync-shared-code.mjs. Pure: no tokens,
 * network calls or runtime globals.
 *
 * Callers are ordinary members, so a request is never trusted for Slack
 * formatting, links or recipients:
 * - every value that reaches mrkdwn is escaped here, after any decoding, so a
 *   stored `&lt;!channel&gt;` or `<https://example.com|LIVO>` stays inert text;
 *   the only links are task URLs the server builds itself;
 * - blocks are always built here, never taken from the request;
 * - DM recipients come from the stored task (assignee, reviewer, the members
 *   the caller's comment mentions); a request can only narrow that set;
 * - a Slack account receives a DM only when its verified email matches the
 *   member's email and it is a full workspace member (no guests, bots or
 *   deactivated accounts). Display names are never used to find a person.
 */
export type NotifyRow = Record<string, unknown>;
export type NotifyBlock = Record<string, unknown>;

export const NOTIFY_TASK_TYPES = ['task_created', 'status_changed', 'assignee_changed', 'comment_added', 'priority_changed'];
export const NOTIFY_MAX_DM_TARGETS = 20;

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** Escape Slack mrkdwn control characters (&, <, >) after capping the length. */
export function mrkdwn(value: unknown, max = 200): string {
  const text = Array.from(String(value ?? '').replace(CONTROL, ' ')).slice(0, max).join('');
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** A single-line field: line breaks cannot fake extra notification lines. */
export const mrkdwnLine = (value: unknown, max = 80): string => mrkdwn(String(value ?? '').replace(/\s+/g, ' ').trim(), max);
/** Fit escaped text into a Slack text object without cutting an entity in half. */
export function fitText(text: string, max = 2900): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  const amp = cut.lastIndexOf('&');
  if (amp >= 0 && amp > cut.length - 5 && !cut.slice(amp).includes(';')) cut = cut.slice(0, amp);
  return `${cut}…`;
}

/** Comment HTML from the editor to plain preview text. */
export function commentPlainText(html: unknown): string {
  return String(html ?? '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|li)>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
}
/** Member ids from the editor's mention spans in a stored comment. */
export function commentMentionIds(html: unknown): string[] {
  const ids = new Set<string>();
  for (const match of String(html ?? '').matchAll(/data-id="([\w-]{1,200})"/g)) ids.add(match[1]);
  return [...ids].slice(0, 40);
}

export const DM_REASONS = {
  assignee: '你被指派為經辦人',
  reviewer: '你被指派為驗收人',
  mention: '你在留言中被提及',
  comment: '你的任務有新留言',
} as const;
export type DmReason = keyof typeof DM_REASONS;
const reasonEmoji: Record<DmReason, string> = { assignee: '🎯', reviewer: '✅', mention: '💬', comment: '💬' };

/**
 * Who may get a direct message for this event, from the task as stored: the
 * assignee and reviewer of an assignment change; on a new comment the members
 * it mentions, then the assignee and reviewer. Never the actor.
 */
export function dmRecipients(type: string, task: NotifyRow, actorId: string, mentionedIds: string[] = []): Map<string, DmReason> {
  const out = new Map<string, DmReason>();
  const add = (id: unknown, reason: DmReason) => {
    if (typeof id === 'string' && id && id !== actorId && !out.has(id)) out.set(id, reason);
  };
  if (type === 'assignee_changed') { add(task.assignee_id, 'assignee'); add(task.reviewer_id, 'reviewer'); }
  if (type === 'comment_added') {
    for (const id of mentionedIds) add(id, 'mention');
    add(task.assignee_id, 'comment'); add(task.reviewer_id, 'comment');
  }
  return out;
}
/** The emails a request asks to notify; only used to narrow dmRecipients(). */
export function requestedEmails(targets: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(targets)) return out;
  for (const target of targets.slice(0, NOTIFY_MAX_DM_TARGETS)) {
    const email = target && typeof target === 'object' ? (target as NotifyRow).email : undefined;
    if (typeof email === 'string' && email.trim() && email.length <= 254) out.add(email.trim().toLowerCase());
  }
  return out;
}
/** A Slack account may get a DM only if it is the member's own, full account. */
export function slackDmEligible(user: unknown, email: string): boolean {
  if (!user || typeof user !== 'object') return false;
  const u = user as NotifyRow & { profile?: NotifyRow };
  return typeof u.id === 'string' && /^[UW][A-Z0-9]+$/.test(u.id) && !u.deleted && !u.is_bot && !u.is_restricted && !u.is_ultra_restricted
    && typeof u.profile?.email === 'string' && u.profile.email.trim().toLowerCase() === email.trim().toLowerCase();
}
/** A channel the bot can list, or a public/private channel id; never a user or DM id. */
export function notifyChannelId(channels: unknown[], setting: unknown): string | undefined {
  if (typeof setting !== 'string' || !setting.trim() || setting.length > 100) return undefined;
  const value = setting.trim(), name = value.replace(/^#/, '');
  const found = channels.find((ch): ch is NotifyRow => !!ch && typeof ch === 'object' && ((ch as NotifyRow).id === value || (ch as NotifyRow).name === name));
  const id = found ? found.id : value;
  return typeof id === 'string' && /^[CG][A-Z0-9]{2,}$/.test(id) ? id : undefined;
}
/** Slack error codes are short identifiers; anything else becomes a generic code. */
export const slackErrorCode = (value: unknown): string => typeof value === 'string' && /^[a-z_]{1,60}$/.test(value) ? value : 'slack_error';

export interface NotifyFields {
  type: string; taskKey: string; taskTitle: string; projectName: string; actorName: string; priority: string;
  assigneeName?: string; statusName?: string; dueDate?: string; fromStatus?: string; toStatus?: string;
  oldAssignee?: string; newAssignee?: string; commentPreview?: string;
}
/** Free-text event details from a request: plain strings only. */
export function notifyDetails(payload: NotifyRow): Partial<NotifyFields> {
  const pick = (key: string) => typeof payload[key] === 'string' && (payload[key] as string).trim() ? payload[key] as string : undefined;
  return { assigneeName: pick('assigneeName'), statusName: pick('statusName'), dueDate: pick('dueDate'), fromStatus: pick('fromStatus'),
    toStatus: pick('toStatus'), oldAssignee: pick('oldAssignee'), newAssignee: pick('newAssignee'), commentPreview: pick('commentPreview') };
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
const emojiFor = (priority: unknown) => priorityEmoji[String(priority || 'medium')] || '🟡';
const link = (f: NotifyFields, url: string) => `<${url}|${mrkdwnLine(f.taskKey, 40)} - ${mrkdwnLine(f.taskTitle, 200)}>`;
const message = (lines: string[], fallback: string) => {
  const text = fitText(lines.join('\n'));
  return { text: fitText(fallback, 300), blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, { type: 'divider' }] as NotifyBlock[] };
};

/** Channel notice for a task event. `url` must be a task link built by the server. */
export function taskChannelMessage(f: NotifyFields, url: string): { text: string; blocks: NotifyBlock[] } {
  const { emoji, text: header } = typeLabel[f.type] || { emoji: '📋', text: '任務通知' };
  const field = (v: unknown) => mrkdwnLine(v, 80);
  const lines = [`${emoji} *${header}*`, link(f, url)];
  switch (f.type) {
    case 'task_created':
      lines.push(`🙋 建立者: ${field(f.actorName)}`);
      if (f.assigneeName) lines.push(`👤 經辦人: ${field(f.assigneeName)}`);
      if (f.statusName) lines.push(`📊 狀態: ${field(f.statusName)}`);
      lines.push(`${emojiFor(f.priority)} 優先級: ${field(f.priority || 'medium')}`);
      if (f.dueDate) lines.push(`📅 到期日: ${mrkdwnLine(f.dueDate, 20)}`);
      break;
    case 'status_changed':
      lines.push(`🙋 變更者: ${field(f.actorName)}`, `📊 狀態: ${field(f.fromStatus || '—')} → ${field(f.toStatus || '—')}`);
      if (f.assigneeName) lines.push(`👤 經辦人: ${field(f.assigneeName)}`);
      break;
    case 'assignee_changed':
      lines.push(`🙋 變更者: ${field(f.actorName)}`, `👤 指派: ${field(f.oldAssignee || '未指派')} → ${field(f.newAssignee || '未指派')}`);
      if (f.statusName) lines.push(`📊 狀態: ${field(f.statusName)}`);
      break;
    case 'priority_changed':
      lines.push(`🙋 變更者: ${field(f.actorName)}`,
        `${emojiFor(f.fromStatus)} ${field(f.fromStatus || '—')} → ${emojiFor(f.toStatus)} ${field(f.toStatus || '—')}`);
      if (f.assigneeName) lines.push(`👤 經辦人: ${field(f.assigneeName)}`);
      if (f.statusName) lines.push(`📊 狀態: ${field(f.statusName)}`);
      break;
    case 'comment_added':
      lines.push(`🙋 評論者: ${field(f.actorName)}`);
      if (f.commentPreview) lines.push('💭 評論內容:', mrkdwn(f.commentPreview, 500));
      if (f.assigneeName) lines.push(`👤 經辦人: ${field(f.assigneeName)}`);
      break;
  }
  lines.push(`📁 項目: ${field(f.projectName || '—')}`);
  return message(lines, `${mrkdwnLine(f.actorName)} - ${mrkdwnLine(f.taskKey, 40)} ${mrkdwnLine(f.taskTitle, 200)}`);
}

/** Personal notice for a task event, with a server-chosen reason. */
export function taskDmMessage(f: NotifyFields, reason: DmReason, url: string): { text: string; blocks: NotifyBlock[] } {
  const lines = [`${reasonEmoji[reason]} *${DM_REASONS[reason]}*`, link(f, url), `🙋 來自: ${mrkdwnLine(f.actorName)}`,
    `${emojiFor(f.priority)} 優先級: ${mrkdwnLine(f.priority || 'medium')}`];
  if (f.type === 'comment_added' && f.commentPreview) lines.push('💭 評論內容:', mrkdwn(f.commentPreview, 500));
  lines.push(`📁 項目: ${mrkdwnLine(f.projectName || '—')}`);
  return message(lines, `${DM_REASONS[reason]}: ${mrkdwnLine(f.taskKey, 40)} ${mrkdwnLine(f.taskTitle, 200)}`);
}

/** A report or notification-rule message: escaped text with its sender, never caller-built blocks. */
export function reportMessage(title: unknown, content: unknown, sender: unknown): { text: string; blocks: NotifyBlock[] } {
  const heading = mrkdwnLine(typeof title === 'string' && title.trim() ? title : '報告', 150);
  const body = fitText(`📝 *${heading}*\n\n${mrkdwn(content, 3000)}`);
  const by = String(sender ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'LIVO';
  return { text: heading, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: body } },
    { type: 'context', elements: [{ type: 'plain_text', text: `由 ${by} 透過 LIVO 傳送`, emoji: false }] }, { type: 'divider' }] };
}
