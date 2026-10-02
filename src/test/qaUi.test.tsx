import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ enabled: false, ready: true, role: 'admin', list: vi.fn(), get: vi.fn(), getWorkflow: vi.fn(), saveWorkflow: vi.fn(), command: vi.fn(), comment: vi.fn(), useQa: vi.fn(), selected: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ featureToggles: { qa: mocks.enabled }, featureTogglesReady: mocks.ready, setSelectedTask: mocks.selected }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [{ id: 'admin', name: 'Admin', role: 'admin', isActive: true }] }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [{ id: 'p1', name: 'Project', isArchived: false }], selectedProjectId: null as string | null, setSelectedProjectId: vi.fn() }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [] as import('@/types').Task[] }) }));
vi.mock('@/hooks/useQa', () => {
  const client = { list: mocks.list, get: mocks.get, getWorkflow: mocks.getWorkflow, saveWorkflow: mocks.saveWorkflow, command: mocks.command, comment: mocks.comment };
  return { useQa: () => { mocks.useQa(); return { client, actor: { id: 'admin', role: mocks.role }, enabled: mocks.enabled }; } };
});
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: {} }));
import QaWorkspace from '@/components/qa/QaWorkspace';
import QaIssueDetail from '@/components/qa/QaIssueDetail';
import QaAttachments from '@/components/qa/QaAttachments';
import { createQaIssue } from '@/lib/qa/domain';
import { DEFAULT_QA_WORKFLOW } from '@/lib/qa/workflow';
import type { QaDetail } from '@/lib/qa/domain';
import type { QaClient } from '@/lib/qa/client';
const issue = createQaIssue({ projectId: 'p1', title: 'Protected bug detail', actual: 'Broken', observedEnvironment: 'Stage' }, 'bug1', { actor: { id: 'admin', role: 'admin' }, workspaceId: 'default', now: '2026-10-02T00:00:00Z', newId: () => crypto.randomUUID(), memberIds: new Set(['admin']), projectIds: new Set(['p1']), taskIds: new Set() });
const detail: QaDetail = { issue, comments: [], events: [], attachments: [] };
beforeEach(() => { vi.clearAllMocks(); mocks.enabled = false; mocks.ready = true; mocks.role = 'admin'; window.history.replaceState({}, '', '/'); mocks.list.mockImplementation(async filters => ({ issues: !filters.state || filters.state === 'new' ? [issue] : [], total: !filters.state || filters.state === 'new' ? 1 : 0, hasMore: false })); mocks.get.mockResolvedValue(detail); mocks.getWorkflow.mockResolvedValue(structuredClone(DEFAULT_QA_WORKFLOW)); mocks.saveWorkflow.mockImplementation(async value => value); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('QA feature gate and conflict recovery', () => {
  it.each([[false, true], [true, false]])('does not mount data hooks or call endpoints when enabled=%s ready=%s', (enabled, ready) => {
    Object.assign(mocks, { enabled, ready }); render(<QaWorkspace />);
    expect(screen.getByText('qa.disabled')).toBeTruthy(); expect(mocks.useQa).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.getWorkflow).not.toHaveBeenCalled();
  });
  it('unmounts an open detail immediately on disable without fetching it again', async () => {
    mocks.enabled = true; window.history.replaceState({}, '', '/?qa=bug1'); const view = render(<QaWorkspace />);
    expect(await screen.findByRole('heading', { name: issue.title })).toBeTruthy(); const calls = mocks.get.mock.calls.length;
    mocks.enabled = false; view.rerender(<QaWorkspace />);
    expect(screen.queryByRole('heading', { name: issue.title })).toBeNull(); expect(screen.getByText('qa.disabled')).toBeTruthy(); expect(mocks.get).toHaveBeenCalledTimes(calls);
  });
  it('routes the QA toolbar create action into a bug form instead of the task form', async () => {
    mocks.enabled = true; render(<QaWorkspace />); await screen.findByText(issue.title);
    fireEvent(window, new Event('livo:qa-create'));
    expect(screen.getByRole('heading', { name: 'qa.reportTitle' })).toBeTruthy(); expect(screen.getByLabelText(/qa.actual/)).toBeTruthy();
  });
  it('uses shared names and ordering in the board, list and detail', async () => {
    mocks.enabled = true;
    mocks.getWorkflow.mockResolvedValue({ ...DEFAULT_QA_WORKFLOW, order: [...DEFAULT_QA_WORKFLOW.order].reverse(), labels: { ...DEFAULT_QA_WORKFLOW.labels, new: 'Incoming reports' } });
    render(<QaWorkspace />); await screen.findByText(issue.title);
    const board = screen.getByLabelText('qa.board');
    expect(within(board).getAllByRole('heading', { level: 2 }).map(node => node.textContent)).toEqual(['qa.state.closed', 'qa.state.verification', 'qa.state.in_progress', 'qa.state.triaged', 'Incoming reports']);
    fireEvent.click(screen.getByRole('button', { name: 'qa.list' }));
    const title = await screen.findByRole('heading', { name: issue.title });
    expect(within(title.closest('button')!).getByText('Incoming reports')).toBeTruthy();
    fireEvent.click(title); await screen.findByRole('heading', { name: issue.title, level: 1 });
    expect(screen.getByText('Incoming reports')).toBeTruthy();
  });
  it('opens the gated triage form from a card without directly changing its state', async () => {
    mocks.enabled = true; render(<QaWorkspace />); await screen.findByText(issue.title);
    fireEvent.click(screen.getByRole('button', { name: 'qa.triage' }));
    expect(await screen.findByLabelText(/qa.assignee/)).toBeTruthy();
    expect(mocks.command).not.toHaveBeenCalled();
  });
  it('allows administrators to rename and reorder the fixed five stages', async () => {
    mocks.enabled = true; render(<QaWorkspace />); await screen.findByText(issue.title);
    fireEvent.click(screen.getByRole('button', { name: 'qa.workflowTitle' }));
    fireEvent.change(screen.getAllByLabelText('qa.workflowStage')[0], { target: { value: 'Incoming reports' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'qa.workflowMoveDown' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    await waitFor(() => expect(mocks.saveWorkflow).toHaveBeenCalledWith(expect.objectContaining({ order: ['triaged', 'new', 'in_progress', 'verification', 'closed'], labels: expect.objectContaining({ new: 'Incoming reports' }) })));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'qa.workflowTitle' })).toBeNull());
    expect(within(screen.getByLabelText('qa.board')).getAllByRole('heading', { level: 2 })[1].textContent).toBe('Incoming reports');
  });
  it('hides workflow configuration from ordinary members and aborts board requests on disable', async () => {
    mocks.enabled = true; mocks.role = 'member'; const view = render(<QaWorkspace />); await screen.findByText(issue.title);
    expect(screen.queryByRole('button', { name: 'qa.workflowTitle' })).toBeNull();
    const calls = mocks.list.mock.calls.length, signals = mocks.list.mock.calls.map(call => call[1] as AbortSignal);
    mocks.enabled = false; view.rerender(<QaWorkspace />);
    expect(screen.queryByLabelText('qa.board')).toBeNull(); expect(signals.every(signal => signal.aborted)).toBe(true); expect(mocks.list).toHaveBeenCalledTimes(calls);
  });
  it('paginates each board column without moving or omitting other stages', async () => {
    mocks.enabled = true;
    const firstPage = Array.from({ length: 20 }, (_, index) => ({ ...issue, id: `page-${index}`, title: `Report ${index}` }));
    mocks.list.mockImplementation(async filters => filters.state === 'new'
      ? { issues: filters.offset ? [{ ...issue, id: 'page-20', title: 'Report 20' }] : firstPage, total: 21, hasMore: !filters.offset }
      : { issues: [], total: 0, hasMore: false });
    render(<QaWorkspace />); await screen.findByText('Report 0');
    expect(mocks.list.mock.calls.map(call => call[0].state).sort()).toEqual(['closed', 'in_progress', 'new', 'triaged', 'verification']);
    fireEvent.click(screen.getByRole('button', { name: 'qa.loadMore' }));
    expect(await screen.findByText('Report 20')).toBeTruthy();
    expect(screen.getByText('Report 0')).toBeTruthy();
    expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'new', offset: 20, limit: 20 }), expect.any(AbortSignal));
    expect(mocks.command).not.toHaveBeenCalled();
  });
  it('retains workflow edits when saving fails', async () => {
    mocks.enabled = true; mocks.saveWorkflow.mockRejectedValue({ status: 403, code: 'qa_forbidden' });
    render(<QaWorkspace />); await screen.findByText(issue.title);
    fireEvent.click(screen.getByRole('button', { name: 'qa.workflowTitle' }));
    fireEvent.change(screen.getAllByLabelText('qa.workflowStage')[0], { target: { value: 'Pending triage' } });
    fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    await screen.findByRole('alert');
    expect((screen.getAllByLabelText('qa.workflowStage')[0] as HTMLInputElement).value).toBe('Pending triage');
    expect(screen.getByRole('heading', { name: 'qa.workflowTitle' })).toBeTruthy();
  });
  it('mounts the QA board on HTTP when randomUUID is unavailable', async () => {
    const nativeCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto) });
    mocks.enabled = true; render(<QaWorkspace />);
    expect(await screen.findByText(issue.title)).toBeTruthy();
  });
  it('keeps an unsent report after a conflict and after refreshing the record', async () => {
    mocks.command.mockRejectedValue({ status: 409, code: 'qa_version_conflict' }); const refresh = vi.fn().mockResolvedValue(undefined);
    const client = { command: mocks.command, comment: mocks.comment } as unknown as QaClient;
    const props = { detail, client, actor: { id: 'admin', role: 'admin' }, onRefresh: refresh, onBack: vi.fn() };
    const view = render(<QaIssueDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'qa.edit' }));
    const title = screen.getByLabelText(/qa.titleField/) as HTMLInputElement; fireEvent.change(title, { target: { value: 'My unsent correction' } });
    fireEvent.click(screen.getByRole('button', { name: 'qa.save' }));
    expect(await screen.findByText('qa.conflict')).toBeTruthy(); expect(title.value).toBe('My unsent correction');
    fireEvent.click(screen.getByRole('button', { name: 'qa.refresh' })); await waitFor(() => expect(refresh).toHaveBeenCalled());
    view.rerender(<QaIssueDetail {...props} detail={{ ...detail, issue: { ...issue, version: 2, title: 'Other editor title' } }} />);
    expect((screen.getByLabelText(/qa.titleField/) as HTMLInputElement).value).toBe('My unsent correction');
  });
  it('plays a private video blob and revokes its URL when the QA detail unmounts', async () => {
    const OriginalURL = globalThis.URL, createUrl = vi.fn(() => 'blob:qa-private'), revoke = vi.fn();
    vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL = createUrl; static revokeObjectURL = revoke; });
    const file = { id: 'file1', issueId: 'bug1', fileName: 'proof.mp4', mimeType: 'video/mp4', size: 10, uploadedBy: 'admin', createdAt: '2026-10-02T00:00:00Z' };
    const download = vi.fn().mockResolvedValue(new Blob(['video'], { type: 'video/mp4' }));
    const view = render(<QaAttachments issueId="bug1" attachments={[file]} client={{ download } as unknown as QaClient} onChanged={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'qa.view' }));
    await waitFor(() => expect(view.container.querySelector('video')?.getAttribute('src')).toBe('blob:qa-private'));
    expect(download).toHaveBeenCalledWith('file1', expect.any(AbortSignal)); view.unmount(); expect(revoke).toHaveBeenCalledWith('blob:qa-private');
  });
  it('aborts an in-flight evidence upload when its detail unmounts', () => {
    const upload = vi.fn(() => new Promise<never>(() => {}));
    const view = render(<QaAttachments issueId="bug1" attachments={[]} client={{ upload } as unknown as QaClient} onChanged={vi.fn()} onError={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('qa.attach'), { target: { files: [new File(['video'], 'proof.mp4', { type: 'video/mp4' })] } });
    const signal = (upload.mock.calls[0] as unknown as [string, File, unknown, AbortSignal])[3];
    expect(signal.aborted).toBe(false); view.unmount(); expect(signal.aborted).toBe(true);
  });
});
