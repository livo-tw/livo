import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Task, Status } from '@/types';

const state = vi.hoisted(() => ({ tasks: [] as Task[], statuses: [] as Status[], update: vi.fn().mockResolvedValue(true), setTasks: vi.fn(), selected: null as Task | null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ selectedTask: state.selected, setSelectedTask: vi.fn(), taskDisplayMode: 'modal', setTaskDisplayMode: vi.fn() }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({
  allTasks: state.tasks, setAllTasks: state.setTasks, statuses: state.statuses, statusLogs: [] as never[], tags: [] as never[],
  taskSpecs: [] as never[], taskChecks: [] as never[], taskTodos: [] as never[], comments: [] as never[],
  customFields: [] as never[], customFieldValues: [] as never[], taskDependencies: [] as never[], updateTaskInDb: state.update,
}) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [] as never[], productLines: [] as never[] }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as never[] }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'member-example', currentMember: { id: 'member-example', role: 'member' }, permissions: { canEditProject: false } }) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ hasFeature: () => true }) }));
vi.mock('@/components/PortalConfirmDialog', () => ({ usePortalConfirmDialog: () => ({ confirm: vi.fn(), ConfirmDialog: null as null }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useUndoStack', () => ({ useUndoStack: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useStatusTransitionRules', () => ({ useStatusTransitionRules: () => ({ canTransitionTo: vi.fn() }) }));
vi.mock('@/components/notifications/NotificationToastProvider', () => ({ useNotificationToast: () => ({ triggerNotification: vi.fn() }) }));
vi.mock('@/hooks/useApprovalRules', () => ({ useApprovalRules: () => ({ getRuleForTransition: vi.fn() }) }));
vi.mock('@/hooks/useApprovalWorkflow', () => ({ useApprovalWorkflow: () => ({ requestApproval: vi.fn() }) }));
vi.mock('@/hooks/useStatusChangeGate', () => ({ useStatusChangeGate: () => ({ check: () => ({ kind: 'direct' }), refusal: (): null => null }) }));
vi.mock('@/hooks/useTaskAnnouncements', () => ({ useTaskAnnouncements: () => ({}) }));
vi.mock('@/lib/taskAnnouncements', () => ({ announceStatusChange: vi.fn() }));
vi.mock('@/lib/activityLog', () => ({ fetchTaskActivityLogs: async () => [] as never[] }));
vi.mock('@/components/task-detail/TaskSidebarFields', () => ({ default: (): null => null }));
vi.mock('@/components/task-detail/hooks/useTaskPresence', () => ({ useTaskPresence: () => ({ otherViewers: [] as never[], trackPresence: vi.fn(), getFieldLocker: (): undefined => undefined }) }));
vi.mock('@/components/task-detail/hooks/useTaskAttachments', () => ({ useTaskAttachments: () => ({}) }));
vi.mock('@/components/task-detail/hooks/useTaskComments', () => ({ useTaskComments: () => ({}) }));
vi.mock('@/components/task-detail/hooks/useTaskSpecs', () => ({ useTaskSpecs: () => ({}) }));
vi.mock('@/components/task-detail/hooks/useTaskDetailChecklist', () => ({ useTaskDetailChecklist: () => ({ checks: [] as never[] }) }));
vi.mock('@/components/task-detail/hooks/useTaskDetailTodos', () => ({ useTaskDetailTodos: () => ({ todos: [] as never[] }) }));
vi.mock('@/components/task-detail/hooks/useTaskStatusChange', () => ({ useTaskStatusChange: () => ({}) }));
vi.mock('@/components/task-detail/hooks/useTaskActions', () => ({ useTaskActions: () => ({}) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: null as null, error: null as null }),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [] as never[], error: null as null }).then(resolve) };
  return chain;
}, channel: () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; }, removeChannel: vi.fn() } }));
import { useTaskDetail } from '@/components/task-detail/hooks/useTaskDetail';
import TaskSubtasksTab from '@/components/task-detail/TaskSubtasksTab';

afterEach(cleanup);
it('routes a real task-detail subtask status action through its task persistence function', async () => {
  state.statuses = [{ id: 'open', name: 'Open', color: '#123456', sortOrder: 0, isDone: false, autoStart: false, autoDone: false },
    { id: 'done', name: 'Done', color: '#654321', sortOrder: 1, isDone: true, autoStart: false, autoDone: false }];
  const parent = { id: 'parent', taskKey: 'EX-1', title: 'Example parent', projectId: 'project-example', statusId: 'open', priority: 'medium', creatorId: 'member-example', sortOrder: 0, createdAt: '', commentCount: 0, attachmentCount: 0, deployments: [] } as Task;
  const child = { ...parent, id: 'child', taskKey: 'EX-2', title: 'Example child', parentTaskId: parent.id };
  state.tasks = [parent, child]; state.selected = parent;
  function Detail() { const detail = useTaskDetail(); return <TaskSubtasksTab detail={detail} />; }
  render(<Detail />);
  fireEvent.click(screen.getByTitle('taskDetail.subtasks.changeStatus'));
  fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
  await waitFor(() => expect(state.update).toHaveBeenCalledExactlyOnceWith(child.id, { statusId: 'done', completedAt: expect.any(String) }));
});
