// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database, createActions } from '../../docker/volumes/functions/slack-interact/backend';
import { createWorkspaceData, normalQuery, WORKSPACE_ERRORS } from '../../docker/volumes/functions/slack-interact/workspace-backend';
import { TASK_PAGE_SIZE } from '../../docker/volumes/functions/slack-interact/workspace-ui';
import { NO_ACCOUNT, UNAVAILABLE, type Row } from '../../docker/volumes/functions/slack-interact/core';

const actor = { id: 'member-example', jwt: 'member-session', team: 'TEXAMPLE', slack_user: 'UEXAMPLE' };
const task: Row = { id: 'task-example', task_key: 'EX-1', title: 'Example', assignee_id: actor.id,
  reviewer_id: actor.id, projects: { id: 'project', name: 'Project', is_archived: false }, statuses: { id: 'todo', name: 'Todo', is_done: false } };
const settings: Record<string, string> = { SUPABASE_URL: 'https://database.example', SUPABASE_ANON_KEY: 'anon-example',
  SUPABASE_SERVICE_ROLE_KEY: 'service-example', APP_BASE_URL: 'https://livo.example' };
const env = { get: (name: string) => settings[name] };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(rowsByTable: Record<string, Row[]> = {}, instant = '2026-10-01T16:00:00Z') {
  const db = { rows: vi.fn(async (table: string, _query?: Row) => rowsByTable[table] || []), request: vi.fn(async () => ({ kind: 'update' })) };
  const memberDb = vi.fn(() => db);
  return { db, memberDb, data: createWorkspaceData(memberDb, () => new Date(instant)) };
}
afterEach(() => vi.unstubAllGlobals());

describe('Slack task queries', () => {
  it.each([['my', 'assignee_id'], ['review', 'reviewer_id']] as const)('scopes %s to the member and excludes closed or archived work', async (kind, column) => {
    const { data, db, memberDb } = fixture();
    await data.list(actor, { kind, page: 0 });
    expect(memberDb).toHaveBeenCalledWith(actor);
    expect(db.rows).toHaveBeenCalledWith('tasks', expect.objectContaining({ [column]: `eq.${actor.id}`,
      'projects.is_archived': 'eq.false', 'statuses.is_done': 'eq.false', 'statuses.name': 'not.in.(取消,已取消)',
      'statuses.and': '(name.not.ilike.cancelled,name.not.ilike.canceled)', and: '(or(completed_at.is.null,completed_at.eq.""))' }));
  });
  it.each([['2026-10-01T15:59:59Z', '2026-10-01'], ['2026-10-01T16:00:00Z', '2026-10-02']])(
    'uses Taipei calendar day at %s', async (instant, date) => {
      const { data, db } = fixture({}, instant);
      await data.list(actor, { kind: 'today', page: 0 });
      expect(db.rows).toHaveBeenCalledWith('tasks', expect.objectContaining({ due_date: `eq.${date}`,
        or: `(assignee_id.eq.${actor.id},reviewer_id.eq.${actor.id})` }));
    });
  it('does not treat legacy empty due dates as overdue', async () => {
    const { data, db } = fixture();
    await data.list(actor, { kind: 'overdue', page: 0 });
    expect(db.rows).toHaveBeenCalledWith('tasks', expect.objectContaining({ due_date: 'lt.2026-10-02',
      and: '(or(completed_at.is.null,completed_at.eq.""),due_date.neq."")' }));
  });
  it('includes today through day six for the upcoming seven days across a month boundary', async () => {
    const { data, db } = fixture({}, '2026-10-29T16:00:00Z');
    await data.list(actor, { kind: 'due', page: 0 });
    expect(db.rows).toHaveBeenCalledWith('tasks', expect.objectContaining({
      and: '(or(completed_at.is.null,completed_at.eq.""),due_date.gte.2026-10-30,due_date.lte.2026-11-05)' }));
  });
  it('allows search to find completed cards but removes PostgREST filter syntax from user input', async () => {
    const { data, db } = fixture();
    await data.list(actor, { kind: 'search', text: 'EX-1),title.ilike.*', page: 0 });
    const query = db.rows.mock.calls[0][1]!;
    expect(query.or).toBe('(task_key.ilike.*EX-1titleilike*,title.ilike.*EX-1titleilike*)');
    expect(query).not.toHaveProperty('statuses.is_done');
    expect(query).not.toHaveProperty('assignee_id');
    expect(query['projects.is_archived']).toBe('eq.false');
  });
  it('returns one page and enriches only visible page recipients using member access', async () => {
    const rows = Array.from({ length: TASK_PAGE_SIZE + 1 }, (_, i) => ({ ...task, id: `task-${i}`,
      assignee_id: i === TASK_PAGE_SIZE ? 'outside-page-member' : actor.id, reviewer_id: null as string | null }));
    const { data, db, memberDb } = fixture({ tasks: rows, members: [{ id: actor.id, name: 'Example member' }] });
    const result = await data.list(actor, { kind: 'my', page: 2 });
    expect(result).toMatchObject({ page: 2, hasMore: true });
    expect(result.tasks).toHaveLength(TASK_PAGE_SIZE);
    expect(result.tasks[0]).toMatchObject({ assignee_name: 'Example member', project_name: 'Project', status_name: 'Todo' });
    expect(db.rows).toHaveBeenCalledWith('tasks', expect.objectContaining({ limit: String(TASK_PAGE_SIZE + 1),
      offset: String(TASK_PAGE_SIZE * 2), order: 'due_date.asc.nullslast,task_key.asc,id.asc' }));
    expect(db.rows).toHaveBeenCalledWith('members', { select: 'id,name', id: `in.(${actor.id})` });
    expect(memberDb).toHaveBeenCalledTimes(1);
  });
  it('treats exact-page and empty results as the last page', async () => {
    const { data } = fixture({ tasks: Array.from({ length: TASK_PAGE_SIZE }, (_, i) => ({ ...task, id: `task-${i}` })) });
    expect((await data.list(actor, { kind: 'my', page: 0 })).hasMore).toBe(false);
    expect((await fixture().data.list(actor, { kind: 'my', page: 0 })).tasks).toEqual([]);
  });
  it('bounds untrusted pagination and rejects empty or invalid search modes', () => {
    expect(normalQuery({ kind: 'my', page: -2 }).page).toBe(0);
    expect(normalQuery({ kind: 'my', page: 999999 }).page).toBe(10000);
    expect(normalQuery({ kind: 'my', page: '3' }).page).toBe(0);
    expect(() => normalQuery({ kind: 'delete', page: 0 })).toThrow('請重新選擇任務清單');
    expect(() => normalQuery({ kind: 'search', text: '*()', page: 0 })).toThrow('請輸入卡號或標題關鍵字');
  });
  it('rejects invalid member identifiers before a database request', async () => {
    const { data, db } = fixture();
    await expect(data.list({ ...actor, id: 'member),id.neq.x' }, { kind: 'my', page: 0 })).rejects.toThrow(UNAVAILABLE);
    expect(db.rows).not.toHaveBeenCalled();
  });
});

describe('Slack task detail and comments', () => {
  it('detects duplicate task keys instead of silently selecting a project', async () => {
    const { data, db } = fixture({ tasks: [task, { ...task, id: 'other-project-task' }] });
    await expect(data.detail(actor, 'EX-1', true)).rejects.toThrow('多張相同卡號');
    expect(db.rows).toHaveBeenCalledWith('tasks', expect.objectContaining({ task_key: 'eq.EX-1', limit: '2' }));
    expect(db.rows).toHaveBeenCalledTimes(1);
  });
  it('does not fetch specification or recipients for a hidden task', async () => {
    const { data, db } = fixture();
    await expect(data.detail(actor, 'hidden-task')).rejects.toThrow(UNAVAILABLE);
    expect(db.rows).toHaveBeenCalledTimes(1);
  });
  it('warns about duplicate specifications instead of displaying arbitrary requirement data', async () => {
    const { data, db } = fixture({ tasks: [task], task_specs: [{ requirement: 'First secret draft' }, { requirement: 'Second draft' }] });
    const result = await data.detail(actor, task.id);
    expect(result.requirement).toBe('此卡片有多筆需求資料，請到 LIVO 確認。');
    expect(db.rows).toHaveBeenCalledWith('task_specs', expect.objectContaining({ task_id: `eq.${task.id}`, limit: '2' }));
  });
  it('handles single and absent specifications without weakening task visibility', async () => {
    const single = fixture({ tasks: [task], task_specs: [{ requirement: '<p>Requirement</p>' }] });
    expect((await single.data.detail(actor, task.id)).requirement).toBe('<p>Requirement</p>');
    expect((await fixture({ tasks: [task] }).data.detail(actor, task.id)).requirement).toBe('');
  });
  it('rechecks task visibility before accessing any comment page', async () => {
    const { data, db } = fixture({ comments: [{ id: 'private', content: 'must not return' }] });
    await expect(data.comments(actor, 'hidden-task', 3)).rejects.toThrow(UNAVAILABLE);
    expect(db.rows).toHaveBeenCalledTimes(1);
    expect(db.rows).toHaveBeenCalledWith('tasks', expect.objectContaining({ 'projects.is_archived': 'eq.false', id: 'eq.hidden-task' }));
  });
  it('paginates visible comments with deterministic ordering and linked author names', async () => {
    const comments = Array.from({ length: TASK_PAGE_SIZE + 1 }, (_, i) => ({ id: `comment-${i}`, content: `Text ${i}`,
      members: i % 2 ? [{ name: 'Second author' }] : { name: 'First author' } }));
    const { data, db } = fixture({ tasks: [task], comments });
    const result = await data.comments(actor, task.id, 1);
    expect(result).toMatchObject({ hasMore: true, page: 1 });
    expect(result.comments).toHaveLength(TASK_PAGE_SIZE);
    expect(result.comments.slice(0, 2).map(row => row.author_name)).toEqual(['First author', 'Second author']);
    expect(db.rows).toHaveBeenLastCalledWith('comments', expect.objectContaining({ select: 'id,content,created_at,members(name)',
      task_id: `eq.${task.id}`, order: 'created_at.desc,id.desc', limit: String(TASK_PAGE_SIZE + 1), offset: String(TASK_PAGE_SIZE) }));
  });
  it('passes expected values and trusted actor identity to the atomic update RPC', async () => {
    const { data, db, memberDb } = fixture();
    const fields = { task_id: task.id, expected: { status_id: 'todo', assignee_id: actor.id, reviewer_id: null as string | null, priority: 'medium', due_date: null as string | null },
      changes: { status_id: 'doing', reviewer_id: 'reviewer' } };
    await expect(data.update(actor, fields, 'request-id', { channel: 'CEXAMPLE', thread: '1.2', team: 'UNTRUSTED' })).resolves.toEqual({ kind: 'update' });
    expect(memberDb).toHaveBeenCalledWith(actor);
    expect(db.request).toHaveBeenCalledWith('/rest/v1/rpc/livo_slack_update', 'POST', { p_request_id: 'request-id', p_task_id: task.id,
      p_expected: fields.expected, p_changes: fields.changes, p_source: { channel: 'CEXAMPLE', thread: '1.2', team: actor.team, actor: actor.slack_user } });
    expect(db.rows).not.toHaveBeenCalled();
  });
});

describe('member database boundary and safe errors', () => {
  it('uses member JWT for the complete task list and name lookup', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => response(new URL(url).pathname.endsWith('/members')
      ? [{ id: actor.id, name: 'Actor' }] : [task]));
    vi.stubGlobal('fetch', fetchMock);
    await createActions(env, () => {}).workspace!.list(actor, { kind: 'my', page: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer member-session');
  });
  it.each([undefined, null, ''])('never falls back to service credentials when actor JWT is %j', async jwt => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const workspace = createActions(env, () => {}).workspace!;
    await expect(workspace.list({ ...actor, jwt }, { kind: 'my', page: 0 })).rejects.toThrow(NO_ACCOUNT);
    await expect(workspace.detail({ ...actor, jwt }, task.id)).rejects.toThrow(NO_ACCOUNT);
    await expect(workspace.comments({ ...actor, jwt }, task.id, 0)).rejects.toThrow(NO_ACCOUNT);
    await expect(workspace.update({ ...actor, jwt }, { task_id: task.id }, 'request-id', {})).rejects.toThrow(NO_ACCOUNT);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(Object.entries(WORKSPACE_ERRORS))('translates only the stable update error %s', async (message, translated) => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ message, details: 'SQL and table names must not leak' }, 409)));
    await expect(new Database(env, actor.jwt).request('/rest/v1/rpc/livo_slack_update', 'POST', {})).rejects.toMatchObject({ name: 'ActionError', message: translated });
  });
  it.each(['SQL private data', 'constructor', 'toString', '__proto__'])('does not expose unlisted error %s', async message => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ message, details: 'private detail' }, 400)));
    await expect(new Database(env, actor.jwt).request('/rest/v1/rpc/livo_slack_update', 'POST', {})).rejects.toThrow('Database operation failed');
  });
  it('does not translate a same-named error from an unrelated endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ message: 'slack_task_conflict' }, 400)));
    await expect(new Database(env, actor.jwt).request('/rest/v1/tasks')).rejects.toThrow('Database operation failed');
  });
  it('hides a non-JSON upstream error response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Internal proxy diagnostics', { status: 502 })));
    await expect(new Database(env, actor.jwt).request('/rest/v1/rpc/livo_slack_update', 'POST', {})).rejects.toThrow('Database operation failed');
  });
});
