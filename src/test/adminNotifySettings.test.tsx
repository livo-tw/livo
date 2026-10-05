import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SystemAdminView from '@/components/SystemAdminView';

const mocks = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  updates: [] as Record<string, unknown>[],
  updateError: null as { message: string } | null,
  success: vi.fn(), error: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }), initReactI18next: { type: '3rdParty', init: (): void => undefined } }));
vi.mock('sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({}) }));
vi.mock('@/context/SprintContext', () => ({ useSprintContext: () => ({}) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({}) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({}) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'm1', permissions: {} }) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ hasFeature: () => true }) }));
vi.mock('@/components/system-admin/AdminLicenseSection', () => ({ default: (): null => null }));
vi.mock('@/components/system-admin/AdminFeatureToggles', () => ({ default: (): null => null }));
vi.mock('@/components/system-admin/AdminUsageSection', () => ({ default: (): null => null }));
vi.mock('@/components/system-admin/AdminBackupSection', () => ({ default: (): null => null }));
vi.mock('@/components/system-admin/AdminImportExportSection', () => ({ default: (): null => null }));
vi.mock('@/components/IntegrationsView', () => ({ default: (): null => null }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => ({
  select: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { ...mocks.row }, error: null as null }) }) }),
  update: (values: Record<string, unknown>) => ({ eq: async () => {
    mocks.updates.push(values);
    if (!mocks.updateError) Object.assign(mocks.row, values);
    return { error: mocks.updateError };
  } }),
}) } }));

const channel = () => screen.getByPlaceholderText('adminNotify.channelPlaceholder') as HTMLInputElement;

describe('task notification settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updates = []; mocks.updateError = null;
    mocks.row = { id: 'settings-1', enabled: true, interval_days: 1, backup_hour: 3, notify_channel: 'backups',
      task_notify_channel: 'team-alerts', task_notify_types: ['status_changed'], dm_notify_enabled: false,
      dm_notify_start_hour: 8, dm_notify_end_hour: 20 };
  });

  it('shows the saved channel after loading and does not write it back when nothing changed', async () => {
    render(<SystemAdminView />);
    await waitFor(() => expect(channel().value).toBe('team-alerts'));
    fireEvent.blur(channel());
    expect(mocks.updates).toEqual([]);
    expect(screen.getByRole('switch')).not.toBeChecked();
  });

  it('writes only the field that changed', async () => {
    render(<SystemAdminView />);
    await waitFor(() => expect(channel().value).toBe('team-alerts'));
    fireEvent.click(screen.getByRole('checkbox', { name: /adminNotify.events.commentAdded/ }));
    await waitFor(() => expect(mocks.updates).toEqual([{ task_notify_types: ['status_changed', 'comment_added'] }]));
    expect(mocks.success).toHaveBeenCalledWith('integrations.saveSuccess');
  });

  it('reports a failed save and shows the stored value again', async () => {
    mocks.updateError = { message: 'denied' };
    render(<SystemAdminView />);
    await waitFor(() => expect(channel().value).toBe('team-alerts'));
    fireEvent.change(channel(), { target: { value: 'other' } });
    fireEvent.blur(channel());
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('integrations.saveFaileddenied'));
    expect(mocks.success).not.toHaveBeenCalled();
    await waitFor(() => expect(channel().value).toBe('team-alerts'));
  });
});
