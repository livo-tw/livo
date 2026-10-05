import { describe, expect, it, vi } from 'vitest';
import { assignmentBucket, buildMyAssignments, groupAssignments, loadMyQaAssignments } from '@/lib/myAssignments';
import type { Task, Status } from '@/types';
import type { QaIssue, QaListInput } from '@/lib/qa/domain';

const task = (id: string, overrides: Partial<Task> = {}): Task => ({ id, taskKey: id, title: id, projectId: 'example-project', statusId: 'open', priority: 'medium', assigneeId: 'example-member', creatorId: 'example-member', sortOrder: 0, createdAt: '2026-10-01', commentCount: 0, attachmentCount: 0, deployments: [], ...overrides } satisfies Task);
const issue = (id: string, overrides: Partial<QaIssue> = {}) => ({ id, title: id, projectId: 'example-project', assigneeId: 'example-member', qaOwnerId: 'example-tester', state: 'in_progress', priority: 3, dueDate: null, updatedAt: '2026-10-01', ...overrides } as QaIssue);
const statuses = [{ id: 'open', isDone: false }, { id: 'finished', isDone: true }] as Status[];

describe('my assigned cards', () => {
  it('combines responsibilities once, includes pending-close PASS and FAIL, and excludes finished/reported-only cards', () => {
    const owned = issue('dual', { qaOwnerId: 'example-member', state: 'verified' });
    const result = buildMyAssignments([task('dual-task', { reviewerId: 'example-member' }), task('review', { assigneeId: 'another-member', reviewerId: 'example-member' }), task('done', { statusId: 'finished' })], statuses,
      [owned, owned, issue('failed', { state: 'failed' }), issue('closed', { state: 'closed' }), issue('dismissed', { state: 'dismissed' }), issue('reported', { assigneeId: null, qaOwnerId: null, reporterId: 'example-member' })], 'example-member');
    expect(result.map(row => row.key).sort()).toEqual(['bug:dual', 'bug:failed', 'task:dual-task', 'task:review']);
    expect(result.find(row => row.id === 'dual')?.roles).toEqual(['fix', 'verify']);
    expect(result.find(row => row.id === 'dual-task')?.roles).toEqual(['assignee', 'reviewer']);
  });
  it('puts overdue and due-today cards first, then priority for cards without a due date', () => {
    const rows = buildMyAssignments([task('no-date-low', { priority: 'low' }), task('today', { dueDate: '2026-10-04' }), task('overdue', { dueDate: '2026-10-01' }), task('no-date-high', { priority: 'highest' })], statuses, [], 'example-member', new Date('2026-10-04T12:00:00'));
    expect(rows.map(row => row.id)).toEqual(['overdue', 'today', 'no-date-high', 'no-date-low']);
  });
  it('groups the sorted list into non-empty due-date sections without reordering', () => {
    const now = new Date('2026-10-04T12:00:00');
    const rows = buildMyAssignments([task('later', { dueDate: '2026-10-09' }), task('no-date'), task('overdue', { dueDate: '2026-10-01' }), task('later-soon', { dueDate: '2026-10-05' })], statuses, [], 'example-member', now);
    expect(groupAssignments(rows, now).map(group => [group.bucket, group.items.map(row => row.id)])).toEqual([
      ['overdue', ['overdue']], ['upcoming', ['later-soon', 'later']], ['none', ['no-date']]]);
    expect(groupAssignments([], now)).toEqual([]);
    expect([null, '2026-10-03', '2026-10-04', '2026-10-04T23:30:00', '2026-10-05', 'not a date'].map(value => assignmentBucket(value, now)))
      .toEqual(['none', 'overdue', 'today', 'today', 'upcoming', 'none']);
  });
  it('reads every QA page and deduplicates assignee/testing overlap', async () => {
    const records = Array.from({ length: 105 }, (_, index) => issue(`example-${index}`));
    const list = vi.fn(async (input: QaListInput) => input.mine === 'testing' ? { issues: records.slice(0, 3), total: 3, hasMore: false } : { issues: records.slice(input.offset, (input.offset || 0) + 100), total: records.length, hasMore: (input.offset || 0) + 100 < records.length });
    expect(await loadMyQaAssignments(list)).toHaveLength(105);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ mine: 'assigned', offset: 100 }), undefined);
  });
  it('rejects incomplete pages instead of presenting a false total', async () => {
    await expect(loadMyQaAssignments(async () => ({ issues: [], total: 12, hasMore: true }))).rejects.toThrow('incomplete_assignments');
    await expect(loadMyQaAssignments(async () => ({ issues: [issue('only-one')], total: 12, hasMore: false }))).rejects.toThrow('incomplete_assignments');
  });
  it('does not return a different member’s cards and respects cancellation', async () => {
    expect(buildMyAssignments([task('owned')], statuses, [issue('owned-bug')], 'unrelated-member')).toEqual([]);
    const controller = new AbortController(); controller.abort();
    const list = vi.fn(); await expect(loadMyQaAssignments(list, controller.signal)).rejects.toThrow('Aborted'); expect(list).not.toHaveBeenCalled();
  });
});
