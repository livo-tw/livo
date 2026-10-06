import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeploymentQueueView from '@/components/deployment-queue/DeploymentQueueView';
import type { QaIssue, QaActor } from '@/lib/qa/domain';
import type { User, Task } from '@/types';
const state = vi.hoisted(() => ({ member: { id: 'operator', role: 'member', isActive: true } as User, taskError: false, taskCount: 1 as number | null, scope: null as Set<string> | null, operator: true, tasks: [] as Record<string, unknown>[], list: vi.fn(), get: vi.fn(), command: vi.fn(), open: vi.fn(), view: vi.fn(), save: vi.fn(), revision: 'revision-1' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMember: state.member, realMemberId: state.member.id }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ featureTogglesReady: true, featureToggles: { deploymentQueue: true, qa: true }, setSelectedTask: state.open, setCurrentView: state.view }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [] as Task[], statuses: [{ id: 'wait', name: 'Ready for release', isDone: false }, { id: 'done', name: 'Done', isDone: true }] }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [{ id: 'operator', name: 'Example Operator', isActive: true }] }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [{ id: 'example-project', name: 'Example Project' }] }) }));
vi.mock('@/hooks/useProjectScope', () => ({ useProjectScope: () => ({ projectIds: state.scope }) }));
vi.mock('@/hooks/useDeploymentQueueSettings', () => ({ useDeploymentQueueSettings: () => ({ status: 'ready', config: { version: 1, enabled: true, taskStatusIds: ['wait'], operatorMemberIds: ['operator'] }, revision: state.revision, isOperator: state.operator, refresh: vi.fn(), save: state.save }) }));
vi.mock('@/hooks/useQa', () => { const client = { list: state.list, get: state.get, command: state.command }; return { useQa: () => ({ client, enabled: true, actor: { id: state.member.id, role: state.member.role, deploymentOperator: state.operator } as QaActor }) }; });
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  from: (table: string) => { const query = { select: () => query, in: () => query, order: () => query, range: async () => table === 'tasks' ? { data: state.taskError ? null : state.tasks, error: state.taskError ? { message: 'denied' } : null, count: state.taskCount } : { data: [{ id: 'wait', is_done: false }, { id: 'done', is_done: true }], error: null, count: 2 } }; return query; },
  channel: () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; }, removeChannel: vi.fn(),
} }));
const issue: QaIssue = { id: 'example-bug', projectId: 'example-project', title: 'Example Bug', state: 'verification', version: 3, closedAt: null, assigneeId: 'developer', qaOwnerId: 'tester', reporterId: 'reporter', targets: [{ id: 'target', environment: 'Staging', component: '', build: '', required: true, deployedAt: null, deployedBy: null, deploymentEvidence: '' }], runs: [] } as QaIssue;
beforeEach(() => {
  state.member = { id: 'operator', role: 'member', isActive: true } as User; state.taskError = false; state.taskCount = 1; state.scope = null; state.operator = true; state.revision = 'revision-1';
  state.tasks = [{ id: 'example-task', task_key: 'EX-1', title: 'Example Task', project_id: 'example-project', status_id: 'wait', priority: 'medium', creator_id: 'reporter', completed_at: null }];
  state.list.mockReset().mockResolvedValue({ issues: [issue], total: 1, hasMore: false }); state.get.mockReset().mockResolvedValue({ issue: { ...issue, version: 9 } }); state.command.mockReset().mockResolvedValue({ ...issue, version: 10 }); state.open.mockReset(); state.view.mockReset(); state.save.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(document, 'visibilityState'); });
describe('scoped deployment queue', () => {
  it('shows existing cards, actual target environment and missing product version', async () => { render(<DeploymentQueueView />); expect(await screen.findByText('EX-1 · Example Task')).toBeInTheDocument(); expect(await screen.findByText('Example Bug')).toBeInTheDocument(); expect(screen.getByText(/Staging · deploymentQueue.versionMissing/)).toBeInTheDocument(); expect(screen.queryByText('deploymentQueue.empty')).not.toBeInTheDocument(); });
  it('uses a fresh issue revision and actual blank build for deployment, never verification or a new card', async () => {
    render(<DeploymentQueueView />); fireEvent.click(await screen.findByRole('button', { name: 'deploymentQueue.confirmDeployed' }));
    await waitFor(() => expect(state.command).toHaveBeenCalledWith(expect.objectContaining({ version: 9 }), { type: 'record_deployment', targetId: 'target', build: '', evidence: '' }, expect.any(String)));
    expect(state.get).toHaveBeenCalledWith('example-bug'); expect(state.command).toHaveBeenCalledTimes(1);
  });
  it('blocks a target changed or deployed after the list read and preserves an error', async () => {
    state.get.mockResolvedValue({ issue: { ...issue, targets: [] } }); render(<DeploymentQueueView />); fireEvent.click(await screen.findByRole('button', { name: 'deploymentQueue.confirmDeployed' }));
    expect(await screen.findByText('deploymentQueue.writeFailed')).toBeInTheDocument(); expect(state.command).not.toHaveBeenCalled();
  });
  it.each([true, false])('keeps a failed or uncounted task acquisition unknown (error=%s)', async error => {
    state.taskError = error; if (!error) state.taskCount = null; state.list.mockResolvedValue({ issues: [], total: 0, hasMore: false }); render(<DeploymentQueueView />);
    expect(await screen.findByText('deploymentQueue.incomplete')).toBeInTheDocument(); expect(screen.queryByText('deploymentQueue.empty')).not.toBeInTheDocument(); expect(screen.getByText(/deploymentQueue.tasks · deploymentQueue.unknownCount/)).toBeInTheDocument();
  });
  it('keeps QA denied reads unknown while task rows are available', async () => { state.list.mockRejectedValue(new Error('denied')); render(<DeploymentQueueView />); expect(await screen.findByText('deploymentQueue.incomplete')).toBeInTheDocument(); expect(await screen.findByText('EX-1 · Example Task')).toBeInTheDocument(); expect(screen.queryByText('deploymentQueue.empty')).not.toBeInTheDocument(); });
  it('does not expose settings or deployment controls to an ordinary unconfigured member', async () => { state.operator = false; render(<DeploymentQueueView />); await screen.findByText('Example Bug'); expect(screen.queryByRole('button', { name: 'deploymentQueue.confirmDeployed' })).not.toBeInTheDocument(); expect(screen.queryByText('deploymentQueue.settings')).not.toBeInTheDocument(); });
  it('keeps a regular admin unable to configure operators', async () => { state.member = { ...state.member, role: 'admin' }; render(<DeploymentQueueView />); await screen.findByText('Example Bug'); expect(screen.queryByText('deploymentQueue.settings')).not.toBeInTheDocument(); expect(state.save).not.toHaveBeenCalled(); });
  it('lets only a super admin save configured existing statuses and members with the observed revision', async () => { state.member = { ...state.member, role: 'super_admin' }; render(<DeploymentQueueView />); await screen.findByText('Example Bug'); fireEvent.click(screen.getByText('deploymentQueue.settings')); fireEvent.click(screen.getByRole('checkbox', { name: 'Example Operator' })); fireEvent.click(screen.getByRole('button', { name: 'deploymentQueue.save' })); await waitFor(() => expect(state.save).toHaveBeenCalledWith({ version: 1, enabled: true, taskStatusIds: ['wait'], operatorMemberIds: [] }, 'revision-1')); });
  it('keeps a failed save visible when a remote configuration refresh arrives', async () => { state.member = { ...state.member, role: 'super_admin' }; state.save.mockRejectedValue(new Error('conflict')); const { rerender } = render(<DeploymentQueueView />); await screen.findByText('Example Bug'); fireEvent.click(screen.getByRole('button', { name: 'deploymentQueue.save' })); expect(await screen.findByText('deploymentQueue.settingsFailed')).toBeInTheDocument(); state.revision = 'revision-remote'; rerender(<DeploymentQueueView />); expect(screen.getByText('deploymentQueue.settingsFailed')).toBeInTheDocument(); });
  it('refreshes current QA targets through the member API every thirty visible seconds', async () => {
    vi.useFakeTimers(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { render(<DeploymentQueueView />); });
    expect(screen.getByText('Example Bug')).toBeInTheDocument(); expect(state.list).toHaveBeenCalledTimes(1);
    state.list.mockResolvedValue({ issues: [{ ...issue, title: 'New QA target from another session', targets: [{ ...issue.targets[0], id: 'fresh-target', environment: 'Production' }] }], total: 1, hasMore: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.getByText('New QA target from another session')).toBeInTheDocument(); expect(screen.queryByText('Example Bug')).not.toBeInTheDocument(); expect(state.list).toHaveBeenCalledTimes(2);
    state.list.mockResolvedValue({ issues: [], total: 0, hasMore: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.queryByText('New QA target from another session')).not.toBeInTheDocument();
  });
  it('does not poll hidden pages, refreshes on return and removes timers and listeners on unmount', async () => {
    vi.useFakeTimers(); let visibility = 'hidden'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    let view: ReturnType<typeof render>;
    await act(async () => { view = render(<DeploymentQueueView />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(state.list).toHaveBeenCalledTimes(1);
    visibility = 'visible'; await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(state.list).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new Event('focus')); }); expect(state.list).toHaveBeenCalledTimes(3);
    view!.unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(30000); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    expect(state.list).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
  });
  it('opens the original task without creating or changing it', async () => { render(<DeploymentQueueView />); await screen.findByText('EX-1 · Example Task'); fireEvent.click(screen.getAllByRole('button', { name: 'deploymentQueue.openCard' })[0]); expect(state.open).toHaveBeenCalledWith(expect.objectContaining({ id: 'example-task' })); expect(state.view).toHaveBeenCalledWith('my-tasks'); expect(state.command).not.toHaveBeenCalled(); });
});
