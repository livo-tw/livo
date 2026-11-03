import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Status, Task, TaskSpec, User } from '@/types';

const state = vi.hoisted(() => ({
  mobile: true,
  compact: true,
  displayMode: 'side' as 'side' | 'modal' | 'page',
  currentView: 'board',
  qaEnabled: true,
  featuresReady: true,
  navigationAccepted: true,
  selectedTask: null as Task | null,
  tasks: [] as Task[],
  setSelectedTask: vi.fn(),
  setCurrentView: vi.fn(),
  setShowCreateTask: vi.fn(),
}));

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => state.mobile }));
vi.mock('@/hooks/use-media-query', () => ({ useMediaQuery: () => state.compact }));
vi.mock('@/lib/demoMode', () => ({ IS_DEMO_PRO: false, exitDemoMode: vi.fn() }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMember: null as User | null, realMember: null as User | null, currentMemberId: 'example-member', setCurrentMemberId: vi.fn() }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as User[] }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ setSelectedProjectId: vi.fn(), setSelectedLineId: vi.fn() }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ currentView: state.currentView, setCurrentView: state.setCurrentView,
  selectedTask: state.selectedTask, setSelectedTask: state.setSelectedTask, taskDisplayMode: state.displayMode,
  approvalsEnabled: true, featureTogglesReady: state.featuresReady, featureToggles: { qa: state.qaEnabled }, setShowCreateTask: state.setShowCreateTask }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: state.tasks, statuses: [] as Status[], taskSpecs: [] as TaskSpec[] }) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ hasFeature: () => true }) }));
vi.mock('@/hooks/useActionableApprovalCount', () => ({ useActionableApprovalCount: () => 2 }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { signOut: vi.fn() } } }));
vi.mock('@/lib/permissions', () => ({ getRoleLabel: (role: string) => role, getRoleColor: () => '#000000' }));
vi.mock('@/components/NotificationPanel', () => ({ default: () => <button aria-label="Example notifications">Notifications</button> }));
vi.mock('@/components/MyAssignments', () => ({ MyAssignmentsDropdown: () => <button aria-label="Example assignments">Assignments</button> }));
vi.mock('@/components/approval/PendingApprovalList', () => ({ default: () => <p>Example pending approvals</p> }));
vi.mock('@/components/TaskDetailContent', () => ({ default: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>Example detail close</button> }));

import TopBar from '@/components/TopBar';
import TaskDetailModal from '@/components/TaskDetailModal';

const exampleTask: Task = { id: 'example-task', taskKey: 'EX-1', projectId: 'example-project', title: 'Example task',
  priority: 'medium', statusId: 'example-status', creatorId: 'example-member', createdAt: '2026-10-06T00:00:00Z',
  sortOrder: 0, commentCount: 0, attachmentCount: 0, deployments: [] };

beforeEach(() => {
  vi.clearAllMocks();
  state.mobile = true;
  state.compact = true;
  state.displayMode = 'side';
  state.currentView = 'board';
  state.qaEnabled = true;
  state.featuresReady = true;
  state.navigationAccepted = true;
  state.setCurrentView.mockImplementation((_view: string, onAccepted?: () => void) => { if (state.navigationAccepted) onAccepted?.(); });
  state.selectedTask = null;
  state.tasks = [];
  window.history.replaceState({}, '', '/');
});
afterEach(cleanup);

describe('mobile navigation and tools', () => {
  it.each(['board', 'qa', 'my-qa'])('offers independent task and Bug actions in %s', currentView => {
    state.currentView = currentView;
    render(<TopBar />);
    const task = screen.getByRole('button', { name: 'button.createTask' });
    const bug = screen.getByRole('button', { name: 'qa.report' });
    expect(task).toHaveClass('bg-blue-600', 'min-h-[44px]');
    expect(bug).toHaveClass('bg-rose-600', 'min-h-[44px]');
    expect(task.textContent).toBe('button.createTask');
    expect(bug.textContent).toBe('qa.report');
    expect(screen.getByRole('group', { name: 'button.create' })).toHaveClass('grid-cols-2');
    fireEvent.click(task);
    expect(state.setShowCreateTask).toHaveBeenCalledWith(true);
    expect(state.setCurrentView).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });

  it.each([[false, false], [false, true]])('keeps both labelled actions together for desktop/tablet (%s/%s)', (mobile, compact) => {
    state.mobile = mobile; state.compact = compact;
    render(<TopBar />);
    const actions = screen.getByRole('group', { name: 'button.create' });
    expect(within(actions).getByRole('button', { name: 'button.createTask' })).toBeVisible();
    expect(within(actions).getByRole('button', { name: 'qa.report' })).toBeVisible();
    expect(actions).toHaveClass('flex');
  });

  it.each(['disabled', 'not-ready'])('keeps task creation available with QA %s', capability => {
    state.qaEnabled = capability !== 'disabled';
    state.featuresReady = capability !== 'not-ready';
    render(<TopBar />);
    expect(screen.queryByRole('button', { name: 'qa.report' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'button.createTask' }));
    expect(state.setShowCreateTask).toHaveBeenCalledWith(true);
  });

  it('queues Bug creation after an accepted cross-view navigation', () => {
    const create = vi.fn(); window.addEventListener('livo:qa-create', create);
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'qa.report' }));
    expect(state.setCurrentView).toHaveBeenCalledWith('qa', expect.any(Function));
    expect(new URLSearchParams(window.location.search).get('qaCreate')).toBe('1');
    expect(create).toHaveBeenCalledOnce();
    expect(state.setShowCreateTask).not.toHaveBeenCalled();
    window.removeEventListener('livo:qa-create', create);
  });

  it('does not change the URL, selected task, or intent when navigation is rejected', () => {
    state.navigationAccepted = false;
    window.history.replaceState({}, '', '/?kb=example-page#draft');
    const original = window.location.href;
    const create = vi.fn(); window.addEventListener('livo:qa-create', create);
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'qa.report' }));
    expect(window.location.href).toBe(original);
    expect(state.setSelectedTask).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    window.removeEventListener('livo:qa-create', create);
  });

  it.each(['qa', 'my-qa'])('preserves a mounted %s form that declines another create', currentView => {
    state.currentView = currentView;
    window.history.replaceState({}, '', '/?qa=example-issue');
    const original = window.location.href;
    const handler = (event: Event) => { (event as CustomEvent<{ handled: boolean; accepted: boolean }>).detail.handled = true; };
    window.addEventListener('livo:qa-create', handler);
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'qa.report' }));
    expect(state.setCurrentView).not.toHaveBeenCalled();
    expect(state.setSelectedTask).not.toHaveBeenCalled();
    expect(window.location.href).toBe(original);
    window.removeEventListener('livo:qa-create', handler);
  });

  it('retains a same-view creation intent while the lazy QA workspace has no listener', () => {
    state.currentView = 'my-qa';
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'qa.report' }));
    expect(new URLSearchParams(window.location.search).get('qaCreate')).toBe('1');
    expect(state.setCurrentView).not.toHaveBeenCalled();
  });

  it('offers a desktop sidebar toggle with the current expanded state and a localized action', () => {
    state.mobile = false;
    const toggle = vi.fn();
    const { rerender } = render(<TopBar onToggleSidebar={toggle} sidebarExpanded />);
    const collapse = screen.getByRole('button', { name: 'sidebar.collapseNavigation' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(collapse);
    expect(toggle).toHaveBeenCalledOnce();
    rerender(<TopBar onToggleSidebar={toggle} sidebarExpanded={false} />);
    expect(screen.getByRole('button', { name: 'sidebar.expandNavigation' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the record URL until the guarded view transition accepts navigation', () => {
    state.currentView = 'qa';
    window.history.replaceState({}, '', '/?qa=example-issue');
    render(<TopBar />);
    fireEvent.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'nav.board' }));
    expect(state.setCurrentView).toHaveBeenCalledWith('board');
    expect(new URLSearchParams(window.location.search).get('qa')).toBe('example-issue');
  });

  it('keeps pending approvals reachable from mobile navigation with its existing view', () => {
    render(<TopBar />);
    const navigation = screen.getByRole('navigation', { name: 'sidebar.navigation' });
    expect(within(navigation).getByRole('button', { name: 'nav.board' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(within(navigation).getByRole('button', { name: 'approval.pending 2' }));
    expect(state.setCurrentView).toHaveBeenCalledWith('approvals');
  });

  it('reports an empty mobile search and lets Escape dismiss the search', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'common.search' }));
    const search = screen.getByRole('textbox', { name: 'search.placeholder' });
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: 'No matching example' } });
    expect(screen.getByText('search.noResults')).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'search.placeholder' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.search' })).toHaveFocus();
  });

  it('uses the QA creation flow when the current mobile view is Bugs', () => {
    state.currentView = 'qa';
    const create = vi.fn();
    window.addEventListener('livo:qa-create', create);
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'qa.report' }));
    expect(new URLSearchParams(window.location.search).get('qaCreate')).toBe('1');
    expect(create).toHaveBeenCalledOnce();
    expect(state.setShowCreateTask).not.toHaveBeenCalled();
    window.removeEventListener('livo:qa-create', create);
  });

  it('keeps compact tools and navigation on tablet widths without a second sidebar toggle', () => {
    state.mobile = false;
    render(<TopBar />);
    expect(screen.getByRole('button', { name: 'common.search' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'sidebar.navigation' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'approval.pending 2' }));
    expect(state.setCurrentView).toHaveBeenCalledWith('approvals');
  });
});

describe('mobile task detail fallback', () => {
  it('opens a focus-trapped detail when a saved desktop side-panel preference is used on mobile', () => {
    state.selectedTask = exampleTask;
    render(<TaskDetailModal />);
    const dialog = screen.getByRole('dialog', { name: 'Example task' });
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons[0]).toHaveFocus();
    buttons[buttons.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(buttons[0]).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(state.setSelectedTask).toHaveBeenCalledWith(null);
  });

  it('preserves the desktop side-panel and full-page preferences', () => {
    state.selectedTask = exampleTask;
    state.mobile = false;
    state.compact = false;
    const view = render(<TaskDetailModal />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    state.mobile = true;
    state.compact = true;
    state.displayMode = 'page';
    view.rerender(<TaskDetailModal />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('falls back on tablet widths without changing the saved side-panel preference', () => {
    state.selectedTask = exampleTask;
    state.mobile = false;
    render(<TaskDetailModal />);
    expect(screen.getByRole('dialog', { name: 'Example task' })).toBeInTheDocument();
    expect(state.displayMode).toBe('side');
  });
});
