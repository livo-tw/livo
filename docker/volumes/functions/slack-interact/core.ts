import { groupProjectsByLine, slackProjectOptionGroups } from './projectGroups.ts';
// Portable interaction rules: no tokens, network calls or runtime globals.
export type Row = Record<string, any>;
export function requiresWebCreate(required: Row = {}): boolean {
  const supported = ['title', 'project', 'status', 'priority', 'dueDate', 'assignee', 'requirement'];
  return Object.entries(required).some(([key, value]) => value === true && !supported.includes(key));
}
export const DISABLED = 'LIVO 的 Slack 功能目前未啟用，請洽管理員';
export const NO_ACCOUNT = '找不到對應的 LIVO 帳號：請管理員確認你的 Slack Email 與 LIVO 相同，或在 LIVO 的 Slack 設定手動對應你的帳號';
export const UNAVAILABLE = '找不到卡片，或你沒有權限查看這張卡片';
const words: Record<string, [string, string]> = {
  '建立 LIVO 卡片': ['创建 LIVO 卡片', 'Create LIVO card'], '留言到 LIVO 卡片': ['留言到 LIVO 卡片', 'Comment on LIVO card'],
  '標題': ['标题', 'Title'], '專案': ['项目', 'Project'], '狀態': ['状态', 'Status'], '經辦人': ['经办人', 'Assignee'],
  '優先級': ['优先级', 'Priority'], '到期日': ['到期日', 'Due date'], '需求說明': ['需求说明', 'Description'],
  '卡片': ['卡片', 'Card'], '留言': ['留言', 'Comment'], '送出': ['提交', 'Submit'], '關閉': ['关闭', 'Close'],
  '未分類': ['未分类', 'Uncategorized'],
  '最高': ['最高', 'Highest'], '高': ['高', 'High'], '中': ['中', 'Medium'], '低': ['低', 'Low'], '最低': ['最低', 'Lowest'],
  '請填寫此欄位': ['请填写此字段', 'Complete this field'], '標題最多 200 字': ['标题最多 200 字', 'Use at most 200 characters'],
  '請選擇優先級': ['请选择优先级', 'Choose a priority'], '說明最多 3000 字': ['说明最多 3000 字', 'Use at most 3000 characters'],
  '日期格式不正確': ['日期格式不正确', 'Choose a valid date'], '請選擇卡片': ['请选择卡片', 'Choose a card'],
  '請輸入 1 至 3000 字的留言': ['请输入 1 至 3000 字的留言', 'Enter a comment of 1 to 3000 characters'],
};
export const localize = (text: string, locale = 'zh-TW') => words[text]?.[locale.startsWith('en') ? 1 : 0] &&
  (locale.startsWith('en') || locale === 'zh-CN') ? words[text][locale.startsWith('en') ? 1 : 0] : text;
export const enabled = (value: unknown) => !!value && typeof value === 'object' && (value as Row).slackActions === true;
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const decode = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export const option = (id: string, name: string) => ({ text: { type: 'plain_text', text: name.slice(0, 75) || id }, value: id });
export const taskOption = (task: Row) => option(task.id, `${task.task_key} · ${task.title}`);
export function projectOptionGroups(projects: Row[], lines: Row[], locale = 'zh-TW'): Row[] {
  const ordered = [...lines].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id));
  return slackProjectOptionGroups(groupProjectsByLine(
    ordered.map(line => ({ id: line.id, name: line.name })),
    projects.map(project => ({ id: project.id, name: project.name, lineId: project.line_id })),
  ), localize('未分類', locale));
}
export function taskReceipt(kind: string, task: Row, url: string): string {
  const label = `${task.task_key} - ${task.title}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '｜').replace(/[\r\n]+/g, ' ');
  return `已${kind === 'create' ? '建立卡片' : '新增留言'}：\n<${url}|${label}>`;
}
export function parseCommand(text: string) {
  const trimmed = text.trim();
  if (/^help(?:\s|$)/i.test(trimmed)) return { kind: 'help' as const };
  const comment = /^comment(?:\s+(\S+))?(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (comment) return { kind: 'comment' as const, key: (comment[1] || '').toUpperCase(), text: (comment[2] || '').trim() };
  if (!trimmed || /^new(?:\s|$)/i.test(trimmed)) return { kind: 'new' as const, text: decode(trimmed.replace(/^new\s*/i, '')) };
  return { kind: 'help' as const };
}
/**
 * Who may an admin assign a Slack account to? A super admin: any active member
 * who can log in. An admin: only plain members or themselves, so nobody can map
 * their own Slack account onto a higher role.
 */
export function canAssignSlackMember(caller: Row, target: Row | undefined): boolean {
  if (!target || target.is_active !== true || !target.auth_id) return false;
  if (caller.role === 'super_admin') return true;
  return caller.role === 'admin' && (target.role === 'member' || target.id === caller.id);
}
export const SLACK_USER_ID = /^[UW][A-Z0-9]{2,30}$/;
/**
 * Manual mapping is for a Slack account whose email matches nobody in LIVO.
 * If the Slack email already belongs to another LIVO member (active or not),
 * assigning that account elsewhere would let someone act as another person.
 */
export function slackEmailBelongsToOther(members: Row[], slackEmail: unknown, targetId: string): boolean {
  if (typeof slackEmail !== 'string' || !slackEmail.trim()) return false;
  const email = slackEmail.trim().toLowerCase();
  return members.some(m => m.email?.trim().toLowerCase() === email && m.id !== targetId);
}
export function matchEmail(members: Row[], email: string): Row | undefined {
  if (!email?.trim()) return;
  const matches = members.filter(m => m.email?.trim().toLowerCase() === email.trim().toLowerCase());
  return matches.length === 1 && matches[0].is_active === true ? matches[0] : undefined;
}
/** Only safe text and the editor's mention spans survive. */
export function convertMrkdwn(text: string, mentions: Record<string, { id?: string; name: string }> = {}) {
  const ids = new Set<string>(), tokens: string[] = [], plainTokens: string[] = [];
  let source = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  source = source.replace(/<@([A-Z0-9]+)>/g, (_, id: string) => {
    const member = mentions[id], label = member?.name || 'Slack user';
    const html = member?.id
      ? `<span data-type="mention" data-id="${escapeHtml(member.id)}" data-label="${escapeHtml(label)}">@${escapeHtml(label)}</span>`
      : escapeHtml(`@${label}`);
    if (member?.id) ids.add(member.id);
    const index = tokens.push(html) - 1; plainTokens.push(`@${label}`);
    return `\u0001${index}\u0002`;
  });
  source = source.replace(/<(https?:\/\/[^>|\s]+)(?:\|([^>]*))?>/g, (_, url: string, label?: string) => label ? `${label} (${url})` : url)
    .replace(/<#[^>|]+\|([^>]+)>/g, '#$1').replace(/<![^>]*>/g, '').replace(/<[^>]*>/g, '')
    .replace(/```/g, '').replace(/`([^`]+)`/g, '$1').replace(/([*_~])([^\n]+?)\1/g, '$2');
  source = decode(source);
  const plain = source.replace(/\u0001(\d+)\u0002/g, (_, i) => plainTokens[Number(i)]).trim();
  const html = '<p>' + escapeHtml(source).replace(/\u0001(\d+)\u0002/g, (_, i) => tokens[Number(i)])
    .replace(/\r?\n/g, '<br>').trim() + '</p>';
  return { plain, html, mentionedIds: [...ids] };
}
export function messageDraft(message: Row, permalink = '') {
  const text = String(message?.text || '');
  const suffix = permalink ? `\n\n${permalink}` : '';
  return { title: convertMrkdwn(text).plain.split(/\r?\n/)[0].slice(0, 200),
    description: text.slice(0, Math.max(0, 3000 - suffix.length)) + suffix };
}
const input = (id: string, label: string, element: Row, optional = false) => ({
  type: 'input', block_id: id, label: { type: 'plain_text', text: label }, element: { ...element, action_id: id }, optional,
});
const textInput = (value: string, max: number, multiline = false) => ({ type: 'plain_text_input', max_length: max, multiline,
  ...(value ? { initial_value: value.slice(0, max) } : {}) });
const external = (initial?: Row) => ({ type: 'external_select', min_query_length: 0, ...(initial ? { initial_option: initial } : {}) });
const modal = (callback: string, title: string, blocks: Row[], metadata: Row, submit = true) => ({
  type: 'modal', callback_id: callback, title: { type: 'plain_text', text: localize(title, metadata.locale) },
  ...(submit ? { submit: { type: 'plain_text', text: localize('送出', metadata.locale) } } : {}),
  close: { type: 'plain_text', text: localize('關閉', metadata.locale) }, private_metadata: JSON.stringify(metadata),
  blocks: blocks.map((block): Row => ({ ...block, ...(block.label ? { label: { ...block.label, text: localize(block.label.text, metadata.locale) } } : {}),
    ...(block.block_id === 'priority' ? { element: { ...block.element,
      initial_option: option('medium', localize('中', metadata.locale)), options: block.element.options.map((o: Row) => option(o.value, localize(o.text.text, metadata.locale))) } } : {}) })),
});
export const messageModal = (text: string, markdown = false) => modal('livo_result', 'LIVO',
  [{ type: 'section', text: { type: markdown ? 'mrkdwn' : 'plain_text', text } }], {}, false);
export function createModal(catalog: Row, actor: Row, draft: Row = {}, metadata: Row = {}) {
  return modal('livo_create_task', '建立 LIVO 卡片', [
    input('title', '標題', textInput(draft.title || '', 200)),
    input('project', '專案', external(catalog.projects[0] && option(catalog.projects[0].id, catalog.projects[0].name))),
    input('status', '狀態', external(catalog.statuses[0] && option(catalog.statuses[0].id, catalog.statuses[0].name))),
    input('assignee', '經辦人', external(option(actor.id, actor.name))),
    input('priority', '優先級', { type: 'static_select', initial_option: option('medium', '中'),
      options: [['highest', '最高'], ['high', '高'], ['medium', '中'], ['low', '低'], ['lowest', '最低']].map(([id, name]) => option(id, name)) }),
    input('due', '到期日', { type: 'datepicker' }, !catalog.required?.dueDate),
    input('description', '需求說明', textInput(draft.description || '', 3000, true), !catalog.required?.requirement),
  ], { ...metadata, locale: actor.locale || metadata.locale });
}
export function commentModal(task?: Row, text = '', metadata: Row = {}) {
  return modal('livo_comment_task', '留言到 LIVO 卡片', [input('task', '卡片', external(task && taskOption(task))),
    input('comment', '留言', textInput(text, 3000, true))], metadata);
}
export function parseSubmission(view: Row) {
  const values = view.state?.values || {};
  const value = (key: string): string => values[key]?.[key]?.value ?? values[key]?.[key]?.selected_option?.value ?? values[key]?.[key]?.selected_date ?? '';
  const errors: Record<string, string> = {};
  const kind = view.callback_id === 'livo_create_task' ? 'create' : 'comment';
  const fields: Row = kind === 'create'
    ? { title: value('title').trim(), project_id: value('project'), status_id: value('status'), assignee_id: value('assignee'),
      priority: value('priority'), due_date: value('due'), description: value('description') }
    : { task_id: value('task'), text: value('comment').trim() };
  if (kind === 'create') {
    for (const [block, field] of [['title', 'title'], ['project', 'project_id'], ['status', 'status_id'], ['assignee', 'assignee_id']]) {
      if (!fields[field]) errors[block] = '請填寫此欄位';
    }
    if (fields.title.length > 200) errors.title = '標題最多 200 字';
    if (!['highest', 'high', 'medium', 'low', 'lowest'].includes(fields.priority)) errors.priority = '請選擇優先級';
    if (fields.description.length > 3000) errors.description = '說明最多 3000 字';
    if (fields.due_date && (!/^\d{4}-\d{2}-\d{2}$/.test(fields.due_date) || !Number.isFinite(Date.parse(fields.due_date)) ||
      new Date(fields.due_date).toISOString().slice(0, 10) !== fields.due_date)) errors.due = '日期格式不正確';
  } else {
    if (!fields.task_id) errors.task = '請選擇卡片';
    if (!fields.text || fields.text.length > 3000) errors.comment = '請輸入 1 至 3000 字的留言';
  }
  return { kind, fields, errors };
}
export function commentRecipients(task: Row, actorId: string, mentionedIds: string[]) {
  const recipients = new Map<string, 'mention' | 'comment'>();
  for (const id of [task.assignee_id, task.reviewer_id]) if (id && id !== actorId) recipients.set(id, 'comment');
  for (const id of mentionedIds) if (id !== actorId) recipients.set(id, 'mention');
  return [...recipients].map(([id, type]) => ({ id, type }));
}
export const shouldPostChannel = (channel: string, source?: string) => !!channel && channel !== source;
