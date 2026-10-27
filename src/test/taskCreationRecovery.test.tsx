import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, CustomField } from '@/types';

const state = vi.hoisted(() => ({
  holdRefresh: false, resolveRefresh: null as null | (() => void),
  templates: [] as Array<{ id: string; defaultTagIds: string[]; defaultSpecRequirement: string }>,
  actor: 'member-example', holdCreate: false, resolveCreate: null as null | (() => void), fields: [] as CustomField[], fieldStored: true,
  open: true, deniedTable: 'task_specs', created: [] as Task[], close: vi.fn(), openTask: vi.fn(),
  success: vi.fn(), error: vi.fn(), confirm: vi.fn(), writes: [] as string[],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('sonner', () => ({ toast: { success: state.success, error: state.error, info: vi.fn() } }));
vi.mock('@/context/DeploymentEnvironmentContext', () => ({ useDeploymentEnvironments: () => ({ ready: true, values: [] as string[] }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: state.actor, currentMember: { id: state.actor, name: 'Example Member' } }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as unknown[] }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ showCreateTask: state.open, setShowCreateTask: state.close, setSelectedTask: state.openTask, requiredFields: { title: true, project: true }, currentView: 'board' }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ selectedProjectId: 'p', selectedLineId: null as string | null, allProjects: [{ id: 'p', name: 'Example Project', lineId: 'line' }], productLines: [{ id: 'line', name: 'Example Line' }] }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({
  allTasks: [] as Task[], setAllTasks: vi.fn(), statuses: [{ id: 'todo', name: 'Todo' }], tags: [] as unknown[], refreshTags: vi.fn(),
  createTaskInDb: async (task: Task) => { state.created.push(task); if (state.holdCreate) return new Promise<Task>(resolve => { state.resolveCreate = () => resolve(task); }); return task; }, createSubtask: vi.fn(),
  refreshTaskSpecs: () => state.holdRefresh ? new Promise<void>(resolve => { state.resolveRefresh = resolve; }) : Promise.resolve(), refreshTaskChecks: vi.fn(), refreshTaskTodos: vi.fn(), refreshStatusLogs: vi.fn(),
  taskTemplates: state.templates, customFields: state.fields, upsertCustomFieldValue: vi.fn(),
}) }));
vi.mock('@/context/SprintContext', () => ({ useSprintContext: () => ({ currentSprint: null as { id: string; name: string } | null }) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ hasFeature: () => true }) }));
vi.mock('@/components/ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: state.confirm, ConfirmDialog: null as null }) }));
vi.mock('@/lib/slackNotify', () => ({ sendSlackNotify: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => {
  const chain = {
    select: () => chain, eq: () => chain,
    maybeSingle: async () => ({ data: state.fieldStored ? { id: 'stored-custom-value' } : null, error: null as null }),
    insert: () => {
      state.writes.push(table);
      return Promise.resolve({ data: null as null, error: table === state.deniedTable ? { message: 'Simulated write failure' } : null });
    },
  };
  return chain;
} } }));
import { useCreateTaskForm } from '@/components/create-task/useCreateTaskForm';

beforeEach(() => { vi.clearAllMocks(); state.templates = []; state.holdRefresh = false; state.resolveRefresh = null; state.actor = 'member-example'; state.holdCreate = false; state.resolveCreate = null; state.fields = []; state.fieldStored = true; state.open = true; state.deniedTable = 'task_specs'; state.created = []; state.writes = []; state.confirm.mockResolvedValue(false); });
afterEach(cleanup);
const prepare = () => {
  const hook = renderHook(() => useCreateTaskForm());
  act(() => { hook.result.current.setTitle('Example task'); hook.result.current.setBackground('<p>Original background</p>'); hook.result.current.setRequirement('<p>Original requirement</p>'); hook.result.current.setNotes('<p>Original notes</p>'); });
  return hook;
};

describe('partially created task recovery', () => {
  it('keeps input and the persisted card identity, and never creates a second card on another submit', async () => {
    state.templates = [{ id: 'template-example', defaultTagIds: [], defaultSpecRequirement: '<p>Different template</p>' }];
    const { result } = prepare();
    await act(async () => result.current.handleSubmitAttempt());
    await waitFor(() => expect(result.current.partialCreation?.task.id).toBe(state.created[0].id));
    expect(result.current.partialCreation?.sections).toContain('spec');
    expect(result.current.background).toBe('<p>Original background</p>');
    expect(result.current.requirement).toBe('<p>Original requirement</p>');
    expect(result.current.notes).toBe('<p>Original notes</p>');
    act(() => result.current.applyTemplate('template-example'));
    expect(result.current.requirement).toBe('<p>Original requirement</p>');
    act(() => result.current.handleDrop({ preventDefault: vi.fn(), dataTransfer: { files: [new File(['example'], 'example.txt')] } } as unknown as React.DragEvent));
    expect(result.current.pendingFiles).toHaveLength(0);
    expect(state.close).not.toHaveBeenCalledWith(false); expect(state.success).not.toHaveBeenCalled();
    await act(async () => result.current.handleSubmitAttempt());
    expect(state.created).toHaveLength(1);
  });

  it.each(['task_checks', 'task_todos', 'status_logs'])('preserves a draft when %s fails after the main card was saved', async table => {
    state.deniedTable = table; const { result } = prepare();
    act(() => { result.current.setNewCheckText('Example acceptance check'); result.current.setNewTodoText('Example todo'); });
    act(() => { result.current.addCheck(); result.current.addTodo(); });
    await act(async () => result.current.handleSubmitAttempt());
    await waitFor(() => expect(result.current.partialCreation).not.toBeNull());
    expect(state.created).toHaveLength(1); expect(state.writes).toContain(table);
    expect(state.success).not.toHaveBeenCalled(); expect(result.current.checkItems).toEqual(['Example acceptance check']);
    expect(result.current.todoItems).toEqual(['Example todo']);
  });

  it('opens the saved card without discarding the retained input and restores it when the form reopens', async () => {
    const { result, rerender } = prepare(); await act(async () => result.current.handleSubmitAttempt());
    act(() => result.current.openCreatedTask());
    expect(state.openTask).toHaveBeenCalledWith(state.created[0]);
    state.open = false; rerender(); state.open = true; rerender();
    expect(result.current.partialCreation?.task.id).toBe(state.created[0].id);
    expect(result.current.requirement).toBe('<p>Original requirement</p>');
    await act(async () => result.current.handleSubmitAttempt()); expect(state.created).toHaveLength(1);
  });

  it('clears a recovery draft only after explicit confirmation, leaving the created card intact', async () => {
    const { result, rerender } = prepare(); await act(async () => result.current.handleSubmitAttempt());
    await act(async () => result.current.discardPartialDraft()); expect(result.current.partialCreation).not.toBeNull();
    state.confirm.mockResolvedValue(true); await act(async () => result.current.discardPartialDraft());
    expect(result.current.partialCreation).toBeNull(); expect(state.created).toHaveLength(1);
    state.open = false; rerender(); state.open = true; rerender();
    expect(result.current.title).toBe(''); expect(result.current.requirement).toBe('');
  });

  it('requires persisted custom-field readback before dropping the creation draft', async () => {
    state.deniedTable = ''; state.fieldStored = false;
    state.fields = [{ id: 'field-example', projectId: 'p', fieldName: 'Example detail', fieldType: 'text', isRequired: false, defaultValue: 'Retain me', sortOrder: 0, createdAt: '' }];
    const { result } = prepare(); await act(async () => result.current.handleSubmitAttempt());
    await waitFor(() => expect(result.current.partialCreation?.sections).toContain('custom'));
    expect(result.current.customFieldsProps.values['field-example']).toEqual({ valueText: 'Retain me' });
    expect(state.success).not.toHaveBeenCalled(); expect(state.created).toHaveLength(1);
  });

  it('does not resume an old creation after the same actor returns in a new login session', async () => {
    state.holdCreate = true;
    const { result, rerender } = prepare();
    act(() => result.current.handleSubmitAttempt());
    await waitFor(() => expect(state.resolveCreate).not.toBeNull());
    state.actor = 'member-other'; state.open = false; rerender();
    state.actor = 'member-example'; state.open = true; rerender();
    act(() => result.current.setTitle('New session draft'));
    const trace = vi.spyOn(console, 'info').mockImplementation(() => {});
    await act(async () => state.resolveCreate?.());
    expect(trace).toHaveBeenCalledWith('[LIVO] Task created for a previous form session', { taskId: state.created[0].id });
    trace.mockRestore();
    expect(state.writes).toEqual([]); expect(state.created).toHaveLength(1);
    expect(result.current.title).toBe('New session draft');
    expect(result.current.partialCreation).toBeNull(); expect(result.current.isSubmitting).toBe(false);
  });

  it('ignores a completed old refresh instead of closing a new session draft', async () => {
    state.deniedTable = ''; state.holdRefresh = true;
    const { result, rerender } = prepare();
    act(() => result.current.handleSubmitAttempt());
    await waitFor(() => expect(state.resolveRefresh).not.toBeNull());
    state.actor = 'member-other'; state.open = false; rerender();
    state.actor = 'member-example'; state.open = true; rerender();
    act(() => result.current.setTitle('New draft after refresh started'));
    state.close.mockClear();
    await act(async () => state.resolveRefresh?.());
    expect(result.current.title).toBe('New draft after refresh started');
    expect(result.current.partialCreation).toBeNull(); expect(state.close).not.toHaveBeenCalled();
    expect(state.success).not.toHaveBeenCalled(); expect(state.created).toHaveLength(1);
  });

  it('closes normally only when all content writes have succeeded', async () => {
    state.deniedTable = ''; const { result } = prepare(); await act(async () => result.current.handleSubmitAttempt());
    await waitFor(() => expect(state.success).toHaveBeenCalledWith('task.created'));
    expect(state.close).toHaveBeenCalledWith(false); expect(result.current.partialCreation).toBeNull();
  });
});
