import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminFeatureToggles from '@/components/system-admin/AdminFeatureToggles';

const mocks = vi.hoisted(() => ({
  role: 'admin', ready: true, enabled: true,
  save: vi.fn(), pending: vi.fn(), cancel: vi.fn(), refresh: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMember: { role: mocks.role } }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({
  featureToggles: { approvals: mocks.enabled, slackActions: false, qa: false }, featureTogglesReady: mocks.ready,
  featureTogglesError: null as string | null, refreshFeatureToggles: vi.fn(), saveFeatureToggle: mocks.save,
}) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ refreshTasks: mocks.refresh }) }));
vi.mock('@/hooks/useApprovalWorkflow', () => ({ useApprovalWorkflow: () => ({ cancelApproval: mocks.cancel }) }));
vi.mock('@/lib/featureToggleQueries', () => ({ fetchPendingFeatureApprovals: mocks.pending }));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

const pending = [{ id: 'request-1', task: { id: 'task-1', task_key: 'EX-1', title: 'Example task' } }];
describe('admin feature switches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = 'admin'; mocks.ready = true; mocks.enabled = true;
    mocks.pending.mockResolvedValue([]); mocks.save.mockResolvedValue(undefined);
    mocks.cancel.mockResolvedValue(true); mocks.refresh.mockResolvedValue(undefined);
  });
  it('hides the section from ordinary members', () => {
    mocks.role = 'member';
    const { container } = render(<AdminFeatureToggles />);
    expect(container).toBeEmptyDOMElement();
  });
  it('disables changes until the current setting is known', () => {
    mocks.ready = false;
    render(<AdminFeatureToggles />);
    expect(screen.getByRole('switch', { name: 'featureToggles.approvalsLabel' })).toBeDisabled();
  });
  it('saves the Slack switch independently of approval withdrawals', async () => {
    render(<AdminFeatureToggles />);
    fireEvent.click(screen.getByRole('switch', { name: 'featureToggles.slackActionsLabel' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('slackActions', true));
    expect(mocks.pending).not.toHaveBeenCalled();
  });
  it('turns off immediately when there are no pending requests', async () => {
    render(<AdminFeatureToggles />);
    fireEvent.click(screen.getByRole('switch', { name: 'featureToggles.approvalsLabel' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('approvals', false));
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('enables QA independently without withdrawing approvals or deleting history', async () => {
    render(<AdminFeatureToggles />);
    fireEvent.click(screen.getByRole('switch', { name: 'qa.featureLabel' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('qa', true));
    expect(mocks.pending).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('lists pending tasks and lets the admin cancel without changing data', async () => {
    mocks.pending.mockResolvedValue(pending);
    render(<AdminFeatureToggles />);
    fireEvent.click(screen.getByRole('switch', { name: 'featureToggles.approvalsLabel' }));
    const taskLink = await screen.findByRole('link', { name: 'EX-1 · Example task' });
    expect(taskLink.getAttribute('href')).toContain('task/task-1');
    fireEvent.click(screen.getByRole('button', { name: 'button.cancel' }));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('uses the withdrawal path and rechecks pending requests before disabling', async () => {
    mocks.pending.mockResolvedValueOnce(pending).mockResolvedValue([]);
    render(<AdminFeatureToggles />);
    fireEvent.click(screen.getByRole('switch', { name: 'featureToggles.approvalsLabel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'featureToggles.withdrawAndDisable' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('approvals', false));
    expect(mocks.cancel).toHaveBeenCalledWith('request-1', { silent: true });
    expect(mocks.pending).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalled();
  });
  it('keeps the dialog open and the feature on if a withdrawal fails', async () => {
    mocks.pending.mockResolvedValue(pending); mocks.cancel.mockResolvedValue(false);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<AdminFeatureToggles />);
    fireEvent.click(screen.getByRole('switch', { name: 'featureToggles.approvalsLabel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'featureToggles.withdrawAndDisable' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('featureToggles.withdrawFailed');
    expect(mocks.save).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
