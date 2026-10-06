import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/types';
const api = vi.hoisted(() => ({ insert: vi.fn(), existing: [] as { task_id: string }[], preferences: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: vi.fn((table: string) => {
  if (table !== 'notifications') throw new Error('Only notification queries are expected');
  const query = { select: () => query, eq: () => query, gte: async () => ({ data: api.existing, error: null as null }), insert: api.insert };
  return query;
}) } }));
vi.mock('@/lib/taskPlanning/client', () => ({ listTaskReminderPreferences: api.preferences }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/lib/reportGenerator', () => ({ generateReportContent: vi.fn() }));
import { useSideEffects } from '@/context/hooks/useSideEffects';

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-06T00:00:00Z'));
  api.existing = []; api.insert.mockResolvedValue({ error: null });
  api.preferences.mockResolvedValue([{ task_id: 'assigned', snoozed_until: '2099-01-01T00:00:00Z' }, { task_id: 'reviewed', snoozed_until: '2099-01-01T00:00:00Z' }]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const tasks = [
  { id: 'assigned', title: 'Example implementation', dueDate: '2026-10-07', assigneeId: 'member-example' },
  { id: 'reviewed', title: 'Example review', dueDate: '2026-10-07', reviewerId: 'member-example' },
  { id: 'unrelated', title: 'Other member work', dueDate: '2026-10-07', assigneeId: 'someone-else' },
  { id: 'later', title: 'Later work', dueDate: '2026-10-08', assigneeId: 'member-example' },
] as Task[];
describe('automatic due reminders after removing personal pauses', () => {
  it('uses the deadline and responsibility while ignoring stored pause preferences', async () => {
    renderHook(() => useSideEffects('member-example', tasks, []));
    await act(async () => vi.runAllTimersAsync());
    expect(api.insert).toHaveBeenCalledTimes(1);
    expect(api.insert.mock.calls[0][0].map((row: { task_id: string }) => row.task_id)).toEqual(['assigned', 'reviewed']);
    expect(api.preferences).not.toHaveBeenCalled();
  });
  it('keeps same-day notification deduplication', async () => {
    api.existing = [{ task_id: 'assigned' }];
    renderHook(() => useSideEffects('member-example', tasks, []));
    await act(async () => vi.runAllTimersAsync());
    expect(api.insert.mock.calls[0][0].map((row: { task_id: string }) => row.task_id)).toEqual(['reviewed']);
    expect(api.preferences).not.toHaveBeenCalled();
  });
});
