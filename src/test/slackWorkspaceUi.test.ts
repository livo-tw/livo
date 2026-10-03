// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { detailModal, editModal, homeModal, listModal, parseEditSubmission, parseWorkspaceCommand, searchModal,
  TASK_PAGE_SIZE, type TaskQuery } from '../../docker/volumes/functions/slack-interact/workspace-ui';
import type { Row } from '../../docker/volumes/functions/slack-interact/core';
import { WORKSPACE_MESSAGES, workspaceText } from '../../docker/volumes/functions/slack-interact/workspace-i18n';
import { WORKSPACE_ERRORS } from '../../docker/volumes/functions/slack-interact/workspace-backend';

const source = { team: 'TEXAMPLE', channel: 'CEXAMPLE', thread: '1.0001', user: 'UEXAMPLE', locale: 'zh-TW' };
const task = { id: 'task-example', task_key: 'GAME-123', title: '調整畫面', status_id: 'todo', status_name: '待辦',
  assignee_id: 'member-a', assignee_name: '甲', reviewer_id: 'member-b', reviewer_name: '乙', priority: 'high',
  due_date: '2026-10-10', project_name: 'Fish Game', requirement: '<p>第一行</p><p>第二行</p>' };
const buttons = (view: Row, action?: string): Row[] => view.blocks.flatMap((block: Row) => block.elements || [])
  .filter((element: Row) => element.type === 'button' && (!action || element.action_id === action));
const input = (view: Row, id: string): Row => view.blocks.find((block: Row) => block.block_id === id)?.element;
const submission = (values: Row, metadata: Row = JSON.parse(editModal(task, source).private_metadata)): Row => ({
  callback_id: 'livo_edit_task', private_metadata: JSON.stringify(metadata), state: { values },
});
const select = (id: string | null) => ({ selected_option: id === null ? null : { value: id } });

describe('Slack workspace Traditional Chinese, Simplified Chinese and English', () => {
  it('keeps all three resource key sets and template variables complete', () => {
    const keys = Object.keys(WORKSPACE_MESSAGES['zh-TW']).sort();
    for (const locale of ['zh-TW', 'zh-CN', 'en'] as const) {
      expect(Object.keys(WORKSPACE_MESSAGES[locale]).sort()).toEqual(keys);
      for (const key of keys) {
        const translated = WORKSPACE_MESSAGES[locale][key];
        expect(translated.trim(), `${locale}: ${key}`).not.toBe('');
        expect([...translated.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort())
          .toEqual([...key.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort());
      }
    }
    for (const error of Object.values(WORKSPACE_ERRORS)) expect(keys).toContain(error);
  });
  it('covers every literal UI translation call with a shared dictionary key', () => {
    const code = readFileSync(new URL('../../docker/volumes/functions/slack-interact/workspace-ui.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('workspace-ui.ts', code, ts.ScriptTarget.Latest, true);
    const keys: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'tr') {
        const key = node.arguments[1];
        if (key && ts.isStringLiteral(key)) keys.push(key.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(keys.length).toBeGreaterThan(50);
    for (const key of keys) expect(WORKSPACE_MESSAGES['zh-CN'], key).toHaveProperty(key);
  });
  it('renders Simplified Chinese controls without translating user-authored data', () => {
    const cn = { ...source, locale: 'zh-CN' };
    expect(buttons(homeModal(cn), 'livo_workspace_query')[0].text.text).toBe('我的任务');
    expect(searchModal(cn).title.text).toBe('搜索 LIVO 卡片');
    expect(input(editModal(task, cn), 'assignee').action_id).toBe('assignee');
    expect(editModal(task, cn).blocks.find((block: Row) => block.block_id === 'assignee').label.text).toBe('经办人');
    const view = detailModal({ ...task, project_name: '研發專案', assignee_name: '陳經辦', reviewer_name: '驗收名',
      requirement: '使用者需求說明' }, '', cn, { comments: [{ content: '<p>使用者留言內容</p>' }], page: 1, hasMore: true });
    const rendered = JSON.stringify(view.blocks);
    expect(rendered).toContain('*项目* 研發專案');
    expect(rendered).toContain('*经办人* 陳經辦');
    expect(rendered).toContain('*验收人* 驗收名');
    expect(rendered).toContain('調整畫面');
    expect(rendered).toContain('使用者需求說明');
    expect(rendered).toContain('使用者留言內容');
    expect(rendered).toContain('第 2 页（新到旧）');
    const invalid = submission({ status: { status: select(null) } }, JSON.parse(editModal(task, cn).private_metadata));
    expect(parseEditSubmission(invalid).errors.status).toBe('请选择状态');
  });
  it('normalizes locale variants and substitutes values without converting them', () => {
    for (const locale of ['zh-CN', 'zh_CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN'])
      expect(workspaceText('我的任務', locale)).toBe('我的任务');
    for (const locale of ['zh-TW', 'zh-HK', 'zh-Hant', 'fr-FR'])
      expect(workspaceText('我的任務', locale)).toBe('我的任務');
    expect(workspaceText('我的任務', 'en-US')).toBe('My tasks');
    expect(workspaceText('第 {page} 頁', 'en-GB', { page: 3 })).toBe('Page 3');
    expect(workspaceText('經辦：{assignee} · 驗收：{reviewer}', 'zh-CN', { assignee: '經辦名字', reviewer: '驗收名字' }))
      .toBe('经办：經辦名字 · 验收：驗收名字');
    expect(workspaceText('使用者的專案名稱與任務內容', 'zh-CN')).toBe('使用者的專案名稱與任務內容');
  });
});

describe('Slack workspace command parsing', () => {
  it.each(['', ' home ', 'DASHBOARD'])('opens the private task workspace for %j', command => {
    expect(parseWorkspaceCommand(command)).toEqual({ kind: 'home' });
  });
  it.each(['my', 'review', 'today', 'due', 'overdue'])('starts %s at page zero', kind => {
    expect(parseWorkspaceCommand(kind.toUpperCase())).toEqual({ kind: 'query', query: { kind, page: 0 } });
  });
  it('searches multilingual title fragments and decodes Slack escaping only once', () => {
    expect(parseWorkspaceCommand('search 魚場 &lt;API&gt; &amp; UI')).toEqual({ kind: 'query', query: {
      kind: 'search', text: '魚場 <API> & UI', page: 0,
    } });
    expect(parseWorkspaceCommand('search &amp;lt;tag&amp;gt;')).toMatchObject({ query: { text: '&lt;tag&gt;' } });
    expect(parseWorkspaceCommand('search')).toEqual({ kind: 'search' });
    expect(parseWorkspaceCommand('search ' + '字'.repeat(200))).toMatchObject({ query: { text: '字'.repeat(100) } });
  });
  it('accepts card keys without accidentally handling existing commands or malformed keys', () => {
    expect(parseWorkspaceCommand(' game-123 ')).toEqual({ kind: 'show', key: 'GAME-123' });
    expect(parseWorkspaceCommand('show game-123')).toEqual({ kind: 'show', key: 'GAME-123' });
    expect(parseWorkspaceCommand('edit game-123')).toEqual({ kind: 'edit', key: 'GAME-123' });
    for (const value of ['new Create title', 'comment GAME-123 Example', 'help', 'my other', 'edit', 'show GAME-123 injected'])
      expect(parseWorkspaceCommand(value)).toBeUndefined();
  });
});

describe('Private Slack task views', () => {
  it('offers each common operation without publishing results to a channel', () => {
    const view = homeModal(source), queries = buttons(view, 'livo_workspace_query').map(item => JSON.parse(item.value).kind);
    expect(queries).toEqual(['my', 'review', 'today', 'due', 'overdue']);
    expect(view.type).toBe('modal');
    expect(buttons(view).map(item => item.action_id)).toContain('livo_workspace_search');
    expect(buttons(view).map(item => item.action_id)).toContain('livo_workspace_new');
    expect(JSON.parse(view.private_metadata)).toEqual(source);
    expect(view).not.toHaveProperty('response_type');
    expect(searchModal(source).callback_id).toBe('livo_search_tasks');
    expect(input(searchModal(source), 'query')).toMatchObject({ max_length: 100, min_length: 1 });
  });
  it('shows bounded pages, preserves a private search, and gives safe previous/next arguments', () => {
    const query: TaskQuery = { kind: 'search', text: '<@UOTHER> & 調整', page: 1 };
    const page = { tasks: Array.from({ length: 20 }, (_, i) => ({ ...task, id: `task-${i}` })), page: 1, hasMore: true };
    const view = listModal(query, page, source);
    expect(buttons(view, 'livo_task_open')).toHaveLength(TASK_PAGE_SIZE);
    expect(buttons(view, 'livo_tasks_page').map(item => JSON.parse(item.value))).toEqual([
      { ...query, page: 0 }, { ...query, page: 2 },
    ]);
    expect(JSON.parse(view.private_metadata)).toEqual({ ...source, query });
    const renderedText = view.blocks.map((block: Row) => block.text?.text || '').join('\n');
    expect(renderedText).not.toContain('<@UOTHER>');
    expect(renderedText).toContain('&lt;@UOTHER&gt;');
    expect(buttons(listModal({ kind: 'my', page: 0 }, { tasks: [], page: 0, hasMore: false }, source), 'livo_tasks_page')).toHaveLength(0);
  });
  it('clearly reports an empty list and does not show a misleading next page', () => {
    const view = listModal({ kind: 'review', page: 0 }, { tasks: [], page: 0, hasMore: false }, source);
    expect(JSON.stringify(view.blocks)).toContain('目前沒有符合條件的卡片');
    expect(buttons(view, 'livo_task_open')).toHaveLength(0);
    expect(buttons(view, 'livo_tasks_page')).toHaveLength(0);
  });
  it('renders detail, strips HTML safely, and keeps the card id in every operation', () => {
    const view = detailModal({ ...task, title: '保留 <@UOTHER> & 顯示', requirement: '<script>BAD_SCRIPT</script><p>合法內容</p>' },
      'https://example.com/?task=GAME-123', source);
    expect(JSON.stringify(view.blocks)).not.toContain('<@UOTHER>');
    expect(JSON.stringify(view.blocks)).not.toContain('BAD_SCRIPT');
    expect(JSON.stringify(view.blocks)).toContain('合法內容');
    for (const item of buttons(view).filter(item => ['livo_task_edit', 'livo_task_comment'].includes(item.action_id)))
      expect(JSON.parse(item.value)).toEqual({ taskId: task.id });
    expect(buttons(view).find(item => item.url)?.url).toBe('https://example.com/?task=GAME-123');
    expect(JSON.parse(view.private_metadata)).toEqual({ ...source, taskId: task.id });
    expect(buttons(detailModal(task, 'javascript:alert(1)', source)).some(item => item.url)).toBe(false);
  });
  it('shows recent comments with Taipei timestamps and independent pagination', () => {
    const comments = { comments: Array.from({ length: 10 }, () => ({ author_name: 'Alice <@UOTHER>', content: '<p>Comment</p>',
      created_at: '2026-10-01T18:30:00Z' })), page: 1, hasMore: true };
    const view = detailModal(task, '', source, comments);
    expect(view.blocks.filter((block: Row) => block.text?.text?.includes('Comment'))).toHaveLength(TASK_PAGE_SIZE);
    expect(JSON.stringify(view.blocks)).toContain('10/02 02:30');
    expect(JSON.stringify(view.blocks)).not.toContain('<@UOTHER>');
    expect(buttons(view, 'livo_comments_page').map(item => JSON.parse(item.value))).toEqual([
      { taskId: task.id, page: 0 }, { taskId: task.id, page: 2 },
    ]);
    expect(JSON.stringify(detailModal(task, '', source, { comments: [], page: 0, hasMore: false }).blocks)).toContain('目前沒有留言');
  });
  it('keeps Slack block lengths and action ids valid even for escaped long content', () => {
    const veryLong = { ...task, title: '&'.repeat(5000), requirement: '&'.repeat(10000), assignee_name: '&'.repeat(2000) };
    const views = [homeModal(source), searchModal(source), editModal(veryLong, source),
      listModal({ kind: 'my', page: 1 }, { tasks: Array(8).fill(veryLong), page: 1, hasMore: true }, source),
      detailModal(veryLong, '', source, { comments: Array(8).fill({ content: '&'.repeat(5000) }), page: 1, hasMore: true })];
    for (const view of views) {
      expect(view.title.text.length).toBeLessThanOrEqual(24);
      expect(view.private_metadata.length).toBeLessThanOrEqual(3000);
      expect(view.blocks.length).toBeLessThanOrEqual(100);
      for (const block of view.blocks) {
        if (block.text) expect(block.text.text.length).toBeLessThanOrEqual(3000);
        if (block.type === 'actions') expect(new Set(block.elements.map((item: Row) => item.action_id)).size)
          .toBe(block.elements.filter((item: Row) => item.action_id).length + block.elements.filter((item: Row) => !item.action_id).length);
      }
    }
  });
  it('uses English labels without changing stored values', () => {
    const view = editModal(task, { ...source, locale: 'en-US' });
    expect(view.title.text).toBe('Edit LIVO card');
    expect(input(view, 'priority').initial_option).toMatchObject({ value: 'high', text: { text: 'High' } });
    expect(homeModal({ locale: 'en-US' }).blocks[0].text.text).toContain('Manage your tasks');
  });
});

describe('Slack task edit form contract', () => {
  it('retains the actual priority and all five baseline values for conflict detection', () => {
    const view = editModal(task, source);
    expect(input(view, 'priority').initial_option.value).toBe('high');
    expect(input(view, 'reviewer').initial_option.value).toBe('member-b');
    expect(input(view, 'due')).toBeUndefined();
    expect(JSON.stringify(view)).toContain('livo_deadline_open');
    expect(JSON.parse(view.private_metadata).expected).toEqual({ status_id: 'todo', assignee_id: 'member-a',
      reviewer_id: 'member-b', priority: 'high', due_date: '2026-10-10' });
    expect(JSON.parse(editModal({ ...task, assignee_id: null, reviewer_id: null, due_date: null }, source).private_metadata).expected)
      .toMatchObject({ assignee_id: null, reviewer_id: null, due_date: null });
  });
  it('sends only changed fields and never treats an omitted control as a clear', () => {
    const result = parseEditSubmission(submission({ status: { status: select('in-progress') }, priority: { priority: select('high') } }));
    expect(result.errors).toEqual({});
    expect(result.fields).toMatchObject({ task_id: task.id, changes: { status_id: 'in-progress' } });
    expect(result.fields.expected).toHaveProperty('reviewer_id', 'member-b');
  });
  it('uses JSON null for explicit clearing of nullable fields', () => {
    const result = parseEditSubmission(submission({ assignee: { assignee: select(null) }, reviewer: { reviewer: select(null) },
      due: { due: { selected_date: null } } }));
    expect(result.errors).toEqual({});
    expect(result.fields.changes).toEqual({ assignee_id: null, reviewer_id: null, due_date: null });
  });
  it('returns a field error for unchanged forms', () => {
    const result = parseEditSubmission(submission({ priority: { priority: select('high') }, due: { due: { selected_date: '2026-10-10' } } }));
    expect(result.fields.changes).toEqual({});
    expect(result.errors.status).toContain('尚未變更');
  });
  it.each(['2026-02-30', '2026-13-01', '2026-2-01', 'tomorrow'])('rejects impossible date %s', date => {
    expect(parseEditSubmission(submission({ due: { due: { selected_date: date } } })).errors.due).toBe('日期格式不正確');
  });
  it('accepts a valid leap day but rejects missing required selections', () => {
    expect(parseEditSubmission(submission({ due: { due: { selected_date: '2028-02-29' } } })).errors).toEqual({});
    expect(parseEditSubmission(submission({ status: { status: select(null) }, priority: { priority: select('urgent') } })).errors)
      .toEqual({ status: '請選擇狀態', priority: '請選擇優先級' });
  });
  it('rejects malformed or incomplete baseline metadata before a write', () => {
    expect(parseEditSubmission({ private_metadata: '{' }).errors.status).toContain('已失效');
    expect(parseEditSubmission(submission({}, { taskId: task.id, expected: { status_id: 'todo' } })).errors.status).toContain('已失效');
    expect(parseEditSubmission(submission({}, { expected: JSON.parse(editModal(task).private_metadata).expected })).errors.status).toContain('已失效');
  });
});
