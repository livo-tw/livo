import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomField, Project, Task } from '@/types';
import type { SprintReadState } from '@/context/SprintContext';

const state = vi.hoisted(() => ({
  view: 'board', open: true, projects: [] as Project[], created: [] as Task[],
  sprint: null as { id: string; name: string } | null,
  sprintReadState: 'ready' as SprintReadState, refreshSprints: vi.fn<() => Promise<void>>(),
  failCreateWithSprintConflict: false, error: vi.fn(),
  failCreate: false, storedKey: null as string | null, createdToast: vi.fn(),
  fields: [] as CustomField[], saved: [] as Array<{ taskId: string; fieldId: string; value: unknown }>,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: state.error, info: vi.fn() } }));
vi.mock('@/lib/taskCreatedToast', () => ({ showTaskCreatedToast: state.createdToast }));
vi.mock('@/context/DeploymentEnvironmentContext', () => ({ useDeploymentEnvironments: () => ({ ready: true, values: [] as string[] }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'me', currentMember: { id: 'me', name: 'Me' } }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as unknown[] }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ showCreateTask: state.open, setShowCreateTask: vi.fn(), requiredFields: { title: true, project: true }, currentView: state.view }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ selectedProjectId: null as string | null, selectedLineId: null as string | null, allProjects: state.projects, productLines: [{ id: 'l', name: 'Line' }] }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({
  allTasks: [] as Task[], setAllTasks: vi.fn(), statuses: [{ id: 'todo', name: 'To do' }], tags: [] as unknown[], refreshTags: vi.fn(),
  createTaskInDb: async (task: Task) => {
    if (state.failCreateWithSprintConflict) throw new Error('sprint_conflict');
    if (state.failCreate) return null;
    state.created.push(task);
    return state.storedKey ? { ...task, taskKey: state.storedKey } : task;
  }, createSubtask: vi.fn(),
  refreshTaskSpecs: vi.fn(), refreshTaskChecks: vi.fn(), refreshTaskTodos: vi.fn(), refreshStatusLogs: vi.fn(), taskTemplates: [] as unknown[],
  customFields: state.fields, upsertCustomFieldValue: async (taskId: string, fieldId: string, value: unknown) => { state.saved.push({ taskId, fieldId, value }); },
}) }));
vi.mock('@/context/SprintContext', () => ({ useSprintContext: () => ({
  currentSprint: state.sprint, sprintReadState: state.sprintReadState, refreshSprints: state.refreshSprints,
}) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ hasFeature: () => true }) }));
vi.mock('@/components/ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(), ConfirmDialog: null as null }) }));
vi.mock('@/lib/slackNotify', () => ({ sendSlackNotify: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => {
  const chain = { select: () => chain, eq: () => chain,
    maybeSingle: async () => ({ data: { id: 'stored-custom-value' }, error: null as null }),
    insert: async () => ({ data: null as null, error: null as null }) };
  return chain;
} } }));
import { useCreateTaskForm } from '@/components/create-task/useCreateTaskForm';

const project = (id: string, name: string) => ({ id, name, lineId: 'l' }) as Project;
beforeEach(() => {
  state.view = 'board'; state.open = true; state.projects = [project('p1', 'Shop')];
  state.created = []; state.fields = []; state.saved = [];
  state.sprint = { id: 'sprint-1', name: 'Sprint 1' }; state.sprintReadState = 'ready';
  state.refreshSprints.mockReset().mockResolvedValue(undefined); state.error.mockClear();
  state.failCreateWithSprintConflict = false;
  state.failCreate = false; state.storedKey = null; state.createdToast.mockClear();
});

describe('the create task form', () => {
  it('notifies with the confirmed task ID and the key actually kept by the server', async () => {
    state.storedKey = 'EX-99';
    const { result } = renderHook(() => useCreateTaskForm());
    act(() => result.current.setTitle('Confirmed task'));
    await act(async () => { result.current.handleSubmitAttempt(); });
    await waitFor(() => expect(state.createdToast).toHaveBeenCalledTimes(1));
    expect(state.createdToast).toHaveBeenCalledWith(expect.objectContaining({ id: state.created[0].id, taskKey: 'EX-99' }), expect.any(Function));
  });

  it('does not show a created-task link when the insert is refused', async () => {
    state.failCreate = true;
    const { result } = renderHook(() => useCreateTaskForm());
    act(() => result.current.setTitle('Refused task'));
    await act(async () => { result.current.handleSubmitAttempt(); });
    expect(state.createdToast).not.toHaveBeenCalled();
    expect(result.current.title).toBe('Refused task');
  });

  it('keeps what was typed when projects change elsewhere while it is open', () => {
    const { result, rerender } = renderHook(() => useCreateTaskForm());
    act(() => result.current.setTitle('Checkout fails on Safari'));
    state.projects = [project('p1', 'Shop'), project('p2', 'Games')];
    rerender();
    expect(result.current.title).toBe('Checkout fails on Safari');
  });

  it.each(['board', 'backlog'])('defaults to the running sprint when opened from %s', async view => {
    state.view = view;
    const { result } = renderHook(() => useCreateTaskForm());
    expect(result.current.sprintSelection).toMatchObject({ checked: true, name: 'Sprint 1' });
    act(() => result.current.setTitle('Fix now'));
    await act(async () => { result.current.handleSubmitAttempt(); });
    await waitFor(() => expect(state.created).toHaveLength(1));
    expect(state.created[0].sprintId).toBe('sprint-1');
  });

  it('keeps the backlog choice through sprint changes and defaults again on the next form opening', async () => {
    const { result, rerender } = renderHook(() => useCreateTaskForm());
    act(() => result.current.sprintSelection?.chooseCurrent(false));
    state.sprint = { id: 'sprint-2', name: 'Sprint 2' };
    rerender();
    expect(result.current.sprintSelection).toMatchObject({ checked: false, name: 'Sprint 2', changed: false });
    act(() => result.current.setTitle('Later idea'));
    await act(async () => { result.current.handleSubmitAttempt(); });
    await waitFor(() => expect(state.created).toHaveLength(1));
    expect(state.created[0].sprintId).toBeUndefined();

    state.open = false; rerender();
    state.open = true; rerender();
    expect(result.current.sprintSelection).toMatchObject({ checked: true, name: 'Sprint 2' });
  });

  it('waits for the sprint read before assigning the default or creating a card', async () => {
    state.sprint = null; state.sprintReadState = 'loading';
    const { result, rerender } = renderHook(() => useCreateTaskForm());
    act(() => result.current.setTitle('Use the loaded sprint'));
    expect(result.current.sprintChoicePending).toBe(true);
    await act(async () => { result.current.handleSubmitAttempt(); });
    expect(state.created).toHaveLength(0);
    state.sprint = { id: 'sprint-1', name: 'Sprint 1' }; state.sprintReadState = 'ready';
    rerender();
    expect(result.current.title).toBe('Use the loaded sprint');
    expect(result.current.sprintSelection).toMatchObject({ checked: true, name: 'Sprint 1' });
    await act(async () => { result.current.handleSubmitAttempt(); });
    await waitFor(() => expect(state.created).toHaveLength(1));
    expect(state.created[0].sprintId).toBe('sprint-1');
  });

  it('defaults to the first sprint started while a draft is open without changing the draft', async () => {
    state.sprint = null;
    const { result, rerender } = renderHook(() => useCreateTaskForm());
    act(() => result.current.setTitle('Keep this draft'));
    expect(result.current.sprintChoicePending).toBe(false);

    state.sprint = { id: 'sprint-1', name: 'Sprint 1' };
    rerender();
    expect(result.current.title).toBe('Keep this draft');
    expect(result.current.sprintSelection).toMatchObject({ checked: true, name: 'Sprint 1' });
    await act(async () => { result.current.handleSubmitAttempt(); });
    await waitFor(() => expect(state.created).toHaveLength(1));
    expect(state.created[0].sprintId).toBe('sprint-1');
  });

  it('requires a deliberate backlog choice when the sprint read fails', async () => {
    state.sprint = null; state.sprintReadState = 'error';
    const { result } = renderHook(() => useCreateTaskForm());
    act(() => result.current.setTitle('Save to backlog'));
    expect(result.current.sprintChoicePending).toBe(true);
    act(() => result.current.sprintSelection?.retry());
    expect(state.refreshSprints).toHaveBeenCalledOnce();
    act(() => result.current.sprintSelection?.chooseBacklog());
    expect(result.current.sprintChoicePending).toBe(false);
    await act(async () => { result.current.handleSubmitAttempt(); });
    await waitFor(() => expect(state.created).toHaveLength(1));
    expect(state.created[0].sprintId).toBeUndefined();
  });

  it('requires reselection when another sprint replaces the displayed sprint', async () => {
    const { result, rerender } = renderHook(() => useCreateTaskForm());
    act(() => result.current.setTitle('Keep this draft'));
    state.sprint = { id: 'sprint-2', name: 'Sprint 2' };
    rerender();
    expect(result.current.sprintSelection).toMatchObject({ checked: false, changed: true, name: 'Sprint 2' });
    await act(async () => { result.current.handleSubmitAttempt(); });
    expect(state.created).toHaveLength(0);
    act(() => result.current.sprintSelection?.chooseCurrent(true));
    await act(async () => { result.current.handleSubmitAttempt(); });
    await waitFor(() => expect(state.created).toHaveLength(1));
    expect(state.created[0].sprintId).toBe('sprint-2');
  });

  it('keeps the draft and refreshes the sprint if the insert loses a race with closure', async () => {
    state.failCreateWithSprintConflict = true;
    const { result, rerender } = renderHook(() => useCreateTaskForm());
    act(() => result.current.setTitle('Keep this draft'));
    await act(async () => { result.current.handleSubmitAttempt(); });
    expect(state.error).toHaveBeenCalledWith('taskCreate.sprintSaveConflict');
    expect(state.refreshSprints).toHaveBeenCalledOnce();
    expect(result.current.title).toBe('Keep this draft');
    expect(state.created).toHaveLength(0);

    state.sprint = null; state.failCreateWithSprintConflict = false;
    rerender();
    expect(result.current.sprintChoicePending).toBe(true);
    act(() => result.current.sprintSelection?.chooseBacklog());
    await act(async () => { result.current.handleSubmitAttempt(); });
    await waitFor(() => expect(state.created).toHaveLength(1));
    expect(state.created[0].sprintId).toBeUndefined();
  });

  it('fills custom field defaults, blocks a missing required one and saves the values with the task', async () => {
    state.fields = [
      { id: 'f-browser', projectId: 'p1', fieldName: 'Browser', fieldType: 'select', options: ['Chrome', 'Safari'], isRequired: true, sortOrder: 1, createdAt: '' },
      { id: 'f-points', projectId: 'p1', fieldName: 'Points', fieldType: 'number', isRequired: false, defaultValue: '3', sortOrder: 2, createdAt: '' },
      { id: 'f-other', projectId: 'p2', fieldName: 'Other project', fieldType: 'text', isRequired: true, sortOrder: 1, createdAt: '' },
    ];
    const { result } = renderHook(() => useCreateTaskForm());
    expect(result.current.customFieldsProps.fields.map(field => field.id)).toEqual(['f-browser', 'f-points']);
    expect(result.current.customFieldsProps.values['f-points']).toEqual({ valueNumber: 3 });
    act(() => result.current.setTitle('Checkout fails'));
    await act(async () => { result.current.handleSubmitAttempt(); });
    expect(state.created).toHaveLength(0);
    act(() => result.current.customFieldsProps.onChange('f-browser', { valueText: 'Safari' }));
    await act(async () => { result.current.handleSubmitAttempt(); });
    await waitFor(() => expect(state.saved).toHaveLength(2));
    expect(state.saved).toEqual([
      { taskId: state.created[0].id, fieldId: 'f-browser', value: { valueText: 'Safari' } },
      { taskId: state.created[0].id, fieldId: 'f-points', value: { valueNumber: 3 } },
    ]);
  });
});

