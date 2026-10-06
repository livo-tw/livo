import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/types';
import { TaskPlanningError } from '@/lib/taskPlanning/core';
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

describe('task deadline controls', () => {
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
  it('keeps the deadline and history without reading or changing personal pause preferences', () => {
    api.get.mockResolvedValue(row('me', '2099-10-01T00:00:00.000Z'));
    const view = render(<TaskPlanningFields task={task} memberId="me" users={[]} onSaved={vi.fn()} />);
    expect(screen.getByText('Pick later date')).toBeTruthy();
    expect(screen.getByText('taskPlanning.history')).toBeTruthy();
    expect(screen.queryByText('taskPlanning.personalReminder')).toBeNull();
    expect(screen.queryByText('taskPlanning.pause')).toBeNull();
    expect(screen.queryByLabelText('taskPlanning.pauseThrough')).toBeNull();
    view.rerender(<TaskPlanningFields task={task} memberId="other" users={[]} onSaved={vi.fn()} />);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.reminder).not.toHaveBeenCalled();
  });
  it('ignores an earlier deadline history response after the member or task changes', async () => {
    let resolveOld!: (value: unknown[]) => void;
    api.history.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce([]);
    const view = render(<TaskPlanningFields task={task} memberId="me" users={[]} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByText('taskPlanning.history'));
    view.rerender(<TaskPlanningFields task={{ ...task, id: 'task2' }} memberId="other" users={[]} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByText('taskPlanning.history'));
    await screen.findByText('taskPlanning.historyEmpty');
    await act(async () => resolveOld([{ id: 'old-history', reason: 'Previous card private note' }]));
    expect(screen.queryByText('Previous card private note')).toBeNull();
    expect(api.history).toHaveBeenLastCalledWith('task2');
    expect(api.get).not.toHaveBeenCalled();
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
