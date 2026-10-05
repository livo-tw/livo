import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlackLinkStatus } from '@/lib/slackLink';

const mocks = vi.hoisted(() => ({ load: vi.fn(), set: vi.fn(), confirm: vi.fn(), logs: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values?.name ? `${key}:${values.name}` : key, i18n: { language: 'en' } }) }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'm1' }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ approvalsEnabled: true }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [{ id: 't1', taskKey: 'APP-7', title: 'Checkout fails' }] }) }));
vi.mock('@/components/ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm, ConfirmDialog: null as null }) }));
vi.mock('@/lib/integrationQueries', () => ({ actionLogQueries: { fetchByMember: mocks.logs } }));
vi.mock('@/lib/slackLink', () => ({ loadSlackLink: mocks.load, setSlackLinkEnabled: mocks.set }));
import ExternalPlatformSettings from '@/components/integrations/ExternalPlatformSettings';

const linked: SlackLinkStatus = { disabled: false, mode: 'binding', linked: { displayName: 'Example Person', verifiedBy: 'email', boundAt: null } };
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.logs.mockResolvedValue({ data: [], error: null });
  mocks.confirm.mockResolvedValue(true);
});

describe('My Slack link', () => {
  it('shows the linked account and unlinks only after confirmation', async () => {
    mocks.load.mockResolvedValue(linked);
    mocks.set.mockResolvedValue({ ...linked, disabled: true, linked: null });
    render(<ExternalPlatformSettings />);
    expect(await screen.findByText('settings.slackLink.linked:Example Person')).toBeTruthy();
    mocks.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: /settings.slackLink.unlink/ }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /settings.slackLink.unlink/ }));
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith(false));
    expect(await screen.findByText('settings.slackLink.disabled')).toBeTruthy();
    expect(mocks.success).toHaveBeenCalledWith('settings.slackLink.unlinked');
  });

  it('allows linking again without a confirmation', async () => {
    mocks.load.mockResolvedValue({ disabled: true, mode: 'email', linked: null });
    mocks.set.mockResolvedValue({ disabled: false, mode: 'email', linked: null });
    render(<ExternalPlatformSettings />);
    fireEvent.click(await screen.findByRole('button', { name: /settings.slackLink.relink/ }));
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith(true));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(await screen.findByText('settings.slackLink.emailMode')).toBeTruthy();
    // The cloud records no Slack actions, so no empty history is shown.
    expect(mocks.logs).not.toHaveBeenCalled();
  });

  it('says when the setting cannot be loaded and lets the member retry', async () => {
    mocks.load.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(linked);
    render(<ExternalPlatformSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.slackLink.retry' }));
    expect(await screen.findByText('settings.slackLink.linked:Example Person')).toBeTruthy();
  });

  it('names the task of each Slack action, and says when the history cannot be read', async () => {
    mocks.load.mockResolvedValue(linked);
    mocks.logs.mockResolvedValueOnce({ data: null, error: { message: 'offline' } })
      .mockResolvedValueOnce({ data: [{ id: 'l1', member_id: 'm1', binding_id: null, platform: 'slack', action_type: 'comment_add', target_task_id: 't1', action_payload: null, result_status: 'success', error_message: null, platform_message_id: null, acted_at: '2026-10-01T08:00:00.000Z' }], error: null });
    render(<ExternalPlatformSettings />);
    expect(await screen.findByText('settings.slackLink.actionsLoadFailed')).toBeTruthy();
    expect(screen.queryByText('settings.slackLink.noActions')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.slackLink.retry' })[0]);
    expect(await screen.findByText('Checkout fails')).toBeTruthy();
    expect(screen.getByText('APP-7')).toBeTruthy();
  });
});
