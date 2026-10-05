import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, Project, Status, TaskDependency, TaskCustomFieldValue } from '@/types';
const mocks = vi.hoisted(() => ({ run: vi.fn(), factory: vi.fn(), error: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/taskWork/client', () => ({ createTaskWorkCommandRunner: (...args: unknown[]) => { mocks.factory(...args); return mocks.run; }, taskWorkErrorCode: (error: { code?: string }) => error.code || 'work_unavailable' }));
vi.mock('sonner', () => ({ toast: { error: mocks.error } }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
import { useTaskRelations } from '@/context/hooks/useTaskRelations';
import { useTaskCRUD } from '@/context/hooks/useTaskCRUD';
import { DEFAULT_REQUIRED_FIELDS, type RequiredFieldsConfig } from '@/context/UIContext';
import { subtaskQuickCreateFields } from '@/lib/taskWork/subtaskDefaults';
const parent = { id: 'parent', projectId: 'project', taskKey: 'EX-1', title: 'Parent', statusId: 'doing' } as Task;
const project = { id: 'project', key: 'EX' } as Project;
beforeEach(() => { mocks.run.mockReset(); mocks.factory.mockClear(); mocks.error.mockReset(); });
const relationsProps = () => ({ currentMemberId: 'me', taskDependencies: [] as TaskDependency[], customFieldValues: [] as TaskCustomFieldValue[], setTaskDependencies: vi.fn(), setCustomFieldValues: vi.fn(), setCustomFields: vi.fn(), setTaskTemplates: vi.fn(), refreshCustomFields: vi.fn(), refreshTaskTemplates: vi.fn() });
describe('LIVO task relations shared command boundary', () => {
  it('waits for the server dependency result and preserves state on a server cycle', async () => {
    const props = relationsProps(); mocks.run.mockRejectedValue({ code: 'work_cycle' });
    const view = renderHook(() => useTaskRelations(props));
    await act(async () => expect(await view.result.current.addTaskDependency('first', 'second')).toBe(false));
    expect(mocks.run).toHaveBeenCalledWith({ operation: 'add_dependency', taskId: 'first', dependsOnTaskId: 'second' });
    expect(props.setTaskDependencies).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('taskWork.errors.work_cycle');
  });
  it('does not apply a dependency result after an account switch', async () => {
    let resolve!: (value: unknown) => void; mocks.run.mockImplementation(() => new Promise(done => { resolve = done; }));
    const props = relationsProps(); const view = renderHook(current => useTaskRelations(current), { initialProps: props });
    let flight!: Promise<boolean>; act(() => { flight = view.result.current.addTaskDependency('first', 'second'); });
    view.rerender({ ...props, currentMemberId: 'other' });
    await act(async () => { resolve({ record: { id: 'dep', created_at: '2026-10-03T00:00:00Z' } }); await flight; });
    expect(props.setTaskDependencies).not.toHaveBeenCalled();
  });
  it('uses the server child key and does not create an optimistic task on failure', async () => {
    mocks.run.mockRejectedValueOnce({ code: 'work_required_fields' }).mockResolvedValueOnce({ record: {
      id: 'child', task_key: 'EX-92', project_id: 'project', parent_task_id: 'parent', title: 'Child', status_id: 'doing', priority: 'medium',
      creator_id: 'me', assignee_id: null, reviewer_id: null, due_date: null, sort_order: 0, created_at: '2026-10-03T00:00:00Z', comment_count: 0,
    } });
    const setAllTasks = vi.fn(); const view = renderHook(() => useTaskCRUD({ allTasks: [parent], statuses: [], setAllTasks, refreshTasks: vi.fn(), appendStatusLog: vi.fn() }));
    const create = view.result.current.createCreateSubtask([project], 'me');
    await act(async () => expect(await create(parent.id, 'Child', project.id, 'doing')).toBeNull());
    expect(setAllTasks).not.toHaveBeenCalled();
    let child: Task | null = null; await act(async () => { child = await create(parent.id, 'Child', project.id, 'doing'); });
    expect(child).toMatchObject({ taskKey: 'EX-92', parentTaskId: 'parent' });
    expect(setAllTasks).toHaveBeenCalledTimes(1);
  });
  it('fills only team-required due date, assignee and reviewer from the parent for the title-only quick create', async () => {
    mocks.run.mockResolvedValue({ record: {
      id: 'child', task_key: 'EX-93', project_id: 'project', parent_task_id: 'parent', title: 'Child', status_id: 'doing', priority: 'medium',
      creator_id: 'me', assignee_id: null, reviewer_id: null, due_date: '2027-02-01', sort_order: 0, created_at: '2026-10-03T00:00:00Z', comment_count: 0,
    } });
    const owned = { ...parent, dueDate: '2027-02-01', assigneeId: 'owner', reviewerId: 'checker' } as Task;
    const view = renderHook(() => useTaskCRUD({ allTasks: [owned], statuses: [], setAllTasks: vi.fn(), refreshTasks: vi.fn(), appendStatusLog: vi.fn() }));
    const createWith = async (required?: RequiredFieldsConfig) => {
      await act(async () => { await view.result.current.createCreateSubtask([project], 'me', required)(owned.id, 'Child', project.id, 'doing'); });
      return mocks.run.mock.calls.at(-1)?.[0];
    };
    // Shipped default: title/project/dueDate. Title and project come from the quick create itself.
    expect(await createWith({ ...DEFAULT_REQUIRED_FIELDS })).toMatchObject({ operation: 'create_subtask', title: 'Child', dueDate: '2027-02-01', assigneeId: null, reviewerId: null });
    expect(await createWith({ ...DEFAULT_REQUIRED_FIELDS, dueDate: false, assignee: true, reviewer: true })).toMatchObject({ dueDate: null, assigneeId: 'owner', reviewerId: 'checker' });
    expect(await createWith()).toMatchObject({ dueDate: null, assigneeId: null, reviewerId: null });
    const legacy = { ...owned, dueDate: '2027-02-01T00:00:00Z' } as Task;
    expect(subtaskQuickCreateFields(legacy, DEFAULT_REQUIRED_FIELDS)).toEqual({ dueDate: null, assigneeId: null, reviewerId: null });
  });
  it('keeps the same runner through task refreshes and refuses a mismatched parent project', async () => {
    const base = { allTasks: [parent], statuses: [] as Status[], setAllTasks: vi.fn(), refreshTasks: vi.fn(), appendStatusLog: vi.fn() };
    const view = renderHook(current => useTaskCRUD(current), { initialProps: base });
    view.result.current.createCreateSubtask([project], 'me');
    view.rerender({ ...base, allTasks: [{ ...parent }] });
    const create = view.result.current.createCreateSubtask([project], 'me');
    expect(mocks.factory).toHaveBeenCalledTimes(1);
    await act(async () => expect(await create(parent.id, 'Child', 'different-project', 'doing')).toBeNull());
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
