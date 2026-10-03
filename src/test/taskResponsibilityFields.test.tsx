import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/types';
import type { TaskResponsibility } from '@/lib/taskWork/client';
const mocks = vi.hoisted(() => ({ get: vi.fn(), run: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/taskWork/client', () => ({ createTaskWorkCommandRunner: () => mocks.run, getTaskResponsibility: mocks.get, taskWorkErrorCode: (error: { code?: string }) => error.code || 'work_unavailable' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, args?: { date?: string }) => args?.date ? `${key}:${args.date}` : key, i18n: { language: 'en' } }) }));
import TaskResponsibilityFields from '@/components/task-detail/fields/TaskResponsibilityFields';
const task = { id: 'task-1', assigneeId: 'me', reviewerId: 'other', assigneeRevision: 4, reviewerRevision: 2, statusId: 'doing' } as Task;
const row: TaskResponsibility = { id: task.id, assignee_id: 'me', reviewer_id: 'other', assignee_revision: 4, reviewer_revision: 2, assignee_acknowledged_at: null, reviewer_acknowledged_at: null };
beforeEach(() => { mocks.get.mockReset().mockResolvedValue(row); mocks.run.mockReset(); });
describe('responsibility acceptance controls', () => {
  it('uses the live revision and leaves task status unchanged', async () => {
    const saved = { ...row, assignee_revision: 7, assignee_acknowledged_at: '2026-10-03T01:00:00Z' };
    mocks.get.mockResolvedValue({ ...row, assignee_revision: 7 }); mocks.run.mockResolvedValue({ task: saved });
    const onSaved = vi.fn(); render(<TaskResponsibilityFields task={task} memberId="me" role="assignee" onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole('button', { name: 'taskWork.acceptAssignment' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(mocks.run).toHaveBeenCalledWith({ operation: 'acknowledge', taskId: task.id, role: 'assignee', expectedRevision: 7 });
    expect(task.statusId).toBe('doing');
  });
  it('only offers review acceptance to the current reviewer', async () => {
    const view = render(<TaskResponsibilityFields task={task} memberId="me" role="reviewer" onSaved={vi.fn()} />);
    await screen.findByText('taskWork.awaitingAcknowledgement');
    expect(screen.queryByRole('button', { name: 'taskWork.acceptReview' })).toBeNull();
    view.rerender(<TaskResponsibilityFields task={task} memberId="other" role="reviewer" onSaved={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'taskWork.acceptReview' })).toBeTruthy();
  });
  it('shows the receipt time and prevents repeated confirmation', async () => {
    mocks.get.mockResolvedValue({ ...row, assignee_acknowledged_at: '2026-10-03T01:00:00Z' });
    render(<TaskResponsibilityFields task={task} memberId="me" role="assignee" onSaved={vi.fn()} />);
    expect(await screen.findByText(/^taskWork.acknowledgedAt:/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'taskWork.acceptAssignment' })).toBeNull();
  });
  it('discards a late receipt when the assignment changes', async () => {
    let resolve!: (value: unknown) => void;
    mocks.run.mockImplementation(() => new Promise(done => { resolve = done; }));
    const onSaved = vi.fn(); const view = render(<TaskResponsibilityFields task={task} memberId="me" role="assignee" onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole('button', { name: 'taskWork.acceptAssignment' }));
    mocks.get.mockResolvedValue({ ...row, assignee_id: 'other', assignee_revision: 5 });
    view.rerender(<TaskResponsibilityFields task={{ ...task, assigneeId: 'other', assigneeRevision: 5 }} memberId="me" role="assignee" onSaved={onSaved} />);
    await act(async () => resolve({ task: { ...row, assignee_acknowledged_at: '2026-10-03T01:00:00Z' } }));
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'taskWork.acceptAssignment' })).toBeNull();
  });
  it('ignores an old account read after switching account', async () => {
    let resolve!: (value: unknown) => void;
    mocks.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = render(<TaskResponsibilityFields task={task} memberId="me" role="assignee" onSaved={vi.fn()} />);
    view.rerender(<TaskResponsibilityFields task={task} memberId="other" role="assignee" onSaved={vi.fn()} />);
    await screen.findByText('taskWork.awaitingAcknowledgement');
    await act(async () => resolve({ ...row, assignee_id: 'other', assignee_acknowledged_at: '2026-10-03T01:00:00Z' }));
    expect(screen.queryByText(/^taskWork.acknowledgedAt:/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'taskWork.acceptAssignment' })).toBeNull();
  });
  it('keeps the acceptance button for an uncertain response and gives a clear reload for conflicts', async () => {
    mocks.run.mockRejectedValueOnce({ code: 'work_transport_error' }).mockRejectedValueOnce({ code: 'work_conflict' });
    render(<TaskResponsibilityFields task={task} memberId="me" role="assignee" onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'taskWork.acceptAssignment' }));
    await screen.findByText('taskWork.errors.work_transport_error');
    fireEvent.click(screen.getByRole('button', { name: 'taskWork.acceptAssignment' }));
    await screen.findByText('taskWork.errors.work_conflict');
    expect(screen.getByRole('button', { name: 'taskWork.reload' })).toBeTruthy();
  });
});
