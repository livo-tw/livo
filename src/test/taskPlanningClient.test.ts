import { beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: db }));
import { getTaskReminder, listTaskReminderPreferences, planningErrorCode, setTaskDeadline, setTaskReminder, type TaskReminder } from '@/lib/taskPlanning/client';
const row = (id: string): TaskReminder => ({ id, task_id: 'task1', member_id: 'me', snoozed_until: null, version: 1, updated_at: '2026-10-01T00:00:00.000Z' });
beforeEach(() => vi.clearAllMocks());
describe('planning client scope and command boundaries', () => {
  it('keeps personal task reads scoped by both task and member', async () => {
    const q = { select: vi.fn(() => q), eq: vi.fn(() => q), limit: vi.fn().mockResolvedValue({ data: [row('pref1')], error: null }) };
    db.from.mockReturnValue(q);
    expect(await getTaskReminder('task1', 'me')).toEqual(row('pref1'));
    expect(q.eq.mock.calls).toEqual([['task_id', 'task1'], ['member_id', 'me']]);
  });
  it('loads all reminder pages with stable ordering rather than silently stopping at the backend limit', async () => {
    const q = { select: () => q, eq: vi.fn(() => q), order: vi.fn(() => q), range: vi.fn().mockResolvedValueOnce({ data: Array.from({ length: 500 }, (_, i) => row(String(i))), error: null }).mockResolvedValueOnce({ data: [row('last')], error: null }) };
    db.from.mockReturnValue(q);
    expect(await listTaskReminderPreferences('me')).toHaveLength(501);
    expect(q.range.mock.calls).toEqual([[0, 499], [500, 999]]); expect(q.order).toHaveBeenCalledWith('id');
    expect(q.eq.mock.calls).toEqual([['member_id', 'me'], ['member_id', 'me']]);
  });
  it('cannot bypass committed postponement validation or supply an actor to a command', async () => {
    const before = { dueDate: '2026-10-10', kind: 'committed' as const, version: 4 };
    await expect(setTaskDeadline('task1', before, null, null, null)).rejects.toMatchObject({ code: 'planning_reason_required' });
    expect(db.rpc).not.toHaveBeenCalled();
    db.rpc.mockResolvedValue({ data: { id: 'task1', due_date: '2026-10-12', due_date_kind: 'estimated', due_date_version: 5, started_at: '2026-10-01T10:00:00.000Z' }, error: null });
    await setTaskDeadline('task1', before, '2026-10-12', 'estimated', 'Dependency changed');
    expect(db.rpc).toHaveBeenCalledWith('livo_set_task_deadline', { p_task_id: 'task1', p_expected_version: 4, p_due_date: '2026-10-12', p_kind: 'estimated', p_reason: 'Dependency changed' });
  });
  it('combines start and due edits using the original start timestamp as the comparison value', async () => {
    db.rpc.mockResolvedValue({ data: { id: 'task1', due_date: '2026-10-12', due_date_kind: null, due_date_version: 5, started_at: '2026-10-02' }, error: null });
    await setTaskDeadline('task1', { dueDate: '2026-10-10', kind: null, version: 4 }, '2026-10-12', null, null, { before: '2026-10-01T10:00:00.000Z', next: '2026-10-02' });
    expect(db.rpc.mock.calls[0][1]).toMatchObject({ p_change_start: true, p_expected_started_at: '2026-10-01T10:00:00.000Z', p_started_at: '2026-10-02' });
  });
  it('does not expose arbitrary server errors and preserves only recognized conflicts', async () => {
    expect(planningErrorCode({ message: 'sensitive-internal-detail' })).toBe('planning_unavailable');
    db.rpc.mockResolvedValue({ data: null, error: { message: 'planning_conflict' } });
    await expect(setTaskReminder('task1', 2, null)).rejects.toMatchObject({ code: 'planning_conflict' });
    expect(db.rpc).toHaveBeenCalledWith('livo_set_task_reminder', { p_task_id: 'task1', p_expected_version: 2, p_until: null });
  });
});
