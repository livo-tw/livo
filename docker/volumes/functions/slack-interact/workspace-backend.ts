import { type Row, UNAVAILABLE } from './core.ts';
import { TASK_PAGE_SIZE, type TaskQuery, type TaskPage, type CommentPage } from './workspace-ui.ts';

export interface MemberDatabase {
  rows(table: string, query?: Row): Promise<Row[]>;
  request(path: string, method?: string, body?: unknown, query?: Row): Promise<any>;
}
export interface WorkspaceData {
  list(actor: Row, query: TaskQuery): Promise<TaskPage>;
  detail(actor: Row, id: string, byKey?: boolean): Promise<Row>;
  comments(actor: Row, taskId: string, page: number): Promise<CommentPage>;
  update(actor: Row, fields: Row, requestId: string, source: Row): Promise<Row>;
}
export const WORKSPACE_ERRORS: Record<string, string> = {
  slack_session_unavailable: 'Slack 帳號綁定或功能已停用，請重新開啟；若持續失敗，請洽管理員。',
  slack_task_unavailable: UNAVAILABLE,
  slack_task_conflict: '卡片已被其他人修改，這次變更尚未儲存。請重新開啟卡片，確認最新內容後再修改。',
  slack_update_invalid: '修改內容不完整或不支援，請重新開啟表單。',
  slack_request_conflict: '這份表單已送出過不同內容，請重新開啟卡片。',
  slack_required_field: '團隊必填欄位不能清空，請確認經辦人、驗收人與到期日。',
  slack_member_unavailable: '選取的成員已停用或無法存取，請重新選擇。',
  slack_invalid_date: '到期日期不正確，請重新選擇。',
  slack_status_unavailable: '選取的狀態已不存在或無法存取，請重新選擇。',
  slack_transition_prerequisite: '尚未完成這個狀態的前置步驟，請先到 LIVO 確認工作流程。',
  slack_approval_required: '這個狀態變更需要簽核，請到 LIVO 依原有簽核流程操作。',
};
const fail = (message: string): never => { throw Object.assign(new Error(message), { name: 'ActionError' }); };
const identifier = (id: unknown) => {
  if (typeof id !== 'string' || !/^[\w-]{1,200}$/.test(id)) fail(UNAVAILABLE);
  return id as string;
};
export function normalQuery(input: Row): TaskQuery {
  if (!['my', 'review', 'today', 'overdue', 'due', 'search'].includes(input.kind)) fail('請重新選擇任務清單。');
  const page = Number.isSafeInteger(input.page) && input.page >= 0 ? Math.min(input.page, 10000) : 0;
  const text = String(input.text || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 100);
  if (input.kind === 'search' && !text) fail('請輸入卡號或標題關鍵字。');
  return { kind: input.kind, page, ...(text ? { text } : {}) };
}
const one = (value: any): Row => (Array.isArray(value) ? value[0] : value) || {};
const SELECT = '*,projects!inner(id,name,is_archived),statuses!inner(id,name,is_done)';
const activeProject = { 'projects.is_archived': 'eq.false' };
const dateInTaipei = (now: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);

/** Every content read and mutation uses a short-lived member JWT and database RLS. */
export function createWorkspaceData(memberDb: (actor: Row) => MemberDatabase, now: () => Date = () => new Date()): WorkspaceData {
  async function enrich(db: MemberDatabase, tasks: Row[]) {
    const ids = [...new Set(tasks.flatMap(task => [task.assignee_id, task.reviewer_id]).filter(Boolean))].map(identifier);
    const members = ids.length ? await db.rows('members', { select: 'id,name', id: `in.(${ids.join(',')})` }) : [];
    const names = new Map(members.map(member => [member.id, member.name]));
    return tasks.map(task => ({ ...task, project_name: one(task.projects).name, status_name: one(task.statuses).name,
      assignee_name: names.get(task.assignee_id), reviewer_name: names.get(task.reviewer_id) }));
  }
  const data: WorkspaceData = {
    async list(actor, input) {
      const db = memberDb(actor), query = normalQuery(input), id = identifier(actor.id);
      const params: Row = { select: SELECT, ...activeProject, order: 'due_date.asc.nullslast,task_key.asc,id.asc',
        limit: String(TASK_PAGE_SIZE + 1), offset: String(query.page * TASK_PAGE_SIZE) };
      if (query.kind === 'search') params.or = `(task_key.ilike.*${query.text}*,title.ilike.*${query.text}*)`;
      else {
        params['statuses.is_done'] = 'eq.false';
        params['statuses.name'] = 'not.in.(取消,已取消)';
        params['statuses.and'] = '(name.not.ilike.cancelled,name.not.ilike.canceled)';
        params.and = '(or(completed_at.is.null,completed_at.eq.""))';
        if (query.kind === 'my') params.assignee_id = `eq.${id}`;
        else if (query.kind === 'review') params.reviewer_id = `eq.${id}`;
        else {
          params.or = `(assignee_id.eq.${id},reviewer_id.eq.${id})`;
          const today = dateInTaipei(now());
          if (query.kind === 'today') params.due_date = `eq.${today}`;
          if (query.kind === 'overdue') {
            params.due_date = `lt.${today}`;
            params.and = '(or(completed_at.is.null,completed_at.eq.""),due_date.neq."")';
          }
          if (query.kind === 'due') {
            const end = new Date(`${today}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 6);
            params.and = `(or(completed_at.is.null,completed_at.eq.""),due_date.gte.${today},due_date.lte.${end.toISOString().slice(0, 10)})`;
          }
        }
      }
      const tasks = await db.rows('tasks', params);
      return { tasks: await enrich(db, tasks.slice(0, TASK_PAGE_SIZE)), hasMore: tasks.length > TASK_PAGE_SIZE, page: query.page };
    },
    async detail(actor, id, byKey = false) {
      const db = memberDb(actor);
      const matches = await db.rows('tasks', { select: SELECT, ...activeProject,
        [byKey ? 'task_key' : 'id']: `eq.${identifier(id)}`, limit: byKey ? '2' : '1' });
      if (matches.length > 1) fail('找到多張相同卡號的卡片，請從搜尋結果依專案選擇。');
      const task = matches[0];
      if (!task) fail(UNAVAILABLE);
      const [rich, specs] = await Promise.all([enrich(db, [task]),
        db.rows('task_specs', { select: 'requirement', task_id: `eq.${identifier(task.id)}`, order: 'id', limit: '2' })]);
      return { ...rich[0], requirement: specs.length > 1 ? '此卡片有多筆需求資料，請到 LIVO 確認。' : specs[0]?.requirement || '' };
    },
    async comments(actor, taskId, requestedPage) {
      const db = memberDb(actor), id = identifier(taskId);
      // Recheck task visibility independently, including direct pagination requests.
      const visible = await db.rows('tasks', { select: 'id,projects!inner(is_archived)', ...activeProject, id: `eq.${id}`, limit: '1' });
      if (!visible.length) fail(UNAVAILABLE);
      const page = Number.isSafeInteger(requestedPage) && requestedPage >= 0 ? Math.min(requestedPage, 10000) : 0;
      const rows = await db.rows('comments', { select: 'id,content,created_at,members(name)', task_id: `eq.${id}`,
        order: 'created_at.desc,id.desc', limit: String(TASK_PAGE_SIZE + 1), offset: String(page * TASK_PAGE_SIZE) });
      return { comments: rows.slice(0, TASK_PAGE_SIZE).map(row => ({ ...row, author_name: one(row.members).name })),
        hasMore: rows.length > TASK_PAGE_SIZE, page };
    },
    async update(actor, fields, requestId, source) {
      const result = await memberDb(actor).request('/rest/v1/rpc/livo_slack_update', 'POST', {
        p_request_id: requestId, p_task_id: identifier(fields.task_id), p_expected: fields.expected, p_changes: fields.changes,
        p_source: { channel: source.channel || '', thread: source.thread || '', team: actor.team, actor: actor.slack_user },
      });
      return result;
    },
  };
  return data;
}
