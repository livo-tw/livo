import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminUsageSection from '@/components/system-admin/AdminUsageSection';

const mocks = vi.hoisted(() => ({ deleted: [] as string[], logged: vi.fn(), confirm: vi.fn(), quota: null as null | { limitBytes: number; usedBytes: number | null } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key}:${JSON.stringify(values)}` : key }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/activityLog', () => ({ logActivity: mocks.logged }));
vi.mock('@/lib/workspaceQuota', () => ({ getWorkspaceStorageQuota: async () => mocks.quota }));
vi.mock('@/components/ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm, ConfirmDialog: null as null }) }));
vi.mock('@/integrations/supabase/client', () => {
  const query = (table: string) => {
    const result = { data: (['task_attachments', 'kb_attachments', 'backup_history'].includes(table) ? [{ file_size: 1024 * 1024 }] : []) as unknown[], count: 3, error: null as null };
    const chain: Record<string, unknown> = {
      select: () => chain, eq: () => chain, lt: () => chain,
      delete: () => { mocks.deleted.push(table); return chain; },
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    };
    return chain;
  };
  return { supabase: { from: query } };
});

describe('log cleanup', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.deleted = []; mocks.quota = null; mocks.confirm.mockResolvedValue(true); });

  it('keeps status change records, which the dashboard is computed from', async () => {
    render(<AdminUsageSection currentMemberId="m1" />);
    fireEvent.click(screen.getByRole('button', { name: /adminUsage.cleanupButtonPrefix/ }));
    await waitFor(() => expect(mocks.logged).toHaveBeenCalled());
    expect(mocks.deleted.sort()).toEqual(['activity_logs', 'notifications']);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: 'adminUsage.cleanupConfirm:{"days":90}', title: 'confirm.defaultTitle' }));
    expect(mocks.logged).toHaveBeenCalledWith('m1', 'cleanup_logs', 'adminUsage.cleanupLogDetail:{"days":90}', undefined, undefined, 'system');
  });

  it('deletes nothing when the administrator cancels', async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<AdminUsageSection currentMemberId="m1" />);
    fireEvent.click(screen.getByRole('button', { name: /adminUsage.cleanupButtonPrefix/ }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(mocks.deleted).toEqual([]);
  });
});

describe('storage usage', () => {
  beforeEach(() => { mocks.quota = null; });

  it('in the cloud shows the server counter the 500 MB limit is enforced against', async () => {
    mocks.quota = { limitBytes: 500 * 1024 * 1024, usedBytes: 120 * 1024 * 1024 };
    render(<AdminUsageSection currentMemberId="m1" />);
    expect(await screen.findByText(/120\.0 MB/)).toBeTruthy();
    expect(screen.getByText(/adminUsage.storageLimit:\{"size":"500.0 MB"\}/)).toBeTruthy();
    expect(screen.queryByText('adminUsage.storageNoLimit')).toBeNull();
  });

  it('self-hosted: no limit, adds up attachments, knowledge files and backups, and counts records instead of guessing bytes', async () => {
    render(<AdminUsageSection currentMemberId="m1" />);
    expect(await screen.findByText('3.0 MB')).toBeTruthy();
    expect(screen.getByText('adminUsage.storageNoLimit')).toBeTruthy();
    // 14 tables, 3 records each in the mock.
    expect(await screen.findByText('adminUsage.recordsValue:{"value":"42"}')).toBeTruthy();
  });
});
