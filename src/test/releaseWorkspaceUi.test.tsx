import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReleaseBatch, ReleaseResult, ReleaseQaSource, ReleaseContext } from '@/lib/releases/core';
import { ReleaseError } from '@/lib/releases/core';
import type { ProductLine, Project, Task, User } from '@/types';
const mocks = vi.hoisted(() => ({ role: 'admin', id: 'admin', context: null as (() => ReleaseContext) | null, list: vi.fn(), get: vi.fn(), events: vi.fn(), execute: vi.fn(), qaList: vi.fn(), qaGet: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMember: { id: mocks.id, role: mocks.role } }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [{ id: 'project-one', name: 'Project one', lineId: 'line-one' }, { id: 'archived', name: 'Archived project', lineId: 'line-one', isArchived: true }], productLines: [{ id: 'line-one', name: 'Example line' }] }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [{ id: 'admin', name: 'Example admin', isActive: true }] }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [] as Task[] }) }));
vi.mock('@/context/DeploymentEnvironmentContext', () => ({ useDeploymentEnvironments: () => ({ values: ['Stage', 'Production'], ready: true }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {}, USING_MOCK_BACKEND: false }));
vi.mock('@/lib/releases/client', () => ({ createReleaseClient: (options: { context: () => ReleaseContext }) => { mocks.context = options.context; return { list: mocks.list, get: mocks.get, events: mocks.events, execute: mocks.execute }; } }));
vi.mock('@/hooks/useQa', () => { const client = { list: mocks.qaList, get: mocks.qaGet }; return { useQa: () => ({ client, enabled: true }) }; });
import ReleaseWorkspaceView from '@/components/releases/ReleaseWorkspaceView';
import ReleaseManifestForm, { type ReleaseResources } from '@/components/releases/ReleaseManifestForm';
import ReleaseActionForm from '@/components/releases/ReleaseActionForm';
import ReleaseDetail from '@/components/releases/ReleaseDetail';
import ReleaseQaPicker from '@/components/releases/ReleaseQaPicker';
import { ReleaseLink, type ReleaseClient } from '@/components/releases/ReleaseFields';
import type { QaClient } from '@/lib/qa/client';
import { clearReleaseNavigationGuards, hasReleaseNavigationGuard } from '@/components/releases/navigation';
import tw from '@/i18n/locales/zh-TW.json';
import cn from '@/i18n/locales/zh-CN.json';
import en from '@/i18n/locales/en.json';

const batch = (): ReleaseBatch => ({ id: 'release-one', workspaceId: 'default', title: 'Synthetic release', ownerId: 'admin', status: 'draft', version: 3, manifestRevision: 2,
  components: [{ id: 'component-one', name: 'Frontend', projectId: 'project-one', taskIds: [], targets: [{ environment: 'Stage', build: 'v1.2', config: 'cfg1', data: 'data1' }] }],
  evidence: [], exceptions: [], attempts: [], maintenance: [], createdBy: 'admin', createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', closureNote: null });
const resources: ReleaseResources = { projects: [{ id: 'project-one', name: 'Project one', lineId: 'line-one', isArchived: false }, { id: 'project-two', name: 'Project two', lineId: 'line-two', isArchived: false }, { id: 'archived', name: 'Archived project', lineId: 'line-one', isArchived: true }] as Project[],
  productLines: [{ id: 'line-one', name: 'Line One' }, { id: 'line-two', name: 'Line Two' }] as ProductLine[], users: [{ id: 'admin', name: 'Example admin', isActive: true }] as User[],
  tasks: [{ id: 'task-one', taskKey: 'EX-1', title: 'Synthetic task', projectId: 'project-one' }, { id: 'task-two', taskKey: 'EX-2', title: 'Other task', projectId: 'project-two' }] as Task[], environments: ['Stage', 'Production'], environmentsReady: true };
const client = { list: mocks.list, get: mocks.get, events: mocks.events, execute: mocks.execute } as ReleaseClient;
const qaClient = { list: mocks.qaList, get: mocks.qaGet } as unknown as QaClient;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const result = (value = batch()): ReleaseResult => ({ batch: value, commandId: 'synthetic-command', replayed: false, event: { id: 'event', batchId: value.id, actorId: 'admin', operation: 'create', version: value.version, revision: value.manifestRevision, createdAt: value.createdAt } });
const submit = () => fireEvent.submit(screen.getByRole('button', { name: 'releaseWorkspace.confirmSave' }).closest('form')!);
const actionProps = () => ({ batch: batch(), action: 'request_exception' as const, client, qaClient, qaEnabled: true, onSource: vi.fn(), onSaved: vi.fn(), onCancel: vi.fn() });
beforeEach(() => { vi.clearAllMocks(); mocks.role = 'admin'; mocks.id = 'admin'; window.history.replaceState({}, '', '/'); mocks.list.mockResolvedValue({ batches: [], page: 0, hasMore: false }); mocks.get.mockResolvedValue(batch()); mocks.events.mockResolvedValue({ events: [], page: 0, hasMore: false }); mocks.execute.mockResolvedValue(result()); mocks.qaList.mockResolvedValue({ issues: [], total: 0, hasMore: false }); });
afterEach(() => { cleanup(); clearReleaseNavigationGuards(); });

describe('Release workspace frontend', () => {
  it('retains readable archived project scope without granting it for new writes', async () => {
    render(<ReleaseWorkspaceView />); await screen.findByText('releaseWorkspace.empty'); const context = mocks.context!(); expect(context.projectIds.has('archived')).toBe(false); expect(context.visibleProjectIds?.has('archived')).toBe(true);
  });
  it('renders read-only members without create or mutation controls', async () => {
    mocks.role = 'member'; window.history.replaceState({}, '', '/?release=release-one'); render(<ReleaseWorkspaceView />);
    await screen.findByRole('heading', { name: 'Synthetic release' });
    expect(mocks.get).toHaveBeenCalledWith('release-one'); expect(screen.queryByRole('button', { name: 'releaseWorkspace.editManifest' })).toBeNull(); expect(screen.getByText('releaseWorkspace.readOnly')).toBeInTheDocument();
  });
  it('paginates server results and discards old filter responses', async () => {
    const late = deferred<{ batches: ReleaseBatch[]; page: number; hasMore: boolean }>(); mocks.list.mockReturnValueOnce(late.promise).mockResolvedValue({ batches: [], page: 0, hasMore: true }); render(<ReleaseWorkspaceView />);
    fireEvent.change(screen.getByLabelText('releaseWorkspace.search'), { target: { value: 'new-filter' } }); fireEvent.click(screen.getByRole('button', { name: 'releaseWorkspace.search' }));
    await screen.findByText('releaseWorkspace.empty'); await act(async () => late.resolve({ batches: [batch()], page: 0, hasMore: false })); expect(screen.queryByText('Synthetic release')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'releaseWorkspace.next' })); await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(1, undefined, 'new-filter'));
  });
  it('unmounts private detail when the actor changes and ignores its late response', async () => {
    const late = deferred<ReleaseBatch>(); mocks.get.mockReturnValueOnce(late.promise).mockRejectedValue(new ReleaseError('release_not_found', 404)); window.history.replaceState({}, '', '/?release=release-one');
    const view = render(<ReleaseWorkspaceView />); mocks.id = 'another-member'; view.rerender(<ReleaseWorkspaceView />); await screen.findByRole('alert'); await act(async () => late.resolve(batch())); expect(screen.queryByText('Synthetic release')).toBeNull();
  });
  it('groups active project choices by product line and shows task key plus title', () => {
    render(<ReleaseManifestForm actorId="admin" resources={resources} client={client} onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Line One' })).toBeInTheDocument(); expect(screen.getByRole('group', { name: 'Line Two' })).toBeInTheDocument(); expect(screen.queryByRole('option', { name: 'Archived project' })).toBeNull();
    fireEvent.change(screen.getByLabelText('releaseWorkspace.project'), { target: { value: 'project-one' } }); expect(screen.getByLabelText('EX-1 · Synthetic task')).toBeInTheDocument(); expect(screen.queryByLabelText('EX-2 · Other task')).toBeNull();
  });
  it('creates an explicit manifest without changing tasks or deploying', async () => {
    const onSaved = vi.fn(); render(<ReleaseManifestForm actorId="admin" resources={resources} client={client} onSaved={onSaved} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('releaseWorkspace.titleField'), { target: { value: 'Reviewed release' } });
    fireEvent.change(screen.getByLabelText('releaseWorkspace.component'), { target: { value: 'Frontend' } }); fireEvent.change(screen.getByLabelText('releaseWorkspace.project'), { target: { value: 'project-one' } }); fireEvent.click(screen.getByLabelText('EX-1 · Synthetic task'));
    fireEvent.change(screen.getByLabelText('releaseWorkspace.environment'), { target: { value: 'Stage' } }); for (const field of ['build', 'config', 'data']) fireEvent.change(screen.getByLabelText(`releaseWorkspace.${field}`), { target: { value: field + '-v1' } });
    expect(screen.getByLabelText('releaseWorkspace.confirmManifest')).toBeRequired(); submit(); await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mocks.execute.mock.calls[0][0]).toMatchObject({ operation: 'create', expectedVersion: 0, manifest: { title: 'Reviewed release', components: [{ projectId: 'project-one', taskIds: ['task-one'], targets: [{ environment: 'Stage', build: 'build-v1', config: 'config-v1', data: 'data-v1' }] }] } });
  });
  it('uses the successful returned record without reinvoking a known save for refresh', async () => {
    mocks.get.mockRejectedValue(new Error('a later refresh could fail')); render(<ReleaseWorkspaceView />); fireEvent.click(screen.getByRole('button', { name: 'releaseWorkspace.create' }));
    submit(); await screen.findByRole('heading', { name: 'Synthetic release' }); expect(mocks.execute).toHaveBeenCalledTimes(1); expect(mocks.get).not.toHaveBeenCalled(); expect(window.location.search).toBe('?release=release-one');
  });
  it('clears task selection when the component project changes', async () => {
    render(<ReleaseManifestForm batch={{ ...batch(), components: [{ ...batch().components[0], taskIds: ['task-one'] }] }} actorId="admin" resources={resources} client={client} onSaved={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('releaseWorkspace.project'), { target: { value: 'project-two' } }); submit(); await waitFor(() => expect(mocks.execute).toHaveBeenCalled()); expect(mocks.execute.mock.calls[0][0].manifest.components[0].taskIds).toEqual([]);
  });
  it('allows cancellation when the environment catalog is unavailable', () => {
    const cancel = vi.fn(); render(<ReleaseManifestForm actorId="admin" resources={{ ...resources, environmentsReady: false }} client={client} onSaved={vi.fn()} onCancel={cancel} />);
    expect(screen.getByRole('button', { name: 'releaseWorkspace.confirmSave' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: 'releaseWorkspace.cancelForm' })); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('keeps cancellation available before an attempt has any components selected', () => {
    const props = actionProps(); render(<ReleaseActionForm {...props} action="start_attempt" />); expect(screen.getByRole('button', { name: 'releaseWorkspace.confirmSave' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: 'releaseWorkspace.cancelForm' })); expect(props.onCancel).toHaveBeenCalledTimes(1);
  });
  it('pins the original record version and retries an uncertain result with identical contents', async () => {
    mocks.execute.mockRejectedValueOnce(new ReleaseError('release_transport_error', 503)); const props = actionProps(); const view = render(<ReleaseActionForm {...props} />);
    fireEvent.change(screen.getByLabelText('releaseWorkspace.exceptionScope'), { target: { value: 'Staging only' } }); fireEvent.change(screen.getByLabelText('releaseWorkspace.reason'), { target: { value: 'Explicit exception' } }); submit(); await screen.findByText('releaseWorkspace.retryHint');
    const original = structuredClone(mocks.execute.mock.calls[0][0]); view.rerender(<ReleaseActionForm {...props} batch={{ ...batch(), version: 8 }} />);
    expect(screen.getByLabelText('releaseWorkspace.reason')).toBeDisabled(); expect(screen.getByRole('button', { name: 'releaseWorkspace.cancelForm' })).toBeDisabled(); expect(hasReleaseNavigationGuard()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'releaseWorkspace.retry' })); await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1)); expect(mocks.execute.mock.calls[1][0]).toEqual(original); expect(original.expectedVersion).toBe(3);
  });
  it('prevents double submits while a mutation is in flight', async () => {
    const late = deferred<ReleaseResult>(); mocks.execute.mockReturnValue(late.promise); const props = actionProps(); render(<ReleaseActionForm {...props} />); submit(); fireEvent.submit(screen.getByRole('button', { name: 'releaseWorkspace.saving' }).closest('form')!); expect(mocks.execute).toHaveBeenCalledTimes(1); await act(async () => late.resolve(result()));
  });
  it('lets the user leave a rejected stale form without upgrading its version', async () => {
    mocks.execute.mockRejectedValue(new ReleaseError('release_conflict', 409)); const props = actionProps(); render(<ReleaseActionForm {...props} />); submit(); await screen.findByText('releaseWorkspace.errors.release_conflict'); expect(screen.getByRole('button', { name: 'releaseWorkspace.cancelForm' })).not.toBeDisabled(); expect(mocks.execute.mock.calls[0][0].expectedVersion).toBe(3);
  });
  it('reviews the complete target manifest for completion and cancellation', () => {
    render(<ReleaseActionForm {...actionProps()} action="complete" />); expect(screen.getByText('Synthetic release')).toBeInTheDocument(); expect(screen.getByText('Frontend · Stage · v1.2 / cfg1 / data1')).toBeInTheDocument(); expect(screen.getByLabelText('releaseWorkspace.confirmRecord')).toBeRequired();
  });
  it('displays historical evidence without treating it as current verification', () => {
    const value = batch(); value.evidence = [{ id: 'old-proof', revision: 1, componentId: 'component-one', environment: 'Stage', kind: 'uat', note: '<script>unsafe</script>', url: 'javascript:alert(1)', actorId: 'admin', createdAt: value.createdAt }];
    render(<ReleaseDetail batch={value} resources={resources} client={client} actorId="admin" canManage={false} qaClient={qaClient} qaEnabled onSource={vi.fn()} onSaved={vi.fn()} onBack={vi.fn()} onRefresh={vi.fn()} />); expect(screen.getByText(/releaseWorkspace.priorEvidence/)).toBeInTheDocument(); expect(screen.getByText('<script>unsafe</script>')).toBeInTheDocument(); expect(document.querySelector('script')).toBeNull(); expect(screen.queryByRole('link')).toBeNull();
  });
  it.each(['completed', 'cancelled'] as const)('adds historical results to a %s batch while keeping its closure visible', async status => {
    const value = { ...batch(), status, closureNote: 'Original closure decision' };
    mocks.get.mockResolvedValue(value); mocks.execute.mockResolvedValue(result({ ...value, version: value.version + 1 }));
    window.history.replaceState({}, '', '/?release=release-one'); render(<ReleaseWorkspaceView />);
    await screen.findByRole('heading', { name: 'Synthetic release' });
    for (const operation of ['start_attempt', 'link_evidence', 'complete', 'cancel']) expect(screen.queryByRole('button', { name: `releaseWorkspace.operations.${operation}` })).toBeNull();
    expect(screen.queryByRole('button', { name: 'releaseWorkspace.editManifest' })).toBeNull();
    expect(screen.getByRole('button', { name: 'releaseWorkspace.operations.record_maintenance' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'releaseWorkspace.operations.record_result' }));
    expect(within(screen.getByLabelText('releaseWorkspace.result')).getAllByRole('option').map(o => (o as HTMLOptionElement).value)).toEqual(['rollback', 'recovery']);
    expect(screen.getByText(`releaseWorkspace.statuses.${status}`)).toBeInTheDocument(); expect(screen.getByText('Original closure decision')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('releaseWorkspace.result'), { target: { value: 'recovery' } }); submit();
    await screen.findByRole('heading', { name: 'Synthetic release' });
    expect(mocks.execute.mock.calls[0][0]).toMatchObject({ operation: 'record_result', type: 'recovery', expectedVersion: 3 });
    expect(screen.getByText(new RegExp(`releaseWorkspace.statuses.${status}`))).toBeInTheDocument(); expect(screen.getByText('Original closure decision')).toBeInTheDocument();
  });
  it('records maintenance on a closed batch without exposing other command forms', async () => {
    const props = actionProps(); render(<ReleaseActionForm {...props} batch={{ ...batch(), status: 'completed', closureNote: 'Keep closure' }} action="record_maintenance" />);
    fireEvent.change(screen.getByLabelText('releaseWorkspace.impact'), { target: { value: 'Historical recovery window' } }); submit();
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1)); expect(mocks.execute.mock.calls[0][0]).toMatchObject({ operation: 'record_maintenance', expectedVersion: 3, impact: 'Historical recovery window' });
  });
  it('does not render unsafe or credential-bearing evidence URLs', () => {
    const view = render(<ReleaseLink url="https://user:secret@example.com" />); expect(screen.queryByRole('link')).toBeNull(); view.rerender(<ReleaseLink url="https://example.com/evidence" />); expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  });
  it('offers QA runs only for the exact component, environment, build and fix cycle', async () => {
    const source = { id: 'bug-one', projectId: 'project-one', title: 'Synthetic QA Bug', version: 4, fixCycle: 2, targets: [{ id: 'target-good', environment: 'Stage', component: 'Frontend', build: 'v1.2' }, { id: 'target-other', environment: 'Production', component: 'Frontend', build: 'v1.2' }], runs: [{ id: 'run-good', targetId: 'target-good', fixCycle: 2, result: 'fail', build: 'v1.2', createdAt: '2026-10-03T00:00:00Z' }, { id: 'old-cycle', targetId: 'target-good', fixCycle: 1, result: 'pass', build: 'v1.2' }, { id: 'wrong-env', targetId: 'target-other', fixCycle: 2, result: 'pass', build: 'v1.2' }] };
    mocks.qaList.mockResolvedValue({ issues: [source], total: 1, hasMore: false }); mocks.qaGet.mockResolvedValue({ issue: source }); const choice = vi.fn(), register = vi.fn(); render(<ReleaseQaPicker client={qaClient} component={batch().components[0]} environment="Stage" onChange={choice} onSource={register} />);
    fireEvent.change(await screen.findByLabelText('releaseWorkspace.qaIssue'), { target: { value: 'bug-one' } }); const select = await screen.findByLabelText('releaseWorkspace.qaRun'); expect(within(select).getAllByRole('option')).toHaveLength(2); fireEvent.change(select, { target: { value: 'run-good' } }); expect(choice).toHaveBeenLastCalledWith({ issueId: 'bug-one', issueVersion: 4, targetId: 'target-good', runId: 'run-good' }); expect(register).toHaveBeenCalledWith(source);
  });
  it('reports failed QA reads as unavailable rather than an empty QA result', async () => {
    mocks.qaList.mockRejectedValue(new Error('private server detail')); render(<ReleaseQaPicker client={qaClient} component={batch().components[0]} environment="Stage" onChange={vi.fn()} onSource={vi.fn()} />); expect(await screen.findByRole('alert')).toHaveTextContent('releaseWorkspace.qaUnavailable'); expect(screen.queryByText('releaseWorkspace.noQaMatches')).toBeNull(); expect(screen.queryByText('private server detail')).toBeNull();
  });
  it('discards a late QA detail after the selected issue changes', async () => {
    const source: ReleaseQaSource & { title: string } = { id: 'bug-two', projectId: 'project-one', title: 'Second QA Bug', version: 7, fixCycle: 1, targets: [], runs: [] }; const late = deferred<unknown>();
    mocks.qaList.mockResolvedValue({ issues: [{ ...source, id: 'bug-one', title: 'First QA Bug' }, source], total: 2, hasMore: false }); mocks.qaGet.mockReturnValueOnce(late.promise).mockResolvedValue({ issue: source }); const register = vi.fn();
    render(<ReleaseQaPicker client={qaClient} component={batch().components[0]} environment="Stage" onChange={vi.fn()} onSource={register} />); const select = await screen.findByLabelText('releaseWorkspace.qaIssue'); fireEvent.change(select, { target: { value: 'bug-one' } }); fireEvent.change(select, { target: { value: 'bug-two' } }); await waitFor(() => expect(register).toHaveBeenCalledWith(source));
    await act(async () => late.resolve({ issue: { ...source, id: 'bug-one' } })); expect(register).toHaveBeenCalledTimes(1);
  });
  it('paginates the activity history without replacing the batch contents', async () => {
    mocks.events.mockResolvedValue({ events: [], page: 0, hasMore: true }); render(<ReleaseDetail batch={batch()} resources={resources} client={client} actorId="admin" canManage={false} qaClient={qaClient} qaEnabled onSource={vi.fn()} onSaved={vi.fn()} onBack={vi.fn()} onRefresh={vi.fn()} />); fireEvent.click(await screen.findByRole('button', { name: 'releaseWorkspace.next' })); await waitFor(() => expect(mocks.events).toHaveBeenLastCalledWith('release-one', 1)); expect(screen.getByRole('heading', { name: 'Synthetic release' })).toBeInTheDocument();
  });
  it('keeps matching nonempty translation keys across all three locales', () => {
    const keys = (value: object, prefix = ''): string[] => Object.entries(value).flatMap(([key, v]) => typeof v === 'string' ? (expect(v.trim()).not.toBe(''), [prefix + key]) : keys(v, prefix + key + '.')).sort();
    expect(keys(tw.releaseWorkspace)).toEqual(keys(cn.releaseWorkspace)); expect(keys(en.releaseWorkspace)).toEqual(keys(tw.releaseWorkspace));
  });
});
