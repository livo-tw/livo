import { DISABLED, messageModal, UNAVAILABLE, type Row } from './core.ts';
import type { Actions } from './handler.ts';
import type { MemberDatabase } from './workspace-backend.ts';
import { workspaceText } from './workspace-i18n.ts';

export const TASK_CONTEXT_KINDS = ['background', 'requirement', 'notes', 'checks', 'todos', 'children', 'dependencies', 'dependents'] as const;
export type TaskContextKind = typeof TASK_CONTEXT_KINDS[number];
export type TaskContextQuery = { taskId: string; kind: TaskContextKind; page: number; byKey?: boolean };
export type TaskContextRow = { id?: string; task_key?: string; title?: string; status_name?: string; text?: string; is_done?: boolean; unavailable?: true };
export type TaskContextResult = {
  task: Row; kind: TaskContextKind; page: number; hasMore: boolean;
  text?: string; totalPages?: number; rows: TaskContextRow[]; parent?: TaskContextRow;
};
export interface TaskContextData {
  read(actor: Row, query: TaskContextQuery): Promise<TaskContextResult>;
}

const PAGE_SIZE = 8;
const TEXT_SIZE = 2000;
const TASK_SELECT = 'id,task_key,title,project_id,parent_task_id,projects!inner(id,name,is_archived),statuses(id,name,is_done)';
const ACTIVE_PROJECT = { 'projects.is_archived': 'eq.false' };
const fail = (message = UNAVAILABLE): never => { throw Object.assign(new Error(message), { name: 'ActionError' }); };
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[\w-]{1,200}$/.test(value)) fail();
  return value as string;
};
const one = (value: unknown): Row => (Array.isArray(value) ? value[0] : value) as Row || {};
const pageNumber = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Math.min(Number(value), 10000) : 0;
const clip = (value: unknown, length: number): string => {
  const text = String(value ?? '');
  const end = text.length > length && /[\uD800-\uDBFF]/.test(text.charAt(length - 1)) ? length - 1 : length;
  return text.slice(0, end);
};
const textPages = (value: string): string[] => {
  const pages: string[] = []; let page = '';
  for (const character of value) {
    if (page.length + character.length > TEXT_SIZE) { pages.push(page); page = ''; }
    page += character;
  }
  if (page || !pages.length) pages.push(page);
  return pages;
};
const unavailable = (): TaskContextRow => ({ unavailable: true });
const taskRow = (task: Row): TaskContextRow => ({
  id: task.id, task_key: task.task_key, title: task.title,
  ...(typeof one(task.statuses).name === 'string' ? { status_name: one(task.statuses).name } : {}),
});

/** HTML is only converted to text, never forwarded as Slack markup or executed. No input-length truncation. */
function plain(value: unknown): string {
  return String(value ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, entity => {
      const key = entity.slice(1, -1).toLowerCase();
      const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      if (key in named) return named[key];
      const value = key.startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity;
    }).trim();
}

/** All reads use the current actor's member JWT, including every page and relation endpoint. */
export function createTaskContextData(memberDb: (actor: Row) => MemberDatabase): TaskContextData {
  return {
    async read(actor, input) {
      // Reject forged routes before querying any content.
      if (!input || !TASK_CONTEXT_KINDS.includes(input.kind)) fail();
      const taskId = id(input.taskId), kind = input.kind, page = pageNumber(input.page);
      if (input.byKey && !/^[a-z][a-z0-9_]*-\d+$/i.test(taskId)) fail();
      const db = memberDb(actor);
      // Some legacy installations expose description; selecting an absent named column would fail newer schemas.
      const matches = await db.rows('tasks', { select: '*,projects!inner(id,name,is_archived),statuses(id,name,is_done)', ...ACTIVE_PROJECT,
        [input.byKey ? 'task_key' : 'id']: `eq.${taskId}`, limit: input.byKey ? '2' : '1' });
      if (matches.length !== 1) fail();
      const current = matches[0], currentId = id(current.id);
      // Do not return the stored parent ID: it may reference an inaccessible task.
      const task = { id: currentId, task_key: current.task_key, title: current.title,
        project_id: current.project_id, project_name: one(current.projects).name };
      const result: TaskContextResult = { task, kind, page, hasMore: false, rows: [] };
      if (['background', 'requirement', 'notes'].includes(kind)) {
        const specs = await db.rows('task_specs', { select: kind, task_id: `eq.${currentId}`, order: 'id.asc', limit: '2' });
        if (specs.length > 1) fail('此卡片有多筆需求資料，請到 LIVO 確認。');
        // Match the existing task-detail summary for legacy cards without task_specs.requirement.
        const value = specs[0]?.[kind] || (kind === 'requirement' ? current.description : '');
        const pages = textPages(plain(value));
        result.totalPages = pages.length;
        result.page = Math.min(page, result.totalPages - 1);
        result.text = pages[result.page];
        result.hasMore = result.page + 1 < result.totalPages;
        return result;
      }
      if (kind === 'checks' || kind === 'todos') {
        const rows = await db.rows(kind === 'checks' ? 'task_checks' : 'task_todos', {
          select: 'id,task_id,text,is_done,sort_order', task_id: `eq.${currentId}`, order: 'sort_order.asc,id.asc',
          limit: String(PAGE_SIZE + 1), offset: String(page * PAGE_SIZE),
        });
        result.rows = rows.slice(0, PAGE_SIZE).filter(row => row.task_id === currentId).map(row => ({
          text: String(row.text ?? ''),
          ...([true, false, 1, 0].includes(row.is_done) ? { is_done: row.is_done === true || row.is_done === 1 } : {}),
        }));
        result.hasMore = rows.length > PAGE_SIZE;
        return result;
      }
      const visibleTasks = async (ids: string[]): Promise<Map<string, Row>> => {
        const distinct = [...new Set(ids.map(id))];
        if (!distinct.length) return new Map();
        const rows = await db.rows('tasks', { select: TASK_SELECT, ...ACTIVE_PROJECT, id: `in.(${distinct.join(',')})`,
          limit: String(distinct.length) });
        return new Map(rows.map(row => [row.id, row]));
      };
      if (kind === 'children') {
        if (current.parent_task_id) {
          const parents = await visibleTasks([current.parent_task_id]);
          result.parent = parents.has(current.parent_task_id) ? taskRow(parents.get(current.parent_task_id)!) : unavailable();
        }
        const rows = await db.rows('tasks', { select: TASK_SELECT, ...ACTIVE_PROJECT, parent_task_id: `eq.${currentId}`,
          order: 'task_key.asc,id.asc', limit: String(PAGE_SIZE + 1), offset: String(page * PAGE_SIZE) });
        result.rows = rows.slice(0, PAGE_SIZE).filter(row => row.parent_task_id === currentId).map(taskRow);
        result.hasMore = rows.length > PAGE_SIZE;
        return result;
      }
      const endpoint = kind === 'dependencies' ? 'depends_on_task_id' : 'task_id';
      const currentField = kind === 'dependencies' ? 'task_id' : 'depends_on_task_id';
      const relations = await db.rows('task_dependencies', {
        select: 'id,task_id,depends_on_task_id', [currentField]: `eq.${currentId}`, order: 'id.asc',
        limit: String(PAGE_SIZE + 1), offset: String(page * PAGE_SIZE),
      });
      const currentPage = relations.slice(0, PAGE_SIZE).filter(row => row[currentField] === currentId);
      const visible = await visibleTasks(currentPage.map(row => row[endpoint]));
      result.rows = currentPage.map(row => visible.has(row[endpoint]) ? taskRow(visible.get(row[endpoint])!) : unavailable());
      result.hasMore = relations.length > PAGE_SIZE;
      return result;
    },
  };
}

const LABELS: Record<TaskContextKind, string> = {
  background: '背景', requirement: '需求', notes: '備註', checks: '驗收清單', todos: '待辦清單',
  children: '父子任務', dependencies: '前置任務', dependents: '後續任務',
};
const tr = (source: Row, value: string, variables: Record<string, string | number> = {}) => workspaceText(value, source.locale, variables);
const section = (text: string): Row => ({ type: 'section', text: { type: 'plain_text', text: clip(text, 2900) || '—' } });
const button = (label: string, value: Row, action = 'livo_task_context'): Row => ({
  type: 'button', action_id: action, text: { type: 'plain_text', text: clip(label, 75) }, value: JSON.stringify(value),
});
const sourceMetadata = (source: Row): Row => Object.fromEntries(['channel', 'thread', 'user', 'team', 'locale']
  .filter(key => typeof source[key] === 'string').map(key => [key, clip(source[key], 150)]));

export function contextModal(result: TaskContextResult, url: string, source: Row = {}): Row {
  const blocks: Row[] = [
    section(clip(`${result.task.task_key || ''} · ${result.task.title || ''}`, 500)),
    section(tr(source, '只有你看得到 · 唯讀任務內容，清單勾選不代表 QA 驗證結果。')),
    section(tr(source, LABELS[result.kind]) + ' · ' + tr(source, '第 {page} 頁', { page: result.page + 1 })),
  ];
  const addTask = (row: TaskContextRow) => {
    if (row.unavailable) { blocks.push(section(tr(source, '關聯任務不存在或你沒有檢視權限。'))); return; }
    blocks.push(section(clip(`${row.task_key || ''} · ${row.title || ''}`, 2100) +
      (row.status_name ? '\n' + clip(row.status_name, 200) : '')));
    if (row.id) blocks.push({ type: 'actions', elements: [button(tr(source, '查看卡片'), { taskId: row.id }, 'livo_task_open')] });
  };
  if (result.text !== undefined) {
    if ((result.totalPages || 1) > 1) blocks.push(section(tr(source, '完整文字分為 {pages} 頁，請翻頁閱讀其餘內容。', { pages: result.totalPages! })));
    blocks.push(section(result.text || tr(source, '此欄位尚無內容。')));
  } else {
    if (result.parent) { blocks.push(section(tr(source, '父任務'))); addTask(result.parent); }
    if (result.kind === 'children') blocks.push(section(tr(source, '子任務')));
    if (!result.rows.length) blocks.push(section(tr(source, '目前沒有項目。')));
    for (const row of result.rows) {
      if (result.kind === 'checks' || result.kind === 'todos') {
        const state = row.is_done === true ? '已完成' : row.is_done === false ? '未完成' : '狀態未提供';
        const text = String(row.text || '');
        blocks.push(section(tr(source, state) + '\n' + clip(text, TEXT_SIZE)));
        if (text.length > TEXT_SIZE) blocks.push(section(tr(source, '此項文字較長，請開啟 LIVO 卡片閱讀完整內容。')));
      } else addTask(row);
    }
  }
  const route = { taskId: result.task.id, kind: result.kind };
  const nav: Row[] = [];
  if (result.page > 0) nav.push(button(tr(source, '上一頁'), { ...route, page: result.page - 1 }));
  if (result.hasMore) nav.push(button(tr(source, '下一頁'), { ...route, page: result.page + 1 }));
  for (const element of nav) blocks.push({ type: 'actions', elements: [element] });
  const fields = TASK_CONTEXT_KINDS.map(kind => button(tr(source, LABELS[kind]), { taskId: result.task.id, kind, page: 0 }));
  // Slack requires action_id uniqueness within each block; all routes intentionally use one handler ID.
  for (const element of fields) blocks.push({ type: 'actions', elements: [element] });
  const back = [button(tr(source, '返回卡片'), { taskId: result.task.id }, 'livo_task_open')];
  if (/^https?:\/\//i.test(url)) back.push({ type: 'button', action_id: 'livo_task_context_link',
    text: { type: 'plain_text', text: tr(source, '開啟 LIVO 卡片') }, url });
  blocks.push({ type: 'actions', elements: back });
  return { type: 'modal', callback_id: 'livo_task_context_view', title: { type: 'plain_text', text: clip(tr(source, 'LIVO 任務內容'), 24) },
    close: { type: 'plain_text', text: tr(source, '關閉') }, private_metadata: JSON.stringify(sourceMetadata(source)), blocks };
}

/** Private-only reads: consume Slack's short-lived trigger before slow member/database checks. */
export async function handleTaskContextInteraction(p: Row, d: Actions, source: Row): Promise<Row | undefined> {
  const command = p.command && /^context(?:\s|$)/i.test(String(p.text || '').trim());
  const action = p.type === 'block_actions' ? p.actions?.[0] : undefined;
  if (!command && action?.action_id !== 'livo_task_context') return undefined;
  if (!d.taskContext) return {};
  const data = d.taskContext;
  let opening: Row;
  try {
    const view = messageModal(tr(source, '正在載入 LIVO…'));
    opening = p.view?.id
      ? await d.slack('views.update', { view_id: p.view.id, ...(p.view.hash ? { hash: p.view.hash } : {}), view })
      : await d.slack('views.open', { trigger_id: p.trigger_id, view });
  } catch { return {}; }
  d.background((async () => {
    let view: Row;
    const localized = { ...source };
    try {
      if (!(await d.enabled())) fail(DISABLED);
      const actor = await d.actor(p);
      localized.locale = actor.locale;
      let query: TaskContextQuery;
      if (command) {
        const key = String(p.text || '').trim().replace(/^context\s*/i, '').trim();
        if (!/^[a-z][a-z0-9_]*-\d+$/i.test(key)) fail('請使用 /livo context 卡號 查看任務內容。');
        query = { taskId: key.toUpperCase(), kind: 'requirement', page: 0, byKey: true };
      } else {
        let value: Row = {};
        try { const parsed = JSON.parse(action?.value || '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed; } catch { /* reject below */ }
        query = { taskId: value.taskId, kind: value.kind, page: value.page };
      }
      const result = await data.read(actor, query);
      view = contextModal(result, d.link(result.task), localized);
    } catch (error) {
      const text = error instanceof Error && error.name === 'ActionError' ? error.message : '操作未完成，請重新開啟再試一次；若持續失敗，請洽管理員。';
      view = messageModal(tr(localized, text));
    }
    // A closed/private modal never falls back to a channel or DM containing task data.
    await d.slack('views.update', { view_id: opening.view?.id || p.view?.id,
      ...(opening.view?.hash ? { hash: opening.view.hash } : {}), view }).catch(() => {});
  })());
  return {};
}
