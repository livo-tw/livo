/** Presentation only: immutable event snapshots and command receipts stay unchanged. */
export const QA_NOTIFICATION_FIELDS = ['projectId', 'assigneeId', 'qaOwnerId', 'severity', 'priority', 'dueDate'] as const;
export type QaNotificationField = typeof QA_NOTIFICATION_FIELDS[number];
export interface QaFieldChange { field: QaNotificationField; before: unknown; after: unknown; hasBefore: boolean }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function snapshot(detail: unknown): Record<string, unknown> | null {
  if (typeof detail !== 'string' || detail.length > 16000) return null;
  try { const value: unknown = JSON.parse(detail); return object(value) ? value : null; } catch { return null; }
}
/** Known fields only; malformed/unknown structures never become visible JSON. */
export function qaFieldChanges(detail: unknown): QaFieldChange[] | null {
  const value = snapshot(detail);
  if (!value || !object(value.after) || (own(value, 'before') && !object(value.before))) return null;
  const after = value.after, before = object(value.before) ? value.before : null;
  return QA_NOTIFICATION_FIELDS.filter(field => own(after, field) && (!before || before[field] !== after[field]))
    .map(field => ({ field, before: before?.[field], after: after[field], hasBefore: !!before }));
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
/** Bounded label lookups only. These ids must never affect routing or authorization. */
export function qaNotificationReferences(eventType: unknown, detail: unknown): { members: string[]; projects: string[] } {
  const changes = eventType === 'update_fields' ? qaFieldChanges(detail) : eventType === 'triage' ? qaFieldChanges(triageSnapshot(detail)) : null;
  const references = (fields: readonly QaNotificationField[]) => [...new Set((changes || []).filter(change => fields.includes(change.field))
    .flatMap(change => [change.before, change.after]).filter(id))];
  return { members: references(['assigneeId', 'qaOwnerId']), projects: references(['projectId']) };
}
const copy = {
  'zh-TW': { priorities: ['最高', '高', '中', '低', '最低'], severities: { untriaged: '待判定', low: '低', medium: '中', high: '高' },
    fields: { projectId: '專案', assigneeId: '修復負責人', qaOwnerId: '驗證 QA', severity: '嚴重程度', priority: '優先級', dueDate: '期限' },
    unassigned: '未指定', unset: '未設定', unknownMember: '未知成員', unknownProject: '未知專案', updated: 'Bug 欄位已更新，請在 LIVO 查看詳情。', unchanged: '欄位未變更' },
  'zh-CN': { priorities: ['最高', '高', '中', '低', '最低'], severities: { untriaged: '待判定', low: '低', medium: '中', high: '高' },
    fields: { projectId: '项目', assigneeId: '修复负责人', qaOwnerId: '验证 QA', severity: '严重程度', priority: '优先级', dueDate: '截止日期' },
    unassigned: '未指定', unset: '未设置', unknownMember: '未知成员', unknownProject: '未知项目', updated: 'Bug 字段已更新，请在 LIVO 查看详情。', unchanged: '字段未变更' },
  en: { priorities: ['Highest', 'High', 'Medium', 'Low', 'Lowest'], severities: { untriaged: 'Untriaged', low: 'Low', medium: 'Medium', high: 'High' },
    fields: { projectId: 'Project', assigneeId: 'Developer', qaOwnerId: 'Verification owner', severity: 'Severity', priority: 'Priority', dueDate: 'Due date' },
    unassigned: 'Unassigned', unset: 'Not set', unknownMember: 'Unknown member', unknownProject: 'Unknown project', updated: 'Bug fields were updated. Open LIVO for details.', unchanged: 'No fields changed' },
};
const words = (locale?: string) => /^zh[-_](?:CN|SG|Hans)/i.test(locale || '') ? copy['zh-CN'] : /^zh/i.test(locale || '') || !locale ? copy['zh-TW'] : copy.en;
/** Stored QA priority is 1 (highest) through 5 (lowest), matching task cards. */
export function qaPriorityText(priority: unknown, locale?: string): string {
  const number = typeof priority === 'number' ? priority : typeof priority === 'string' && /^[1-5]$/.test(priority) ? Number(priority) : NaN;
  return Number.isInteger(number) && number >= 1 && number <= 5 ? words(locale).priorities[number - 1] : words(locale).unset;
}
export function qaSeverityText(severity: unknown, locale?: string): string {
  const c = words(locale);
  return typeof severity === 'string' && own(c.severities, severity) ? c.severities[severity as keyof typeof c.severities] : c.unset;
}
export function qaDueDateText(value: unknown, locale?: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return words(locale).unset;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : words(locale).unset;
}
export interface QaNotificationTextContext {
  memberName: (id: string) => string | undefined;
  projectName: (id: string) => string | undefined;
  locale?: string;
}
export function qaFieldNotificationText(detail: unknown, ctx: QaNotificationTextContext): string {
  const changes = qaFieldChanges(detail), c = words(ctx.locale);
  if (changes === null) return c.updated;
  const name = (input: unknown, lookup: (id: string) => string | undefined, missing: string, unknown: string) => {
    if (input === null || input === undefined || input === '') return missing;
    if (!id(input)) return unknown;
    const label = lookup(input);
    return typeof label === 'string' && label.trim() && label !== input ? label.replace(/\s+/g, ' ').trim().slice(0, 100) : unknown;
  };
  const display = (field: QaNotificationField, input: unknown) => {
    if (field === 'projectId') return name(input, ctx.projectName, c.unset, c.unknownProject);
    if (field === 'assigneeId' || field === 'qaOwnerId') return name(input, ctx.memberName, c.unassigned, c.unknownMember);
    if (field === 'severity') return qaSeverityText(input, ctx.locale);
    if (field === 'priority') return qaPriorityText(input, ctx.locale);
    return qaDueDateText(input, ctx.locale);
  };
  return changes.map(change => `${c.fields[change.field]}：${change.hasBefore ? display(change.field, change.before) + ' → ' : ''}${display(change.field, change.after)}`).join('\n') || c.unchanged;
}

function triageSnapshot(detail: unknown): string | null {
  if (typeof detail !== 'string' || detail.length > 16000) return null;
  const match = /^RD: (\S+) · QA: (\S+)\n(\w+) · P([1-5])(?:\n(\S+))?$/.exec(detail);
  return match ? JSON.stringify({ after: { assigneeId: match[1], qaOwnerId: match[2], severity: match[3], priority: Number(match[4]), dueDate: match[5] || null } }) : null;
}
/** Shared by channel notices and DMs; raw structured audit data is never rendered. */
export function qaNotificationDetailText(eventType: unknown, detail: unknown, ctx: QaNotificationTextContext): string | undefined {
  if (eventType === 'update_fields') return qaFieldNotificationText(detail, ctx);
  if (eventType === 'triage') return qaFieldNotificationText(triageSnapshot(detail), ctx);
  return undefined;
}
