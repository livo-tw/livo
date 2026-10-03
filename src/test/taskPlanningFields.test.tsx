import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/types';
import { TaskPlanningError, pauseThroughDay } from '@/lib/taskPlanning/core';
const api = vi.hoisted(() => ({ get: vi.fn(), deadline: vi.fn(), reminder: vi.fn(), history: vi.fn() }));
vi.mock('@/lib/taskPlanning/client', () => ({
  getTaskReminder: api.get, setTaskDeadline: api.deadline, setTaskReminder: api.reminder, getTaskDeadlineHistory: api.history,
  planningErrorCode: (error: { code?: string }) => error.code || 'planning_unavailable',
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, args?: { until?: string }) => args?.until ? `${key}: ${args.until}` : key, i18n: { language: 'en' } }) }));
vi.mock('@/components/task-detail/fields/DatePickerField', () => ({ default: ({ onChange }: { onChange: (value: string) => void }) => <button onClick={() => onChange('2026-10-12')}>Pick later date</button> }));
import TaskPlanningFields from '@/components/task-detail/fields/TaskPlanningFields';
const task = { id: 'task1', title: 'Example', dueDate: '2026-10-10', dueDateKind: 'committed', dueDateVersion: 4 } as Task;
const row = (member: string, until: string | null = null) => ({ id: member, task_id: 'task1', member_id: member, version: 2, snoozed_until: until, updated_at: '2026-10-01T00:00:00.000Z' });
beforeEach(() => { vi.clearAllMocks(); api.get.mockResolvedValue(null); api.history.mockResolvedValue([]); api.reminder.mockResolvedValue(row('me')); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('task deadline and personal reminder controls', () => {
  it('requires a postponement reason even after a downgrade and retains the displayed revision on conflict', async () => {
    api.deadline.mockRejectedValue(new TaskPlanningError('planning_conflict'));
    const onSaved = vi.fn();
    const view = render(<TaskPlanningFields task={task} memberId="me" users={[]} onSaved={onSaved} />);
    fireEvent.click(screen.getByText('Pick later date'));
    fireEvent.change(screen.getByLabelText('taskPlanning.kind'), { target: { value: 'estimated' } });
    expect(screen.getByText('common.save')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('taskPlanning.reasonRequired'), { target: { value: 'Waiting for a dependency' } });
    fireEvent.click(screen.getByText('common.save'));
    await screen.findByRole('alert');
    view.rerender(<TaskPlanningFields task={{ ...task, dueDateVersion: 9, dueDate: '2026-10-11' }} memberId="me" users={[]} onSaved={onSaved} />);
    fireEvent.click(screen.getByText('common.save'));
    await waitFor(() => expect(api.deadline).toHaveBeenCalledTimes(2));
    expect(api.deadline.mock.calls[1]).toEqual(['task1', { dueDate: '2026-10-10', kind: 'committed', version: 4 }, '2026-10-12', 'estimated', 'Waiting for a dependency']);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText('taskPlanning.reasonRequired')).toHaveValue('Waiting for a dependency');
  });
  it('does not show a prior member preference when an earlier request finishes after a switch', async () => {
    let resolveOld!: (value: ReturnType<typeof row>) => void;
    api.get.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(row('other'));
    const view = render(<TaskPlanningFields task={task} memberId="me" users={[]} onSaved={vi.fn()} />);
    view.rerender(<TaskPlanningFields task={task} memberId="other" users={[]} onSaved={vi.fn()} />);
    await screen.findByText('taskPlanning.reminderActive');
    await act(async () => resolveOld(row('me', '2099-10-01T00:00:00.000Z')));
    expect(screen.queryByText(/taskPlanning.pausedUntil/)).toBeNull();
    expect(api.get).toHaveBeenLastCalledWith('task1', 'other');
  });
  it('pauses through the selected local day and uses only the current personal version', async () => {
    api.get.mockResolvedValue(row('me'));
    const options = new Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, timeZone: 'America/New_York' });
    render(<TaskPlanningFields task={task} memberId="me" users={[]} onSaved={vi.fn()} />);
    await screen.findByText('taskPlanning.reminderActive');
    const day = new Date(); day.setDate(day.getDate() + 1);
    const local = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    fireEvent.change(screen.getByLabelText('taskPlanning.pauseThrough'), { target: { value: local } });
    fireEvent.click(screen.getByText('taskPlanning.pause'));
    await waitFor(() => expect(api.reminder).toHaveBeenCalledWith('task1', 2, pauseThroughDay(local, 'America/New_York')));
  });
  it('shows recorded reasons as text and names only members from the current directory', async () => {
    api.history.mockResolvedValue([{ id: 'h1', actor_id: 'missing', previous_due_date: '2026-10-10', next_due_date: null, previous_kind: 'committed', next_kind: null, reason: '<script>example</script>', changed_at: '2026-10-01T00:00:00.000Z' }]);
    render(<TaskPlanningFields task={task} memberId={null} users={[]} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByText('taskPlanning.history'));
    expect(await screen.findByText('<script>example</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/taskPlanning.actorUnknown/)).toBeInTheDocument();
    expect(screen.queryByText('taskPlanning.personalReminder')).toBeNull();
  });
});
