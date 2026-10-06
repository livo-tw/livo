// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createTaskContextData, contextModal, handleTaskContextInteraction } from '../../docker/volumes/functions/slack-interact/task-context';
import type { Actions } from '../../docker/volumes/functions/slack-interact/handler';
import { UNAVAILABLE, type Row } from '../../docker/volumes/functions/slack-interact/core';
import { detailModal } from '../../docker/volumes/functions/slack-interact/workspace-ui';
import { WORKSPACE_MESSAGES } from '../../docker/volumes/functions/slack-interact/workspace-i18n';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const actor = { id: 'member-example', locale: 'en', team: 'TEXAMPLE', slack_user: 'UEXAMPLE' };
const task: Row = { id: 'task-example', task_key: 'EX-1', title: 'Example card', project_id: 'project-example',
  projects: { name: 'Example project', is_archived: false }, statuses: { name: 'Todo', is_done: false } };
function fixture(options: { visible?: boolean; specs?: Row[]; rows?: Row[]; related?: Row[]; children?: Row[]; parent?: Row[]; duplicates?: boolean; current?: Row } = {}) {
  const db = { rows: vi.fn(async (table: string, query: Row = {}) => {
    if (table === 'tasks') {
      if (query.id === `eq.${task.id}` || query.task_key === `eq.${task.task_key}`) {
        const current = { ...task, ...options.current };
        return options.visible === false ? [] : options.duplicates ? [current, { ...current, id: 'duplicate-example' }] : [current];
      }
      if (query.parent_task_id) return options.children || [];
      if (String(query.id).startsWith('in.')) return options.related || [];
      return options.parent || [];
    }
    if (table === 'task_specs') return options.specs || [];
    return options.rows || [];
  }), request: vi.fn() };
  const memberDb = vi.fn(() => db);
  return { data: createTaskContextData(memberDb), db, memberDb };
}
const buttonValues = (view: Row) => view.blocks.flatMap((block: Row) => block.elements || [])
  .filter((item: Row) => item.action_id === 'livo_task_context').map((item: Row) => JSON.parse(item.value));

describe('Private Slack task context reads', () => {
  it.each(['background', 'requirement', 'notes', 'checks', 'todos', 'children', 'dependencies', 'dependents'] as const)(
    'rechecks the current card before %s, even for a direct saved page button', async kind => {
      const { data, db, memberDb } = fixture({ visible: false, rows: [{ id: 'hidden-item', text: 'Restricted text' }] });
      await expect(data.read(actor, { taskId: task.id, kind, page: 4 })).rejects.toThrow(UNAVAILABLE);
      expect(memberDb).toHaveBeenCalledWith(actor);
      expect(db.rows).toHaveBeenCalledTimes(1);
      expect(db.request).not.toHaveBeenCalled();
    });
  it('rejects duplicate card keys without reading arbitrary project specifications', async () => {
    const { data, db } = fixture({ duplicates: true });
    await expect(data.read(actor, { taskId: task.task_key, byKey: true, kind: 'requirement', page: 0 })).rejects.toThrow();
    expect(db.rows).toHaveBeenCalledTimes(1);
  });
  it('never renders either conflicting specification when legacy duplicates exist', async () => {
    const { data } = fixture({ specs: [{ requirement: 'Private draft one' }, { requirement: 'Private draft two' }] });
    const result = await data.read(actor, { taskId: task.id, kind: 'requirement', page: 0 }).catch(error => ({ error: error.message }));
    expect(JSON.stringify(result)).not.toContain('Private draft');
  });
  it.each(['checks', 'todos'] as const)('keeps %s distinct, paged and static', async kind => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ id: `item-${i}`, task_id: task.id, text: `Item ${i}`, is_done: i === 0, sort_order: i }));
    const { data, db } = fixture({ rows });
    const result = await data.read(actor, { taskId: task.id, kind, page: 2 });
    expect(result.rows).toHaveLength(8);
    expect(result.hasMore).toBe(true);
    expect(db.rows).toHaveBeenCalledWith(`task_${kind}`, expect.objectContaining({ task_id: `eq.${task.id}`, offset: '16', limit: '9' }));
    const view = contextModal(result, 'https://livo.example/?task=EX-1', actor);
    expect(view.blocks.some((block: Row) => block.type === 'input')).toBe(false);
    expect(db.request).not.toHaveBeenCalled();
  });
  it('cannot expose a checklist row returned for another card', async () => {
    const { data } = fixture({ rows: [{ id: 'wrong-card', task_id: 'other-card', text: 'Wrong card private text' }] });
    const result = await data.read(actor, { taskId: task.id, kind: 'checks', page: 0 });
    expect(JSON.stringify(result)).not.toContain('Wrong card');
  });
  it.each(['dependencies', 'dependents'] as const)('keeps inaccessible %s endpoints anonymous and unknown', async kind => {
    const relation = kind === 'dependencies'
      ? { id: 'edge-example', task_id: task.id, depends_on_task_id: 'hidden-card' }
      : { id: 'edge-example', task_id: 'hidden-card', depends_on_task_id: task.id };
    const { data, db } = fixture({ rows: [relation], related: [] });
    const result = await data.read(actor, { taskId: task.id, kind, page: 0 });
    expect(result.rows).toEqual([{ unavailable: true }]);
    expect(JSON.stringify(contextModal(result, '', actor))).not.toContain('hidden-card');
    expect(db.request).not.toHaveBeenCalled();
  });
  it('shows a visible cross-project prerequisite without adding a same-project restriction', async () => {
    const related = { ...task, id: 'related-card', task_key: 'OTHER-2', project_id: 'other-project', title: 'Shared backend prerequisite' };
    const { data, db } = fixture({ rows: [{ id: 'edge-example', task_id: task.id, depends_on_task_id: related.id }], related: [related] });
    const result = await data.read(actor, { taskId: task.id, kind: 'dependencies', page: 0 });
    expect(JSON.stringify(result)).toContain('Shared backend prerequisite');
    const query = db.rows.mock.calls.find(([table, params]) => table === 'tasks' && String(params.id).startsWith('in.'))?.[1];
    expect(query).not.toHaveProperty('project_id');
  });
  it('preserves full long specifications through Unicode-safe paging and plain-text rendering', async () => {
    const body = '📝'.repeat(2001);
    const { data, db } = fixture({ specs: [{ requirement: `<p>${body}</p>` }] });
    const pages = await Promise.all([0, 1, 2].map(page => data.read(actor, { taskId: task.id, kind: 'requirement', page })));
    expect(pages.map(page => page.text).join('')).toBe(body);
    expect(pages.map(page => page.hasMore)).toEqual([true, true, false]);
    expect(db.request).not.toHaveBeenCalled();
  });
  it('offers context from a task detail even when comments are not loaded', () => {
    const view = detailModal(task, '', actor);
    expect(buttonValues(view)).toContainEqual({ taskId: task.id, kind: 'requirement', page: 0 });
  });
  it('keeps a hidden parent anonymous and filters children from a different parent', async () => {
    const { data } = fixture({ current: { parent_task_id: 'hidden-parent' }, children: [
      { ...task, id: 'correct-child', parent_task_id: task.id, title: 'Visible child' },
      { ...task, id: 'wrong-child', parent_task_id: 'other-parent', title: 'Unrelated child' },
    ] });
    const result = await data.read(actor, { taskId: task.id, kind: 'children', page: 0 });
    expect(result.parent).toEqual({ unavailable: true });
    expect(result.rows).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('hidden-parent');
    expect(JSON.stringify(result)).not.toContain('Unrelated child');
  });
  it('preserves legacy task descriptions only as a requirement fallback', async () => {
    const { data } = fixture({ current: { description: '<p>Legacy full requirement</p>' } });
    expect((await data.read(actor, { taskId: task.id, kind: 'requirement', page: 0 })).text).toBe('Legacy full requirement');
    expect((await data.read(actor, { taskId: task.id, kind: 'notes', page: 0 })).text).toBe('');
  });
  it.each([
    { taskId: 'task),id.neq.other', kind: 'requirement', page: 0 },
    { taskId: task.id, kind: 'delete', page: 0 },
  ])('rejects a forged route before acquiring a database session', async input => {
    const { data, memberDb } = fixture();
    await expect(data.read(actor, input as any)).rejects.toThrow(UNAVAILABLE);
    expect(memberDb).not.toHaveBeenCalled();
  });
  it('uses unique action IDs in every block, including both navigation buttons', async () => {
    const { data } = fixture({ specs: [{ requirement: 'X'.repeat(6000) }] });
    const result = await data.read(actor, { taskId: task.id, kind: 'requirement', page: 1 });
    const view = contextModal(result, 'https://livo.example/?task=EX-1', actor);
    for (const block of view.blocks) {
      const ids = (block.elements || []).map((element: Row) => element.action_id).filter(Boolean);
      expect(new Set(ids).size).toBe(ids.length);
      if (block.text) expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
    expect(view.blocks.length).toBeLessThanOrEqual(100);
  });
  it.each([
    ['zh-TW', 'background', '背景', '目前：背景', '背景尚無內容。'],
    ['zh-TW', 'requirement', '需求', '目前：需求', '需求尚無內容。'],
    ['zh-TW', 'notes', '備註', '目前：備註', '備註尚無內容。'],
    ['zh-TW', 'checks', '驗收清單', '目前：驗收清單', '驗收清單目前沒有項目。'],
    ['zh-TW', 'todos', '待辦清單', '目前：待辦清單', '待辦清單目前沒有項目。'],
    ['zh-CN', 'background', '背景', '当前：背景', '背景暂无内容。'],
    ['zh-CN', 'requirement', '需求', '当前：需求', '需求暂无内容。'],
    ['zh-CN', 'notes', '备注', '当前：备注', '备注暂无内容。'],
    ['zh-CN', 'checks', '验收清单', '当前：验收清单', '验收清单目前没有项目。'],
    ['zh-CN', 'todos', '待办清单', '当前：待办清单', '待办清单目前没有项目。'],
    ['en', 'background', 'Background', 'Current: Background', 'Background: no content yet.'],
    ['en', 'requirement', 'Requirements', 'Current: Requirements', 'Requirements: no content yet.'],
    ['en', 'notes', 'Notes', 'Current: Notes', 'Notes: no content yet.'],
    ['en', 'checks', 'Acceptance items', 'Current: Acceptance items', 'Acceptance items: no items yet.'],
    ['en', 'todos', 'To-do items', 'Current: To-do items', 'To-do items: no items yet.'],
  ] as const)('marks the active %s %s section and gives its specific empty message', (locale, kind, label, current, empty) => {
    const view = contextModal({ task, kind, page: 0, hasMore: false, rows: [], ...(['background', 'requirement', 'notes'].includes(kind) ? { text: '' } : {}) }, '', { ...actor, locale });
    const texts = view.blocks.filter((block: Row) => block.text).map((block: Row) => block.text.text);
    expect(texts.some((text: string) => text.startsWith(current + ' · '))).toBe(true);
    expect(texts).toContain(empty);
    const routes = buttonValues(view);
    expect(routes).toHaveLength(7);
    expect(routes.every((route: Row) => route.kind !== kind)).toBe(true);
    expect(routes).toContainEqual({ taskId: task.id, kind: kind === 'background' ? 'requirement' : 'background', page: 0 });
    const controls = view.blocks.flatMap((block: Row) => block.elements || []);
    expect(controls.some((control: Row) => control.action_id === 'livo_task_context' && control.text.text === label)).toBe(false);
    for (const block of view.blocks) {
      const ids = (block.elements || []).map((element: Row) => element.action_id).filter(Boolean);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
  it('has all fixed task-context messages in three locales', () => {
    const code = readFileSync(new URL('../../docker/volumes/functions/slack-interact/task-context.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('task-context.ts', code, ts.ScriptTarget.Latest, true);
    const keys: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'tr' && node.arguments[1]
        && ts.isStringLiteral(node.arguments[1])) keys.push(node.arguments[1].text);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    for (const key of keys) for (const locale of ['zh-TW', 'zh-CN', 'en'] as const)
      expect(WORKSPACE_MESSAGES[locale][key], `${locale}: ${key}`).toBeTruthy();
  });
});

describe('Task context interaction privacy and fresh sessions', () => {
  function actions() {
    const work: Promise<unknown>[] = [];
    const d = {
      taskContext: { read: vi.fn(async () => ({ task, kind: 'requirement', page: 0, hasMore: false, text: '<!channel> private text' })) },
      enabled: vi.fn(async () => true), actor: vi.fn(async () => actor),
      slack: vi.fn(async () => ({ view: { id: 'VEXAMPLE', hash: 'hash-example' } })),
      reply: vi.fn(), background: (promise: Promise<unknown>) => work.push(promise), link: () => 'https://livo.example/?task=EX-1',
    } as unknown as Actions;
    return { d, work };
  }
  it('refreshes identity before reading each private button page, never sending its body to Slack messages', async () => {
    const { d, work } = actions();
    const p = { type: 'block_actions', view: { id: 'VEXAMPLE', hash: 'old-hash' },
      actions: [{ action_id: 'livo_task_context', value: JSON.stringify({ taskId: task.id, kind: 'requirement', page: 1 }) }] };
    await handleTaskContextInteraction(p, d, actor);
    await Promise.all(work);
    expect(d.actor).toHaveBeenCalledWith(p);
    expect(d.taskContext!.read).toHaveBeenCalledWith(actor, expect.objectContaining({ taskId: task.id, kind: 'requirement', page: 1 }));
    expect(d.reply).not.toHaveBeenCalled();
    const calls = vi.mocked(d.slack).mock.calls;
    expect(calls.every(([method]) => ['views.open', 'views.update'].includes(method))).toBe(true);
    const view = calls.at(-1)![1].view;
    expect(view.blocks.filter((block: Row) => block.text).every((block: Row) => block.text.type === 'plain_text')).toBe(true);
  });
  it('does not read a saved context after Slack integration is disabled', async () => {
    const { d, work } = actions();
    vi.mocked(d.enabled).mockResolvedValue(false);
    await handleTaskContextInteraction({ command: '/livo', text: 'context EX-1', trigger_id: 'trigger-example' }, d, actor);
    await Promise.all(work);
    expect(d.taskContext!.read).not.toHaveBeenCalled();
    expect(d.reply).not.toHaveBeenCalled();
  });
  it('does not fall back to a channel message if the private view closes', async () => {
    const { d, work } = actions();
    vi.mocked(d.slack).mockResolvedValueOnce({ view: { id: 'VEXAMPLE' } }).mockRejectedValueOnce(new Error('closed'));
    await handleTaskContextInteraction({ command: '/livo', text: 'context EX-1', trigger_id: 'trigger-example' }, d, actor);
    await Promise.all(work);
    expect(d.reply).not.toHaveBeenCalled();
  });
});
