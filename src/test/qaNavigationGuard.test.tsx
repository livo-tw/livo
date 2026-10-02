import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ProductLine, Task } from '@/types';
import type { QaCreateInput } from '@/lib/qa/domain';
const mocks = vi.hoisted(() => ({ create: vi.fn(), upload: vi.fn(), get: vi.fn(), versions: vi.fn(), getWorkflow: vi.fn(), toast: vi.fn(), loadFeatures: vi.fn(), saveFeature: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { info: mocks.toast } }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: {} }));
vi.mock('@/lib/featureToggleQueries', () => ({ loadFeatureToggles: mocks.loadFeatures, persistFeatureToggle: mocks.saveFeature }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [{ id: 'admin', name: 'Example admin', role: 'admin', isActive: true }] }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [{ id: 'p1', name: 'Example project', isArchived: false }], productLines: [] as ProductLine[], selectedProjectId: null as string | null, setSelectedProjectId: vi.fn() }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [] as Task[] }) }));
vi.mock('@/context/DeploymentEnvironmentContext', () => ({ useDeploymentEnvironments: () => ({ values: ['Stage'], ready: true, loadError: false }) }));
vi.mock('@/hooks/useQa', () => {
  const client = { create: mocks.create, upload: mocks.upload, get: mocks.get, versions: mocks.versions, getWorkflow: mocks.getWorkflow };
  return { useQa: () => ({ client, actor: { id: 'admin', role: 'admin' }, enabled: true }) };
});
vi.mock('@/components/qa/QaKanban', () => ({ default: (): null => null }));
import { useUIState } from '@/context/hooks/useUIState';
import { UIContext } from '@/context/UIContext';
import { useQaNavigationGuard } from '@/hooks/useQaNavigationGuard';
import { hasQaNavigationGuard } from '@/lib/qa/navigationGuard';
import { resolveFeatureToggles } from '@/lib/featureToggles';
import QaWorkspace from '@/components/qa/QaWorkspace';
import { createQaIssue } from '@/lib/qa/domain';
import { DEFAULT_QA_WORKFLOW } from '@/lib/qa/workflow';

const features = (qa = true) => resolveFeatureToggles({ qa }, { hasApprovalRules: false, hasApprovalRequests: false });
const input: QaCreateInput = { projectId: 'p1', title: 'Example protected Bug', actual: 'Unexpected result', observedEnvironment: 'Stage' };
const issue = createQaIssue(input, 'example-bug', { actor: { id: 'admin', role: 'admin' }, workspaceId: 'example-workspace', now: '2026-10-03T00:00:00Z', newId: () => 'example-event', memberIds: new Set(['admin']), projectIds: new Set(['p1']), taskIds: new Set() });
function Spa() {
  const ui = useUIState('admin');
  useEffect(() => { void ui.refreshFeatureToggles().then(() => ui.setCurrentView('qa')); }, []);
  return <UIContext.Provider value={ui}><nav><button onClick={() => ui.setCurrentView('my-qa')}>My QA navigation</button><button onClick={() => ui.setCurrentView('board')}>Task navigation</button><button onClick={() => void ui.refreshFeatureToggles()}>Reload capabilities</button></nav><output aria-label="Current view">{ui.currentView}</output>{ui.currentView === 'qa' || ui.currentView === 'my-qa' ? <QaWorkspace mine={ui.currentView === 'my-qa'} /> : <h1>Task board</h1>}</UIContext.Provider>;
}
const fill = () => {
  fireEvent.change(screen.getByLabelText(/qa.project/), { target: { value: input.projectId } });
  fireEvent.change(screen.getByLabelText(/qa.titleField/), { target: { value: input.title } });
  fireEvent.change(screen.getByLabelText(/qa.actual/), { target: { value: input.actual } });
  fireEvent.change(screen.getByLabelText(/qa.environment/), { target: { value: input.observedEnvironment } });
};
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('VITE_API_URL', ''); window.history.replaceState({}, '', '/');
  mocks.loadFeatures.mockResolvedValue(features()); mocks.saveFeature.mockResolvedValue(undefined);
  mocks.getWorkflow.mockResolvedValue(structuredClone(DEFAULT_QA_WORKFLOW)); mocks.versions.mockResolvedValue([]);
  mocks.create.mockImplementation(async (_input: QaCreateInput, id: string) => ({ ...issue, id }));
  mocks.get.mockImplementation(async (id: string) => ({ issue: { ...issue, id }, attachments: [], comments: [], events: [] }));
  mocks.upload.mockResolvedValue({ id: 'attachment1' });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); expect(hasQaNavigationGuard()).toBe(false); });

describe('central QA navigation guard', () => {
  it('keeps the stable setter and normal functional updates, while preventing guarded mine/all and task navigation', async () => {
    const { result, rerender } = renderHook(({ active }) => { const ui = useUIState(); useQaNavigationGuard(active); return ui; }, { initialProps: { active: false } });
    const setter = result.current.setCurrentView;
    await act(async () => { await result.current.refreshFeatureToggles(); });
    act(() => { setter('qa'); }); rerender({ active: true });
    expect(result.current.setCurrentView).toBe(setter);
    act(() => { setter('my-qa'); setter(previous => previous === 'qa' ? 'board' : 'backlog'); });
    expect(result.current.currentView).toBe('qa'); expect(mocks.toast).toHaveBeenCalledWith('qa.finishPending', { id: 'qa-pending-navigation' });
    rerender({ active: false });
    act(() => { setter('my-qa'); setter(previous => previous === 'my-qa' ? 'board' : 'backlog'); });
    expect(result.current.currentView).toBe('board'); expect(result.current.setCurrentView).toBe(setter);
  });
  it.each(['livo:qa-navigation', 'popstate'])('intercepts %s before existing handlers and restores the original same-tab URL', eventName => {
    window.history.replaceState({ example: true }, '', '/?qa=example-bug#details');
    const handler = vi.fn(); window.addEventListener(eventName, handler);
    const { unmount } = renderHook(() => useQaNavigationGuard(true));
    window.history.replaceState({}, '', '/?qa=another-bug'); fireEvent(window, new Event(eventName));
    expect(handler).not.toHaveBeenCalled(); expect(window.location.pathname + window.location.search + window.location.hash).toBe('/?qa=example-bug#details');
    expect(mocks.toast).toHaveBeenCalledWith('qa.finishPending', { id: 'qa-pending-navigation' });
    unmount(); fireEvent(window, new Event(eventName)); expect(handler).toHaveBeenCalledTimes(1); window.removeEventListener(eventName, handler);
  });
  it('releases only the guard whose owner cancelled or unmounted', () => {
    const first = renderHook(({ active }) => useQaNavigationGuard(active), { initialProps: { active: true } });
    const second = renderHook(() => useQaNavigationGuard(true));
    first.rerender({ active: false }); expect(hasQaNavigationGuard()).toBe(true);
    second.unmount(); expect(hasQaNavigationGuard()).toBe(false);
  });
  it('blocks only task actions that replace the page, preserving clear, modal, side and ordinary task behaviour', async () => {
    const task = { id: 'task1', title: 'Example task' } as Task;
    const { result, rerender } = renderHook(({ active }) => { const ui = useUIState(); useQaNavigationGuard(active); return ui; }, { initialProps: { active: false } });
    await act(async () => { await result.current.refreshFeatureToggles(); }); act(() => result.current.setCurrentView('qa'));
    const select = result.current.setSelectedTask, display = result.current.setTaskDisplayMode;
    rerender({ active: true });
    act(() => { display('page'); select(task); }); expect(result.current.selectedTask).toBeNull(); expect(result.current.taskDisplayMode).toBe('page');
    act(() => { display('modal'); select(task); }); expect(result.current.selectedTask).toBe(task);
    act(() => display('page')); expect(result.current.taskDisplayMode).toBe('modal');
    act(() => { display('side'); select(previous => previous && { ...previous, title: 'Updated example task' }); });
    expect(result.current.selectedTask?.title).toBe('Updated example task'); expect(result.current.taskDisplayMode).toBe('side');
    act(() => select(null)); expect(result.current.selectedTask).toBeNull();
    rerender({ active: false }); act(() => { display('page'); select(task); });
    expect(result.current.selectedTask).toBe(task); expect(result.current.taskDisplayMode).toBe('page');
    expect(result.current.setSelectedTask).toBe(select); expect(result.current.setTaskDisplayMode).toBe(display);
  });
  it('leaves cross-path router and authentication teardown to the parent application', () => {
    window.history.replaceState({}, '', '/demo/?qa=example-bug');
    const { unmount } = renderHook(() => useQaNavigationGuard(true));
    const router = vi.fn(); window.addEventListener('popstate', router);
    window.history.replaceState({}, '', '/auth/callback'); fireEvent(window, new Event('popstate'));
    expect(router).toHaveBeenCalledTimes(1); expect(window.location.pathname).toBe('/auth/callback'); expect(mocks.toast).not.toHaveBeenCalled();
    unmount(); window.removeEventListener('popstate', router);
  });
  it('permits capability revocation even if a protected component has not unmounted yet', async () => {
    const { result, rerender } = renderHook(({ active }) => { const ui = useUIState('admin'); useQaNavigationGuard(active); return ui; }, { initialProps: { active: false } });
    await act(async () => { await result.current.refreshFeatureToggles(); }); act(() => result.current.setCurrentView('qa'));
    rerender({ active: true }); expect(hasQaNavigationGuard()).toBe(true);
    mocks.loadFeatures.mockResolvedValue(features(false)); await act(async () => { await result.current.refreshFeatureToggles(); });
    act(() => result.current.setCurrentView('board'));
    expect(result.current.currentView).toBe('board'); expect(hasQaNavigationGuard()).toBe(false); expect(mocks.toast).not.toHaveBeenCalled();
  });
  it('does not consume the logout abort event or keep navigation locked afterwards', async () => {
    const { result, rerender } = renderHook(({ active }) => { const ui = useUIState(); useQaNavigationGuard(active); return ui; }, { initialProps: { active: false } });
    await act(async () => { await result.current.refreshFeatureToggles(); }); act(() => result.current.setCurrentView('qa')); rerender({ active: true });
    const abort = vi.fn(); window.addEventListener('livo:qa-abort', abort);
    fireEvent(window, new Event('livo:qa-abort')); expect(abort).toHaveBeenCalledTimes(1); expect(hasQaNavigationGuard()).toBe(false);
    act(() => result.current.setCurrentView('board')); expect(result.current.currentView).toBe('board'); window.removeEventListener('livo:qa-abort', abort);
  });
});

describe('real QA workspace across SPA views', () => {
  it('allows leaving a blank create form', async () => {
    render(<Spa />); await screen.findByRole('heading', { name: 'qa.title' }); fireEvent(window, new Event('livo:qa-create'));
    expect(screen.getByLabelText(/qa.titleField/)).toHaveValue(''); expect(hasQaNavigationGuard()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Task navigation' })); expect(screen.getByRole('heading', { name: 'Task board' })).toBeTruthy(); expect(mocks.toast).not.toHaveBeenCalled();
  });
  it('preserves an unknown create result across attempted mine/all and task navigation, then retries the same IDs', async () => {
    mocks.create.mockRejectedValueOnce(new TypeError('connection lost'));
    render(<Spa />); await screen.findByRole('heading', { name: 'qa.title' }); fireEvent(window, new Event('livo:qa-create')); fill();
    const title = screen.getByLabelText(/qa.titleField/); fireEvent.click(screen.getByRole('button', { name: 'qa.createBug' })); await screen.findByText('qa.createRetryHint');
    const original = mocks.create.mock.calls[0].slice(0, 3);
    fireEvent.click(screen.getByRole('button', { name: 'My QA navigation' })); fireEvent.click(screen.getByRole('button', { name: 'Task navigation' }));
    expect(screen.getByLabelText('Current view')).toHaveTextContent('qa'); expect(screen.getByLabelText(/qa.titleField/)).toBe(title);
    fireEvent.click(screen.getByRole('button', { name: 'qa.retryCreate' })); await screen.findByRole('heading', { name: input.title });
    expect(mocks.create.mock.calls[1].slice(0, 3)).toEqual(original); expect(hasQaNavigationGuard()).toBe(false);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'My QA navigation' })));
    expect(screen.getByLabelText('Current view')).toHaveTextContent('my-qa'); await screen.findByRole('heading', { name: input.title });
  });
  it('keeps a real upload alive across attempted view switches and allows navigation after completion', async () => {
    let resolveUpload!: (value: unknown) => void;
    mocks.upload.mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; }));
    render(<Spa />); await screen.findByRole('heading', { name: 'qa.title' }); fireEvent(window, new Event('livo:qa-create')); fill();
    fireEvent.change(screen.getByLabelText('qa.attach'), { target: { files: [new File(['video'], 'proof.mp4', { type: 'video/mp4' })] } });
    const title = screen.getByLabelText(/qa.titleField/); fireEvent.click(screen.getByRole('button', { name: 'qa.createBug' })); await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    const signal = mocks.upload.mock.calls[0][3] as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'My QA navigation' })); fireEvent.click(screen.getByRole('button', { name: 'Task navigation' }));
    expect(signal.aborted).toBe(false); expect(screen.getByLabelText(/qa.titleField/)).toBe(title); expect(mocks.create).toHaveBeenCalledTimes(1);
    await act(async () => resolveUpload({ id: 'attachment1' })); await screen.findByRole('heading', { name: input.title });
    fireEvent.click(screen.getByRole('button', { name: 'Task navigation' })); expect(screen.getByRole('heading', { name: 'Task board' })).toBeTruthy();
  });
  it('protects an existing Bug attachment from SPA switches and another Bug navigation', async () => {
    let resolveUpload!: (value: unknown) => void;
    mocks.upload.mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; }));
    window.history.replaceState({}, '', '/?qa=existing-bug');
    render(<Spa />); await screen.findByRole('heading', { name: input.title });
    const attachment = screen.getByLabelText('qa.attach');
    fireEvent.change(attachment, { target: { files: [new File(['video'], 'proof.mp4', { type: 'video/mp4' })] } });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    const signal = mocks.upload.mock.calls[0][3] as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'My QA navigation' })); fireEvent.click(screen.getByRole('button', { name: 'Task navigation' }));
    window.history.replaceState({}, '', '/?qa=other-bug'); fireEvent(window, new Event('livo:qa-navigation'));
    expect(screen.getByLabelText('qa.attach')).toBe(attachment); expect(signal.aborted).toBe(false);
    expect(window.location.search).toBe('?qa=existing-bug'); expect(mocks.get).toHaveBeenCalledTimes(1);
    await act(async () => resolveUpload({ id: 'attachment1' })); await waitFor(() => expect(hasQaNavigationGuard()).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Task navigation' })); expect(screen.getByRole('heading', { name: 'Task board' })).toBeTruthy();
  });
  it('immediately tears down and aborts a protected upload when QA capability is revoked', async () => {
    let resolveUpload!: (value: unknown) => void;
    mocks.upload.mockImplementation(() => new Promise(resolve => { resolveUpload = resolve; }));
    render(<Spa />); await screen.findByRole('heading', { name: 'qa.title' }); fireEvent(window, new Event('livo:qa-create')); fill();
    fireEvent.change(screen.getByLabelText('qa.attach'), { target: { files: [new File(['video'], 'proof.mp4', { type: 'video/mp4' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'qa.createBug' })); await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    const signal = mocks.upload.mock.calls[0][3] as AbortSignal; expect(hasQaNavigationGuard()).toBe(true);
    mocks.loadFeatures.mockResolvedValue(features(false)); fireEvent.click(screen.getByRole('button', { name: 'Reload capabilities' })); await screen.findByText('qa.disabled');
    expect(signal.aborted).toBe(true); expect(hasQaNavigationGuard()).toBe(false);
    await act(async () => resolveUpload({ id: 'attachment1' })); expect(mocks.get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Task navigation' })); expect(screen.getByRole('heading', { name: 'Task board' })).toBeTruthy(); expect(mocks.toast).not.toHaveBeenCalled();
  });
});
