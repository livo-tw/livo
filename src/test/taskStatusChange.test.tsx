import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkStatusChange, missingRequiredStatuses, statusChangeUpdates, type StatusTransitionRule } from '@/lib/taskStatusChange';
import type { Status, StatusLog, Task } from '@/types';

const statuses = [
  { id: 'todo', name: 'To do', isDone: false, autoStart: false },
  { id: 'doing', name: 'Doing', isDone: false, autoStart: true },
  { id: 'review', name: 'Review', isDone: false, autoStart: false },
  { id: 'done', name: 'Done', isDone: true, autoStart: false },
] as Status[];
const rules: StatusTransitionRule[] = [{ id: 'rule-1', targetStatusId: 'done', requiredStatusId: 'review', createdAt: '2026-10-01T00:00:00Z' }];
const logs: StatusLog[] = [{ id: 'log-1', taskId: 'reviewed', fromStatusId: 'doing', toStatusId: 'review', changedBy: 'm1', changedAt: '2026-10-02T00:00:00Z' }];
const task = (id: string, more: Partial<Task> = {}) => ({ id, taskKey: id.toUpperCase(), title: id, statusId: 'todo', projectId: 'p1', priority: 'medium', ...more }) as Task;
const now = new Date('2026-10-04T08:00:00.000Z');

describe('one status change rule for every entry', () => {
  it('lists the statuses a task still has to pass through', () => {
    expect(missingRequiredStatuses(rules, 'fresh', 'done', logs)).toEqual(['review']);
    expect(missingRequiredStatuses(rules, 'reviewed', 'done', logs)).toEqual([]);
    expect(missingRequiredStatuses(rules, 'fresh', 'doing', logs)).toEqual([]);
  });

  it('checks a pending approval first, then the rules, then whether approval is required', () => {
    const check = (item: Task, to: string, approvalsEnabled = true) => checkStatusChange({ task: item, toStatusId: to, approvalsEnabled, rules, statusLogs: logs }).kind;
    expect(check(task('fresh'), 'todo')).toBe('same');
    expect(check(task('fresh', { approvalStatus: 'pending_approval' }), 'doing')).toBe('pending');
    expect(check(task('fresh', { requiresApproval: true }), 'done')).toBe('blocked');
    expect(check(task('reviewed', { requiresApproval: true }), 'done')).toBe('approval');
    expect(check(task('reviewed', { requiresApproval: true }), 'done', false)).toBe('direct');
    expect(check(task('fresh', { approvalStatus: 'pending_approval' }), 'doing', false)).toBe('direct');
  });

  it('writes the start date and completion time the same way everywhere', () => {
    expect(statusChangeUpdates(task('a'), statuses, 'doing', now)).toEqual({ statusId: 'doing', startedAt: '2026-10-04' });
    expect(statusChangeUpdates(task('a', { startedAt: '2026-09-01' }), statuses, 'doing', now)).toEqual({ statusId: 'doing' });
    expect(statusChangeUpdates(task('a', { statusId: 'review' }), statuses, 'done', now)).toEqual({ statusId: 'done', completedAt: now.toISOString() });
    const reopened = statusChangeUpdates(task('a', { statusId: 'done', completedAt: '2026-10-01T00:00:00Z' }), statuses, 'review', now);
    expect(reopened).toEqual({ statusId: 'review', completedAt: undefined });
    expect('completedAt' in reopened).toBe(true);
  });
});

const bulk = vi.hoisted(() => ({ tasks: [] as Task[], update: vi.fn(), warning: vi.fn(), error: vi.fn(), log: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values?.count !== undefined ? `${key}:${values.count}` : key }),
  initReactI18next: { type: '3rdParty', init: (): void => undefined },
}));
vi.mock('sonner', () => ({ toast: { warning: bulk.warning, error: bulk.error, success: vi.fn(), info: vi.fn() } }));
// Announcements have their own tests (taskFlows.test.tsx).
vi.mock('@/hooks/useTaskAnnouncements', () => ({ useTaskAnnouncements: () => ({ actor: null as null, users: [] as never[], projects: [] as never[], statuses: [] as never[] }) }));
vi.mock('@/lib/taskAnnouncements', () => ({ announceStatusChange: vi.fn(), announceAssignment: vi.fn() }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ approvalsEnabled: true }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: bulk.tasks, statuses, statusLogs: logs, updateTaskInDb: bulk.update, setAllTasks: vi.fn() }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as never[] }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'm1', permissions: {} }) }));
vi.mock('@/lib/activityLog', () => ({ logActivity: bulk.log }));
vi.mock('@/hooks/useUndoStack', () => ({ useUndoStack: () => ({ push: vi.fn() }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => ({ select: async () => ({
  data: [{ id: 'rule-1', target_status_id: 'done', required_status_id: 'review', created_at: '2026-10-01T00:00:00Z' }], error: null as null,
}) }) } }));
import { BulkActionBar } from '@/components/BulkActionBar';

describe('bulk status change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bulk.update.mockResolvedValue(true);
    bulk.tasks = [
      task('reviewed', { statusId: 'review' }),
      task('needs-approval', { statusId: 'review', requiresApproval: true }),
      task('fresh'),
      task('waiting', { statusId: 'review', approvalStatus: 'pending_approval' }),
    ];
  });

  it('changes only the tasks a single change would allow, with the same fields, and says what it left', async () => {
    render(<BulkActionBar selectedIds={new Set(bulk.tasks.map(item => item.id))} onClearSelection={vi.fn()} />);
    // The rules load once for the whole app; wait until the bar has them.
    await waitFor(() => expect(screen.getAllByRole('combobox')[0]).toBeEnabled());
    await new Promise(resolve => setTimeout(resolve, 0));
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'done' } });
    await waitFor(() => expect(bulk.warning).toHaveBeenCalledWith('bulkAction.statusSkipped:3', expect.anything()));
    expect(bulk.update).toHaveBeenCalledTimes(1);
    expect(bulk.update).toHaveBeenCalledWith('reviewed', expect.objectContaining({ statusId: 'done', completedAt: expect.any(String) }));
    expect(bulk.log).toHaveBeenCalledWith('m1', 'bulk_update_status', 'activity.bulkUpdateStatus:1');
  });

  it('reports saves that failed instead of a plain success', async () => {
    bulk.update.mockResolvedValue(false);
    bulk.tasks = [task('a', { statusId: 'doing' }), task('b', { statusId: 'doing' })];
    render(<BulkActionBar selectedIds={new Set(['a', 'b'])} onClearSelection={vi.fn()} />);
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'review' } });
    await waitFor(() => expect(bulk.error).toHaveBeenCalledWith('bulkAction.statusPartialFailed:2'));
    expect(bulk.log).not.toHaveBeenCalled();
  });
});
