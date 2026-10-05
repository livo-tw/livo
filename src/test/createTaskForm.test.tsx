import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomField, Project, Task } from '@/types';

const state = vi.hoisted(() => ({
  view: 'board', projects: [] as Project[], created: [] as Task[],
  fields: [] as CustomField[], saved: [] as Array<{ taskId: string; fieldId: string; value: unknown }>,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/context/DeploymentEnvironmentContext', () => ({ useDeploymentEnvironments: () => ({ ready: true, values: [] as string[] }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'me', currentMember: { id: 'me', name: 'Me' } }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as unknown[] }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ showCreateTask: true, setShowCreateTask: vi.fn(), requiredFields: { title: true, project: true }, currentView: state.view }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ selectedProjectId: null as string | null, selectedLineId: null as string | null, allProjects: state.projects, productLines: [{ id: 'l', name: 'Line' }] }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({
  allTasks: [] as Task[], setAllTasks: vi.fn(), statuses: [{ id: 'todo', name: 'To do' }], tags: [] as unknown[], refreshTags: vi.fn(),
  createTaskInDb: async (task: Task) => { state.created.push(task); return task; }, createSubtask: vi.fn(),
  refreshTaskSpecs: vi.fn(), refreshTaskChecks: vi.fn(), refreshTaskTodos: vi.fn(), refreshStatusLogs: vi.fn(), taskTemplates: [] as unknown[],
  customFields: state.fields, upsertCustomFieldValue: async (taskId: string, fieldId: string, value: unknown) => { state.saved.push({ taskId, fieldId, value }); },
}) }));
vi.mock('@/context/SprintContext', () => ({ useSprintContext: () => ({ currentSprint: { id: 'sprint-1', name: 'Sprint 1' } }) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ hasFeature: () => true }) }));
vi.mock('@/components/ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(), ConfirmDialog: null as null }) }));
vi.mock('@/lib/slackNotify', () => ({ sendSlackNotify: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { useCreateTaskForm } from '@/components/create-task/useCreateTaskForm';

const project = (id: string, name: string) => ({ id, name, lineId: 'l' }) as Project;
beforeEach(() => { state.view = 'board'; state.projects = [project('p1', 'Shop')]; state.created = []; state.fields = []; state.saved = []; });

describe('the create task form', () => {
  it('keeps what was typed when projects change elsewhere while it is open', () => {
    const { result, rerender } = renderHook(() => useCreateTaskForm());
    act(() => result.current.setTitle('Checkout fails on Safari'));
    state.projects = [project('p1', 'Shop'), project('p2', 'Games')];
    rerender();
    expect(result.current.title).toBe('Checkout fails on Safari');
  });

  it('a task made from the backlog stays out of the sprint unless the member ticks it', async () => {
    state.view = 'backlog';
    const { result } = renderHook(() => useCreateTaskForm());
    expect(result.current.fieldsProps.joinSprint).toBe(false);
    act(() => result.current.setTitle('Later idea'));
    await act(async () => { result.current.handleSubmitAttempt(); });
    await waitFor(() => expect(state.created).toHaveLength(1));
    expect(state.created[0].sprintId).toBeUndefined();
  });

  it('elsewhere a new task joins the running sprint by default', async () => {
    const { result } = renderHook(() => useCreateTaskForm());
    expect(result.current.fieldsProps.joinSprint).toBe(true);
    expect(result.current.fieldsProps.sprintName).toBe('Sprint 1');
    act(() => result.current.setTitle('Fix now'));
    await act(async () => { result.current.handleSubmitAttempt(); });
    await waitFor(() => expect(state.created).toHaveLength(1));
    expect(state.created[0].sprintId).toBe('sprint-1');
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

