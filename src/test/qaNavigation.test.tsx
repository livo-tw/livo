import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ProductLine, Task } from '@/types';
import type { QaCreateInput } from '@/lib/qa/domain';
const mocks = vi.hoisted(() => ({ selectedProjectId: null as string | null, role: 'admin', qaAdmin: false, create: vi.fn(), upload: vi.fn(), get: vi.fn(), list: vi.fn(), versions: vi.fn(), getWorkflow: vi.fn(), getFieldConfiguration: vi.fn(), getCoordination: vi.fn(), command: vi.fn(), comment: vi.fn() }));
// Keep initialization exports available when an import graph loads the real i18n singleton.
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
import '@/i18n';
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ featureToggles: { qa: true }, featureTogglesReady: true, taskDisplayMode: 'modal', setTaskDisplayMode: vi.fn(), setSelectedTask: vi.fn() }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [{ id: 'admin', name: 'Example admin', jobTitle: '', role: 'admin', isActive: true }] }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [{ id: 'p1', name: 'Example project', isArchived: false }, { id: 'p2', name: 'Other project', isArchived: false }], productLines: [] as ProductLine[], selectedProjectId: mocks.selectedProjectId, setSelectedProjectId: vi.fn() }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [] as Task[] }) }));
vi.mock('@/context/DeploymentEnvironmentContext', () => ({ useDeploymentEnvironments: () => ({ values: ['Stage'], ready: true, loadError: false }) }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: {} }));
vi.mock('@/hooks/useQa', () => {
  const client = { create: mocks.create, upload: mocks.upload, get: mocks.get, list: mocks.list, versions: mocks.versions, getWorkflow: mocks.getWorkflow, getFieldConfiguration: mocks.getFieldConfiguration, getCoordination: mocks.getCoordination, command: mocks.command, comment: mocks.comment };
  return { useQa: () => ({ client, actor: { id: 'admin', role: mocks.role, qaAdmin: mocks.qaAdmin }, enabled: true }) };
});
// Kanban loading is unrelated to navigation protection. The Workspace, create
// form, attachment queue and issue-detail busy logic remain real components.
vi.mock('@/components/qa/QaKanban', () => ({ default: (): null => null }));
import QaWorkspace from '@/components/qa/QaWorkspace';
import QaIssueDetail from '@/components/qa/QaIssueDetail';
import { createQaIssue, type QaDetail } from '@/lib/qa/domain';
import type { QaClient } from '@/lib/qa/client';
import { DEFAULT_QA_WORKFLOW } from '@/lib/qa/workflow';

const input: QaCreateInput = { projectId: 'p1', title: 'Example navigation Bug', actual: 'Unexpected result', observedEnvironment: 'Stage' };
const issue = createQaIssue(input, 'existing-bug', { actor: { id: 'admin', role: 'admin' }, workspaceId: 'example-workspace', now: '2026-10-03T00:00:00Z', newId: () => 'example-event', memberIds: new Set(['admin']), projectIds: new Set(['p1', 'p2']), taskIds: new Set() });
const detail: QaDetail = { issue, attachments: [], comments: [], events: [] };
const file = () => new File(['video'], 'proof.mp4', { type: 'video/mp4' });
const fillCreate = () => {
  fireEvent.change(screen.getByLabelText(/^qa.project \*$/), { target: { value: 'p1' } });
  fireEvent.change(screen.getByLabelText(/qa.titleField/), { target: { value: input.title } });
  fireEvent.change(screen.getByLabelText(/qa.actual/), { target: { value: input.actual } });
  fireEvent.change(screen.getByLabelText(/qa.environment/), { target: { value: input.observedEnvironment } });
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.role = 'admin'; mocks.qaAdmin = false; mocks.getFieldConfiguration.mockResolvedValue({ version: 1, fields: [] }); vi.stubEnv('VITE_API_URL', ''); mocks.selectedProjectId = null; window.history.replaceState({}, '', '/');
  mocks.getWorkflow.mockResolvedValue(structuredClone(DEFAULT_QA_WORKFLOW)); mocks.versions.mockResolvedValue([]);
  mocks.getCoordination.mockImplementation(async (projectId: string) => ({ projectId, coordinatorId: null, version: 0 }));
  mocks.list.mockResolvedValue({ issues: [], total: 0, hasMore: false });
  mocks.create.mockImplementation(async (_input: QaCreateInput, id: string) => ({ ...issue, id }));
  mocks.get.mockImplementation(async (id: string) => ({ ...detail, issue: { ...issue, id } }));
  mocks.upload.mockResolvedValue({ id: 'attachment1' });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe('QA navigation preserves pending work', () => {
  const handoffIssue = (): QaDetail['issue'] & { handoff: NonNullable<QaDetail['issue']['handoff']> } => ({ ...issue, version: 4, handoff: { id: 'handoff-one', reason: 'Need another owner', nextOwnerId: 'admin', replyBy: null, externalDependency: '', requestedBy: 'reporter', requestedAt: issue.createdAt, acceptedBy: null, acceptedAt: null, resolvedBy: null, resolvedAt: null, resolutionEvidence: '' } });
  it('retries an uncertain handoff with its original issue version and command identity after incoming updates', async () => {
    const current = handoffIssue(), accepted = { ...current, version: 5, handoff: { ...current.handoff, acceptedBy: 'admin', acceptedAt: issue.createdAt } };
    mocks.command.mockRejectedValueOnce(new TypeError('connection lost')).mockResolvedValueOnce(accepted);
    const client = { getFieldConfiguration: mocks.getFieldConfiguration, command: mocks.command } as unknown as QaClient;
    const props = { detail: { ...detail, issue: current }, client, actor: { id: 'admin', role: 'admin' }, onRefresh: vi.fn().mockResolvedValue(undefined), onBack: vi.fn() };
    const view = render(<QaIssueDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'qa.moreActions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'qaHandoff.title' }));
    await screen.findByRole('dialog', { name: 'qaHandoff.title' });
    fireEvent.click(screen.getByRole('button', { name: 'qaHandoff.accept' }));
    await screen.findByText('qa.commandRetryHint'); const original = mocks.command.mock.calls[0];
    view.rerender(<QaIssueDetail {...props} detail={{ ...detail, issue: { ...current, version: 7 } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'qa.retryCommand' }));
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalledTimes(1));
    expect(mocks.command.mock.calls[1]).toEqual(original); expect(original[0].version).toBe(4);
    expect(original[1]).toEqual({ type: 'accept_handoff', handoffId: 'handoff-one' });
  });
  it('keeps a confirmed handoff visible when only the refresh fails without offering a mutation retry', async () => {
    const current = handoffIssue(), accepted = { ...current, version: 5, handoff: { ...current.handoff, acceptedBy: 'admin', acceptedAt: issue.createdAt } };
    mocks.command.mockResolvedValue(accepted); const onRefresh = vi.fn().mockRejectedValueOnce(new TypeError('reload unavailable')).mockResolvedValue(undefined);
    const client = { getFieldConfiguration: mocks.getFieldConfiguration, command: mocks.command } as unknown as QaClient;
    render(<QaIssueDetail detail={{ ...detail, issue: current }} client={client} actor={{ id: 'admin', role: 'admin' }} onRefresh={onRefresh} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'qa.moreActions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'qaHandoff.title' }));
    await screen.findByRole('dialog', { name: 'qaHandoff.title' });
    fireEvent.click(screen.getByRole('button', { name: 'qaHandoff.accept' })); await screen.findByText('qaHandoff.savedRefreshFailed');
    expect(screen.queryByRole('button', { name: 'qaHandoff.accept' })).toBeNull(); expect(screen.queryByRole('button', { name: 'qa.retryCommand' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'qa.refresh' })); await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2)); expect(mocks.command).toHaveBeenCalledTimes(1);
  });
  it.each(['submit_fix', 'close'] as const)('retries an uncertain %s inside its dialog with the original revision and command ID', async action => {
    const target = { id: 'target-one', environment: 'Stage', component: '', build: 'release-one', required: true, deployedAt: issue.createdAt, deployedBy: 'admin', deploymentEvidence: '' };
    const current = { ...issue, state: action === 'close' ? 'verified' as const : 'in_progress' as const, version: 4, fixCycle: 1, assigneeId: 'admin', qaOwnerId: 'admin', targets: action === 'close' ? [target] : [], runs: action === 'close' ? [{ id: 'run-one', sequence: 1, fixCycle: 1, targetId: target.id, environment: target.environment, component: '', build: target.build, result: 'pass' as const, note: '', testerId: 'admin', createdAt: issue.createdAt }] : [] };
    mocks.command.mockRejectedValueOnce(new TypeError('connection lost')).mockResolvedValueOnce({ ...current, version: 5 });
    const props = { detail: { ...detail, issue: current }, client: { getFieldConfiguration: mocks.getFieldConfiguration, versions: mocks.versions, command: mocks.command } as unknown as QaClient, actor: { id: 'admin', role: 'admin' }, initialAction: action, onRefresh: vi.fn().mockResolvedValue(undefined), onBack: vi.fn() };
    const view = render(<QaIssueDetail {...props} />);
    const dialog = await screen.findByRole('dialog', { name: action === 'close' ? 'qa.close' : 'qa.submitFix' });
    if (action === 'close') fireEvent.change(within(dialog).getByLabelText(/qa.resolutionField/), { target: { value: 'fixed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'qa.save' }));
    await screen.findByText('qa.commandRetryHint'); const original = mocks.command.mock.calls[0];
    expect(screen.getAllByRole('button', { name: 'qa.retryCommand' })).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'qa.save' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'qa.cancel' })).toBeDisabled();
    view.rerender(<QaIssueDetail {...props} detail={{ ...detail, issue: { ...current, version: 7 } }} />);
    fireEvent.click(within(dialog).getByRole('button', { name: 'qa.retryCommand' }));
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalledOnce());
    expect(mocks.command).toHaveBeenCalledTimes(2); expect(mocks.command.mock.calls[1]).toEqual(original); expect(original[0].version).toBe(4);
    expect(original[1]).toMatchObject(action === 'close' ? { type: 'close', resolution: 'fixed', reason: '' } : { type: 'submit_fix', summary: '', targets: [{ environment: 'Stage', component: '', build: '', required: true }] });
    expect(screen.queryByRole('button', { name: 'qa.retryCommand' })).toBeNull();
  });
  it('closes an acknowledged repair dialog and only reloads after a failed refresh, preserving the saved result', async () => {
    const current = { ...issue, state: 'in_progress' as const, version: 4, assigneeId: 'admin', qaOwnerId: 'admin' };
    mocks.command.mockResolvedValue({ ...current, state: 'verification', version: 5 });
    const onRefresh = vi.fn().mockRejectedValueOnce(new TypeError('read failed')).mockResolvedValue(undefined);
    render(<QaIssueDetail detail={{ ...detail, issue: current }} client={{ getFieldConfiguration: mocks.getFieldConfiguration, versions: mocks.versions, command: mocks.command } as unknown as QaClient} actor={{ id: 'admin', role: 'admin' }} initialAction="submit_fix" onRefresh={onRefresh} onBack={vi.fn()} />);
    const dialog = await screen.findByRole('dialog', { name: 'qa.submitFix' }); fireEvent.click(within(dialog).getByRole('button', { name: 'qa.save' }));
    await screen.findByText('qaHandoff.savedRefreshFailed'); expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'qa.retryCommand' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'qa.refresh' })); await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2)); expect(mocks.command).toHaveBeenCalledOnce();
  });
  it('keeps QA configuration delegation separate from project coordinator appointment', async () => {
    mocks.role = 'member'; mocks.qaAdmin = true; mocks.selectedProjectId = 'p1'; render(<QaWorkspace />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'qa.settingsTitle' })).not.toBeDisabled());
    expect(screen.queryByRole('button', { name: 'qaHandoff.coordinatorTitle' })).toBeNull();
  });
  it('ignores a repeated toolbar create while retrying an unknown result, preserving both IDs and payload', async () => {
    mocks.create.mockRejectedValueOnce(new TypeError('connection lost'));
    render(<QaWorkspace />); await waitFor(() => expect(mocks.getWorkflow).toHaveBeenCalledTimes(1));
    fireEvent(window, new Event('livo:qa-create')); fillCreate();
    const draftTitle = screen.getByLabelText(/qa.titleField/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'qa.createBug' })).not.toBeDisabled()); fireEvent.click(screen.getByRole('button', { name: 'qa.createBug' }));
    await screen.findByText('qa.createRetryHint'); expect(mocks.create).toHaveBeenCalledTimes(1);
    const original = mocks.create.mock.calls[0].slice(0, 3);
    fireEvent(window, new Event('livo:qa-create'));
    expect(screen.getByLabelText(/qa.titleField/)).toBe(draftTitle);
    fireEvent.click(screen.getByRole('button', { name: 'qa.retryCreate' }));
    await screen.findByRole('heading', { name: input.title, level: 1 });
    expect(mocks.create).toHaveBeenCalledTimes(2); expect(mocks.create.mock.calls[1].slice(0, 3)).toEqual(original);
    expect(new URL(window.location.href).searchParams.get('qa')).toBe(original[1]);
  });
  it.each(['livo:qa-navigation', 'popstate', 'selected-project'] as const)('keeps the create form mounted during upload when %s occurs', async navigation => {
    let resolveUpload!: (value: unknown) => void;
    mocks.upload.mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; }));
    const view = render(<QaWorkspace />); await waitFor(() => expect(mocks.getWorkflow).toHaveBeenCalledTimes(1));
    fireEvent(window, new Event('livo:qa-create')); fillCreate();
    fireEvent.change(screen.getByLabelText('qa.attach'), { target: { files: [file()] } });
    const draftTitle = screen.getByLabelText(/qa.titleField/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'qa.createBug' })).not.toBeDisabled()); fireEvent.click(screen.getByRole('button', { name: 'qa.createBug' }));
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    const signal = mocks.upload.mock.calls[0][3] as AbortSignal;
    if (navigation === 'selected-project') { mocks.selectedProjectId = 'p2'; view.rerender(<QaWorkspace />); }
    else { window.history.replaceState({}, '', '/?qa=other-bug'); fireEvent(window, new Event(navigation)); }
    expect(screen.getByLabelText(/qa.titleField/)).toBe(draftTitle); expect(draftTitle).toHaveValue(input.title);
    expect(signal.aborted).toBe(false); expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.get).not.toHaveBeenCalled();
    await act(async () => resolveUpload({ id: 'attachment1' }));
    await screen.findByRole('heading', { name: input.title, level: 1 });
    expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(new URL(window.location.href).searchParams.get('qa')).toBe(mocks.create.mock.calls[0][1]);
  });
  it('allows a fresh toolbar draft after an explicit cancellation', async () => {
    render(<QaWorkspace />); await waitFor(() => expect(mocks.getWorkflow).toHaveBeenCalledTimes(1));
    fireEvent(window, new Event('livo:qa-create')); fillCreate();
    fireEvent.click(screen.getByRole('button', { name: 'qa.cancel' }));
    expect(screen.queryByLabelText(/qa.titleField/)).toBeNull();
    fireEvent(window, new Event('livo:qa-create')); expect(screen.getByLabelText(/qa.titleField/)).toHaveValue('');
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('locks detail tabs, Back and Refresh through attachment upload and reload, then restores navigation', async () => {
    let resolveUpload!: (value: unknown) => void, resolveRefresh!: () => void;
    mocks.upload.mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; }));
    const onRefresh = vi.fn(() => new Promise<void>(resolve => { resolveRefresh = resolve; })), onBack = vi.fn();
    const client = { getFieldConfiguration: mocks.getFieldConfiguration, upload: mocks.upload, versions: mocks.versions } as unknown as QaClient;
    render(<QaIssueDetail detail={detail} client={client} actor={{ id: 'admin', role: 'admin' }} onRefresh={onRefresh} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'qa.addAttachment' }));
    const attachmentInput = screen.getByLabelText('qa.attach');
    fireEvent.change(attachmentInput, { target: { files: [file()] } });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    const signal = mocks.upload.mock.calls[0][3] as AbortSignal;
    const back = screen.getByRole('button', { name: 'qa.back' }), refresh = screen.getByRole('button', { name: 'qa.refresh' });
    const comments = screen.getByRole('tab', { name: /qa.comments/ });
    for (const tab of screen.getAllByRole('tab')) expect(tab).toBeDisabled(); expect(back).toBeDisabled(); expect(refresh).toBeDisabled();
    fireEvent.click(comments); fireEvent.click(back); fireEvent.click(refresh);
    expect(screen.getByLabelText('qa.attach')).toBe(attachmentInput); expect(signal.aborted).toBe(false);
    expect(onBack).not.toHaveBeenCalled(); expect(onRefresh).not.toHaveBeenCalled();
    await act(async () => resolveUpload({ id: 'attachment1' }));
    expect(onRefresh).toHaveBeenCalledTimes(1); expect(back).toBeDisabled(); expect(refresh).toBeDisabled(); expect(comments).toBeDisabled();
    await act(async () => resolveRefresh());
    await waitFor(() => expect(back).not.toBeDisabled()); expect(refresh).not.toBeDisabled(); expect(comments).not.toBeDisabled();
    fireEvent.click(comments); expect(screen.queryByLabelText('qa.attach')).toBeNull(); expect(screen.getByLabelText(/qa.commentBody/)).toBeTruthy();
    fireEvent.click(back); expect(onBack).toHaveBeenCalledTimes(1);
  });
});
