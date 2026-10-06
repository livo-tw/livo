import { planningButton } from './planning-ui.ts';
import { option, type Row } from './core.ts';
import { approvalText } from './approval-ui.ts';
import { workspaceText } from './workspace-i18n.ts';
import { knowledgeSearchLabel } from './knowledge.ts';

export const TASK_PAGE_SIZE = 8;
export type TaskQuery = { kind: 'my' | 'review' | 'today' | 'overdue' | 'due' | 'search'; text?: string; page: number };
export type TaskPage = { tasks: Row[]; hasMore: boolean; page: number };
export type CommentPage = { comments: Row[]; hasMore: boolean; page: number };
export type WorkspaceCommand = { kind: 'home' | 'search' } | { kind: 'query'; query: TaskQuery }
  | { kind: 'show' | 'edit'; key: string };
const FIELD_KEYS = ['status_id', 'assignee_id', 'reviewer_id', 'due_date', 'priority'] as const;
const PRIORITIES = [['highest', '最高'], ['high', '高'], ['medium', '中'], ['low', '低'], ['lowest', '最低']];
const tr = (source: Row, value: string, variables: Record<string, string | number> = {}) => workspaceText(value, source.locale, variables);
const clampPage = (page: unknown) => Number.isSafeInteger(page) && Number(page) >= 0 ? Math.min(Number(page), 10000) : 0;
const text = (value: unknown, max = 3000) => String(value ?? '').slice(0, max);
const decode = (value: string) => value.replace(/&(amp|lt|gt|quot|#39|nbsp);/g,
  (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[entity] || '');
const escape = (value: unknown, max = 1000) => text(value, max).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, max);
const plain = (value: unknown, max: number) => decode(text(value, 30000)
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  .replace(/<\/(?:p|div|li)>|<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')).trim().slice(0, max);
const section = (value: string): Row => ({ type: 'section', text: { type: 'mrkdwn', text: value || '—' } });
const context = (value: string): Row => ({ type: 'context', elements: [{ type: 'plain_text', text: text(value, 2000) || '—' }] });
const button = (action: string, label: string, value: Row): Row => ({ type: 'button', action_id: action,
  text: { type: 'plain_text', text: label.slice(0, 75) }, value: JSON.stringify(value) });
const actions = (elements: Row[]): Row => ({ type: 'actions', elements });
const sourceMetadata = (source: Row): Row => Object.fromEntries(['channel', 'thread', 'user', 'team', 'locale']
  .filter(key => source[key] !== undefined).map(key => [key, text(source[key], 150)]));
const modal = (callback: string, title: string, blocks: Row[], source: Row, data: Row = {}, submit?: string): Row => ({
  type: 'modal', callback_id: callback, title: { type: 'plain_text', text: title.slice(0, 24) },
  close: { type: 'plain_text', text: tr(source, '關閉') },
  ...(submit ? { submit: { type: 'plain_text', text: submit.slice(0, 24) } } : {}),
  private_metadata: JSON.stringify({ ...sourceMetadata(source), ...data }), blocks,
});
const validKey = (value: string) => /^[a-z][a-z0-9_]*-\d+$/i.test(value);

/** The legacy new/comment parser remains the fallback for unrecognised commands. */
export function parseWorkspaceCommand(value: string): WorkspaceCommand | undefined {
  const command = value.trim(), split = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command);
  if (!command || /^(home|dashboard)$/i.test(command)) return { kind: 'home' };
  const verb = split?.[1]?.toLowerCase(), argument = decode(split?.[2] || '').trim();
  if (['my', 'review', 'today', 'overdue', 'due'].includes(verb || '') && !argument)
    return { kind: 'query', query: { kind: verb as TaskQuery['kind'], page: 0 } };
  if (verb === 'search') return argument ? { kind: 'query', query: { kind: 'search', text: argument.slice(0, 100), page: 0 } } : { kind: 'search' };
  if ((verb === 'show' || verb === 'edit') && validKey(argument)) return { kind: verb, key: argument.toUpperCase() };
  if (validKey(command)) return { kind: 'show', key: command.toUpperCase() };
  return undefined;
}

export function homeModal(source: Row = {}, flags: { approvals?: boolean } = {}): Row {
  return modal('livo_workspace_home', 'LIVO', [
    section(tr(source, '*在 Slack 處理日常任務*\n查任務、搜尋卡片、修改狀態與人員、期限和優先級，或新增留言。')),
    actions([button('livo_workspace_query', tr(source, '我的任務'), { kind: 'my', page: 0 })]),
    actions([button('livo_workspace_query', tr(source, '待我驗收'), { kind: 'review', page: 0 })]),
    ...(flags.approvals === true ? [actions([button('livo_approvals_page', approvalText('title', source.locale), { cursor: 0 })])] : []),
    actions([button('livo_workspace_query', tr(source, '今天到期'), { kind: 'today', page: 0 })]),
    actions([button('livo_workspace_query', tr(source, '未來 7 天到期'), { kind: 'due', page: 0 })]),
    actions([button('livo_workspace_query', tr(source, '已逾期'), { kind: 'overdue', page: 0 })]),
    actions([button('livo_workspace_search', tr(source, '搜尋卡片'), {}),
      button('livo_workspace_new', tr(source, '建立卡片'), {})]),
    actions([button('livo_qa_workspace_list', tr(source, 'QA 清單'), {}),
      button('livo_qa_workspace_my', tr(source, '我的 QA'), {}),
      button('livo_qa_workspace_search', tr(source, '搜尋 Bug'), {})]),
    actions([button('livo_knowledge_search', tr(source, '搜尋文件'), {}),
      button('livo_kb_search', knowledgeSearchLabel(source.locale), {})]),
    context(tr(source, '查詢結果只有你看得到；可用範圍依你的 LIVO 帳號權限。到期清單包含你經辦或驗收的未完成任務，日期以台北時間計算。')),
    section('`/livo my` · `/livo review` · `/livo today` · `/livo due` · `/livo overdue`\n`/livo search ' +
      tr(source, '關鍵字') + '` · `/livo ABC-123` · `/livo edit ABC-123`\n`/livo new ` · `/livo comment ABC-123`'),
  ], source);
}

export function searchModal(source: Row = {}): Row {
  return modal('livo_search_tasks', tr(source, '搜尋 LIVO 卡片'), [
    { type: 'input', block_id: 'query', label: { type: 'plain_text', text: tr(source, '卡號或標題關鍵字') },
      element: { type: 'plain_text_input', action_id: 'query', max_length: 100, min_length: 1 } },
    context(tr(source, '只搜尋你有權限查看的卡片。結果只有你看得到。')),
    actions([button('livo_workspace_home', tr(source, '回到任務首頁'), {})]),
  ], source, {}, tr(source, '搜尋'));
}

const queryTitle = (query: TaskQuery, source: Row) => ({
  my: tr(source, '我的任務'), review: tr(source, '待我驗收'),
  today: tr(source, '今天到期'), overdue: tr(source, '已逾期'),
  due: tr(source, '未來 7 天到期'), search: tr(source, '搜尋結果'),
})[query.kind];
const priorityName = (priority: unknown, source: Row) => {
  const found = PRIORITIES.find(row => row[0] === priority);
  return found ? tr(source, found[1]) : tr(source, '未設定');
};
const taskNames = (task: Row, source: Row) => ({
  project: escape(task.project_name || tr(source, '未指定專案'), 100),
  status: escape(task.status_name || tr(source, '未設定狀態'), 100),
  assignee: escape(task.assignee_name || tr(source, '未指派'), 100),
  reviewer: escape(task.reviewer_name || tr(source, '未指定'), 100),
});
const title = (task: Row, max = 220) => `${escape(task.task_key, 80)} · ${escape(task.title, max)}`;

export function listModal(query: TaskQuery, page: TaskPage, source: Row = {}): Row {
  const current = clampPage(page.page), safeQuery = { kind: query.kind, ...(query.text ? { text: query.text.slice(0, 100) } : {}), page: current };
  const blocks: Row[] = [context(tr(source, '只有你看得到 · ') +
    tr(source, '第 {page} 頁', { page: current + 1 }))];
  if (query.kind === 'search') blocks.push(section(tr(source, '關鍵字：') + escape(query.text || '', 100)));
  if (!page.tasks.length) blocks.push(section(tr(source, '目前沒有符合條件的卡片。')));
  for (const task of page.tasks.slice(0, TASK_PAGE_SIZE)) {
    const names = taskNames(task, source);
    blocks.push(section(`*${title(task)}*\n${names.project} · ${names.status} · ${priorityName(task.priority, source)}\n` +
      tr(source, '經辦：{assignee} · 驗收：{reviewer}', { assignee: names.assignee, reviewer: names.reviewer }) +
      ` · ${escape(task.due_date || tr(source, '無期限'), 10)}`));
    blocks.push(actions([button('livo_task_open', tr(source, '查看與操作'), { taskId: task.id })]));
  }
  const navigation: Row[] = [];
  if (current > 0) navigation.push(button('livo_tasks_page', tr(source, '上一頁'), { ...safeQuery, page: current - 1 }));
  if (page.hasMore) navigation.push(button('livo_tasks_page', tr(source, '下一頁'), { ...safeQuery, page: current + 1 }));
  blocks.push(...navigation.map(item => actions([item])));
  blocks.push(actions([button('livo_workspace_search', tr(source, '搜尋其他卡片'), {}),
    button('livo_workspace_home', tr(source, '回到任務首頁'), {})]));
  return modal('livo_task_list', queryTitle(query, source), blocks, source, { query: safeQuery });
}

export function detailModal(task: Row, url: string, source: Row = {}, comments?: CommentPage): Row {
  const names = taskNames(task, source), blocks: Row[] = [section(`*${title(task, 300)}*`),
    section(tr(source, '*專案* {project}\n*狀態* {status}\n*經辦人* {assignee}\n*驗收人* {reviewer}', names)),
    section(tr(source, '*優先級* ') + priorityName(task.priority, source) + '\n' +
      tr(source, '*到期日* ') + escape(task.due_date || tr(source, '未設定'), 30)),
  ];
  const requirement = plain(task.requirement || task.description || '', 1400);
  if (requirement) blocks.push(section(tr(source, '*需求說明*\n') + escape(requirement, 1400)));
  blocks.push(actions([button('livo_task_edit', tr(source, '修改任務'), { taskId: task.id }),
    button('livo_task_comment', tr(source, '新增留言'), { taskId: task.id }),
    ...(/^https?:\/\//i.test(url) ? [{ type: 'button', text: { type: 'plain_text', text: tr(source, '開啟 LIVO') }, url }] : []),
  ]));
  blocks.push(actions([button('livo_task_context', tr(source, '查看任務內容'), { taskId: task.id, kind: 'requirement', page: 0 })]));
  if (comments) {
    blocks.push({ type: 'divider' });
    blocks.push(context(tr(source, '留言 · 第 {page} 頁（新到舊）', { page: clampPage(comments.page) + 1 })));
    if (!comments.comments.length) blocks.push(section(tr(source, '目前沒有留言。')));
    for (const comment of comments.comments.slice(0, TASK_PAGE_SIZE)) {
      const author = escape(comment.author_name || comment.member_name || tr(source, '成員'), 100);
      const body = plain(comment.content || comment.text || '', 650);
      const date = Date.parse(comment.created_at);
      const stampParts = Number.isFinite(date) ? new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(date) : [];
      const part = (name: string) => stampParts.find(value => value.type === name)?.value || '';
      const stamp = stampParts.length ? `${part('month')}/${part('day')} ${part('hour')}:${part('minute')}` : '';
      blocks.push(section(`*${author}*${stamp ? ` · ${stamp}` : ''}\n${escape(body, 650) || tr(source, '（無文字內容）')}`));
    }
    const nav: Row[] = [], current = clampPage(comments.page);
    if (current > 0) nav.push(button('livo_comments_page', tr(source, '較新留言'), { taskId: task.id, page: current - 1 }));
    if (comments.hasMore) nav.push(button('livo_comments_page', tr(source, '較早留言'), { taskId: task.id, page: current + 1 }));
    blocks.push(...nav.map(item => actions([item])));
  }
  blocks.push(actions([button('livo_workspace_home', tr(source, '回到任務首頁'), {})]));
  return modal('livo_task_detail', tr(source, 'LIVO 卡片'), blocks, source, { taskId: task.id });
}

const nullable = (value: unknown) => value == null || value === '' ? null : String(value);
const snapshot = (task: Row): Row => Object.fromEntries(FIELD_KEYS.map(field => [field, nullable(task[field])]));
const editInput = (id: string, label: string, element: Row, optional = false): Row => ({
  type: 'input', block_id: id, label: { type: 'plain_text', text: label }, element: { ...element, action_id: id }, optional,
});
const external = (id: unknown, label: unknown): Row => ({ type: 'external_select', min_query_length: 0,
  ...(id ? { initial_option: option(String(id), String(label || id)) } : {}) });

export function editModal(task: Row, source: Row = {}): Row {
  const priority = PRIORITIES.find(row => row[0] === task.priority);
  return modal('livo_edit_task', tr(source, '修改 LIVO 卡片'), [
    section(`*${title(task)}*`),
    editInput('status', tr(source, '狀態'), external(task.status_id, task.status_name)),
    editInput('assignee', tr(source, '經辦人'), external(task.assignee_id, task.assignee_name), true),
    editInput('reviewer', tr(source, '驗收人'), external(task.reviewer_id, task.reviewer_name), true),
    actions([planningButton('livo_deadline_open','修改期限',{taskId:task.id},source.locale)]),
    editInput('priority', tr(source, '優先級'), { type: 'static_select',
      ...(priority ? { initial_option: option(priority[0], tr(source, priority[1])) } : {}),
      options: PRIORITIES.map(row => option(row[0], tr(source, row[1]))) }),
    context(tr(source, '清除經辦人、驗收人會取消該設定。團隊必填規則仍適用；若卡片已被修改，請重新開啟表單。需要簽核的狀態請到 LIVO 處理。')),
  ], source, { taskId: task.id, expected: snapshot(task) }, tr(source, '儲存變更'));
}

export function parseEditSubmission(view: Row): { fields: { task_id: string; expected: Row; changes: Row }; errors: Record<string, string> } {
  let metadata: Row = {};
  try { metadata = JSON.parse(view.private_metadata || '{}'); } catch { /* Stale or malformed metadata is a validation error. */ }
  const errors: Record<string, string> = {}, expected = metadata.expected, changes: Row = {};
  const fields = { task_id: typeof metadata.taskId === 'string' ? metadata.taskId : '', expected: expected || {}, changes };
  if (!fields.task_id || !expected || typeof expected !== 'object' || FIELD_KEYS.some(field => !(field in expected))) {
    errors.status = tr(metadata, '表單資料已失效，請重新開啟卡片。');
    return { fields, errors };
  }
  const state = view.state?.values || {};
  for (const [block, field] of [['status', 'status_id'], ['assignee', 'assignee_id'], ['reviewer', 'reviewer_id'], ['due', 'due_date'], ['priority', 'priority']]) {
    const control = state[block]?.[block];
    // Slack can omit untouched controls. Absence must never mean clearing a field.
    if (!control || !Object.prototype.hasOwnProperty.call(control, block === 'due' ? 'selected_date' : 'selected_option')) continue;
    const value = nullable(block === 'due' ? control.selected_date : control.selected_option?.value);
    if (block === 'status' && !value) errors.status = tr(metadata, '請選擇狀態');
    if (block === 'priority' && !PRIORITIES.some(row => row[0] === value)) errors.priority = tr(metadata, '請選擇優先級');
    if (block === 'due' && value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value)) errors.due = tr(metadata, '日期格式不正確');
    if (value !== nullable(expected[field])) changes[field] = value;
  }
  if (!Object.keys(errors).length && !Object.keys(changes).length)
    errors.status = tr(metadata, '尚未變更任何欄位；不需修改可直接關閉。');
  return { fields, errors };
}
