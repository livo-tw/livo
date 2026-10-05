import { describe, expect, it } from 'vitest';
import { qaBoardSort, sortBoardTasks, type BoardSort } from '@/lib/boardSort';
import { compareQaIssues, matchesQaListFilters, normalizeQaListFilters, QaError, type QaIssue, type QaListInput } from '@/lib/qa/domain';
import { scopedProjectIds, sidebarEntry, viewAfterScopeChange } from '@/hooks/useProjectScope';
import type { Task } from '@/types';

const id = (value: unknown) => { if (typeof value !== 'string' || !/^[a-z0-9-]+$/.test(value)) throw new QaError('qa_invalid_id'); return value; };
const task = (key: string, fields: Partial<Task>) => ({ id: key, taskKey: key, title: key, priority: 'medium', createdAt: '2026-09-01T00:00:00Z', ...fields }) as Task;
const issue = (key: string, priority: number, dueDate: string | null, createdAt: string, updatedAt: string, more: Partial<QaIssue> = {}) =>
  ({ id: key, projectId: 'p1', priority, severity: 'medium', dueDate, createdAt, updatedAt, assigneeId: 'm1', qaOwnerId: 'm2', reporterId: 'm3', ...more }) as QaIssue;
const qaOrder = (issues: QaIssue[], sort: QaListInput['sort'], direction: 'asc' | 'desc') => [...issues].sort((a, b) => compareQaIssues(a, b, sort!, direction)).map(item => item.id);

describe('task board sort', () => {
  const tasks = [
    task('a', { priority: 'low', dueDate: undefined, createdAt: '2026-09-01T00:00:00Z' }),
    task('b', { priority: 'highest', dueDate: '2026-10-20', createdAt: '2026-09-03T00:00:00Z' }),
    task('c', { priority: 'medium', dueDate: '2026-10-10', createdAt: '2026-09-02T00:00:00Z' }),
    task('d', { priority: 'highest', dueDate: undefined, createdAt: '2026-09-04T00:00:00Z' }),
  ];
  const order = (sort: BoardSort) => sortBoardTasks(tasks, sort).map(item => item.id);
  it('keeps the loaded order by default', () => expect(order({ field: 'default', direction: 'desc' })).toEqual(['a', 'b', 'c', 'd']));
  it('lists the most important first, ties in loaded order', () => {
    expect(order({ field: 'priority', direction: 'desc' })).toEqual(['b', 'd', 'c', 'a']);
    expect(order({ field: 'priority', direction: 'asc' })).toEqual(['a', 'c', 'b', 'd']);
  });
  it('keeps tasks without a due date last in both directions', () => {
    expect(order({ field: 'dueDate', direction: 'asc' })).toEqual(['c', 'b', 'a', 'd']);
    expect(order({ field: 'dueDate', direction: 'desc' })).toEqual(['b', 'c', 'a', 'd']);
  });
  it('sorts by creation time', () => expect(order({ field: 'createdAt', direction: 'desc' })).toEqual(['d', 'b', 'c', 'a']));
  it('maps the QA default to the server default', () => {
    expect(qaBoardSort({ field: 'default', direction: 'desc' })).toEqual({});
    expect(qaBoardSort({ field: 'dueDate', direction: 'asc' })).toEqual({ sort: 'dueDate', direction: 'asc' });
  });
});

describe('QA list order shared by D1, PostgreSQL and the demo client', () => {
  // The same four rows were ordered by PostgREST 14.6 on a real self-host stack;
  // these expectations are that output.
  const rows = [
    issue('qa-a', 3, null, '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', { severity: 'high' }),
    issue('qa-b', 1, '2026-10-20', '2026-09-03T00:00:00.000Z', '2026-10-02T00:00:00.000Z', { severity: 'low', qaOwnerId: null }),
    issue('qa-c', 5, '2026-10-10', '2026-09-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z', { projectId: 'p2', assigneeId: 'm4', reporterId: 'm1' }),
    issue('qa-d', 1, null, '2026-09-04T00:00:00.000Z', '2026-10-03T00:00:00.000Z', { projectId: 'p2', assigneeId: null, qaOwnerId: null, severity: 'untriaged' }),
  ];
  it.each([
    ['updated', 'desc', ['qa-c', 'qa-d', 'qa-b', 'qa-a']],
    ['priority', 'desc', ['qa-d', 'qa-b', 'qa-a', 'qa-c']],
    ['priority', 'asc', ['qa-c', 'qa-a', 'qa-d', 'qa-b']],
    ['dueDate', 'asc', ['qa-c', 'qa-b', 'qa-d', 'qa-a']],
    ['dueDate', 'desc', ['qa-b', 'qa-c', 'qa-d', 'qa-a']],
    ['createdAt', 'desc', ['qa-d', 'qa-b', 'qa-c', 'qa-a']],
  ] as const)('%s %s', (sort, direction, expected) => expect(qaOrder(rows, sort, direction)).toEqual(expected));
  it('filters like the servers', () => {
    const match = (input: QaListInput) => rows.filter(row => matchesQaListFilters(row, normalizeQaListFilters(input, id))).map(row => row.id);
    expect(match({ priorities: [1, 3] })).toEqual(['qa-a', 'qa-b', 'qa-d']);
    expect(match({ severities: ['high', 'low'] })).toEqual(['qa-a', 'qa-b']);
    expect(match({ assigneeIds: ['m1', 'm4'], projectIds: ['p1'] })).toEqual(['qa-a', 'qa-b']);
    expect(match({ qaOwnerIds: ['m2'] })).toEqual(['qa-a', 'qa-c']);
    expect(match({ reporterIds: ['m1'] })).toEqual(['qa-c']);
  });
  it('rejects empty, duplicate or unknown values instead of guessing', () => {
    for (const input of [{ assigneeIds: [] }, { assigneeIds: ['m1', 'm1'] }, { priorities: [0] }, { priorities: [6] }, { severities: ['critical'] },
      { sort: 'title' }, { direction: 'up' }, { projectIds: ['bad id'] }] as unknown as QaListInput[])
      expect(() => normalizeQaListFilters(input, id)).toThrow();
    expect(normalizeQaListFilters({}, id)).toMatchObject({ sort: 'updated', direction: 'desc' });
    expect(normalizeQaListFilters({ sort: 'dueDate' }, id)).toMatchObject({ direction: 'asc' });
  });
});

describe('sidebar project scope', () => {
  const projects = [{ id: 'p1', lineId: 'l1' }, { id: 'p2', lineId: 'l1' }, { id: 'p3', lineId: 'l2' }];
  it('is one project, one product line, or everything', () => {
    expect(scopedProjectIds(projects, 'p3', 'l1')).toEqual(new Set(['p3']));
    expect(scopedProjectIds(projects, null, 'l1')).toEqual(new Set(['p1', 'p2']));
    expect(scopedProjectIds(projects, null, null)).toBeNull();
  });
  it('keeps the current page when the scope changes, with one rule for every entry', () => {
    // Picking a project or product line: every scoped view stays; my QA becomes the project's QA.
    for (const view of ['dashboard', 'gantt', 'board', 'backlog', 'all-list', 'my-tasks', 'knowledge-base', 'qa'])
      expect(viewAfterScopeChange(view, 'scope')).toBe(view);
    expect(viewAfterScopeChange('my-qa', 'scope')).toBe('qa');
    expect(viewAfterScopeChange('team-intro', 'scope')).toBe('board');
    expect(viewAfterScopeChange('work-report', 'scope')).toBe('board');
    // "All tasks": task views stay, anything else opens the board.
    expect(viewAfterScopeChange('dashboard', 'all')).toBe('dashboard');
    expect(viewAfterScopeChange('qa', 'all')).toBe('board');
    expect(viewAfterScopeChange('knowledge-base', 'all')).toBe('board');
  });
});

describe('sidebar highlight', () => {
  it('highlights exactly one entry', () => {
    // The knowledge base of a selected project lights the project, not also the workspace entry.
    expect(sidebarEntry('knowledge-base', true)).toBe('scope');
    expect(sidebarEntry('knowledge-base', false)).toBe('knowledge-base');
    expect(sidebarEntry('qa', true)).toBe('scope');
    expect(sidebarEntry('my-qa', false)).toBe('my-qa');
    // Every task view without a scope lights "All tasks", the backlog included.
    for (const view of ['board', 'backlog', 'all-list', 'gantt', 'dashboard', 'my-tasks']) expect(sidebarEntry(view, false)).toBe('all-tasks');
    // Views that ignore the scope light only their own entry.
    for (const view of ['team-intro', 'approvals', 'system-admin', 'work-report', 'releases']) expect(sidebarEntry(view, true)).toBeNull();
  });
});

