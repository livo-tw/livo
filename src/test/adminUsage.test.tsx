import React from 'react';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

type Mode = 'success' | 'allErrors' | 'countError' | 'sizeError' | 'rejectTasks' | 'rejectLogs' | 'empty';
const state = vi.hoisted(() => ({ mode: 'success' as Mode }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, options?: { value?: string }) => options?.value !== undefined ? `${key}:${options.value}` : key,
}) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  from: (table: string) => ({ select: (columns: string) => {
    let readNotifications = false;
    const query = {
      eq: () => { readNotifications = true; return query; },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        if ((state.mode === 'rejectTasks' && table === 'tasks') || (state.mode === 'rejectLogs' && readNotifications)) {
          return Promise.reject(new Error('Synthetic transport failure')).then(resolve, reject);
        }
        const failed = state.mode === 'allErrors' || (state.mode === 'countError' && table === 'tasks') || (state.mode === 'sizeError' && table === 'kb_attachments');
        return Promise.resolve(failed
          ? { data: null, count: null, error: { message: 'Synthetic response failure' } }
          : { data: columns === 'file_size' ? (state.mode === 'empty' ? [] : [{ file_size: 1024 }]) : null, count: state.mode === 'empty' ? 0 : 10, error: null }
        ).then(resolve, reject);
      },
    };
    return query;
  } }),
} }));
vi.mock('@/lib/workspaceQuota', () => ({ getWorkspaceStorageQuota: async (): Promise<null> => null }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('@/components/ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(), ConfirmDialog: (): null => null }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={onClick} disabled={disabled}>{children}</button> }));
vi.mock('@/components/ui/card', () => { const D = ({ children }: React.PropsWithChildren) => <div>{children}</div>; return { Card: D, CardContent: D, CardDescription: D, CardHeader: D, CardTitle: D }; });
vi.mock('@/components/ui/select', () => { const D = ({ children }: React.PropsWithChildren) => <div>{children}</div>; return { Select: D, SelectContent: D, SelectItem: D, SelectTrigger: D, SelectValue: D }; });
import AdminUsageSection from '@/components/system-admin/AdminUsageSection';

beforeEach(() => { state.mode = 'success'; });
afterEach(cleanup);
const renderUsage = () => render(<AdminUsageSection currentMemberId="member-example" />);
const confirmedRecords = (n: number) => screen.getByText(`adminUsage.recordsValue:${n}`);

describe('Admin usage data availability', () => {
  it('keeps a normal selfhost without quota valid and loads complete usage', async () => {
    renderUsage();
    await waitFor(() => expect(confirmedRecords(140)).toBeInTheDocument());
    expect(screen.getByText('3 KB')).toBeInTheDocument();
    expect(screen.getByText('adminUsage.storageNoLimit')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows unknown instead of zero when initial API responses contain errors, and retries successfully', async () => {
    state.mode = 'allErrors';
    renderUsage();
    await waitFor(() => expect(screen.getByText('adminUsage.usageLoadFailed')).toBeInTheDocument());
    expect(screen.getByText('adminUsage.logsLoadFailed')).toBeInTheDocument();
    expect(screen.getAllByText('adminUsage.unknownValue').length).toBeGreaterThan(0);
    expect(screen.queryByText('adminUsage.recordsValue:0')).not.toBeInTheDocument();
    expect(screen.queryByText('0 KB')).not.toBeInTheDocument();
    expect(screen.queryByText('common.loading')).not.toBeInTheDocument();
    state.mode = 'success';
    fireEvent.click(screen.getByRole('button', { name: 'adminUsage.retryButton' }));
    await waitFor(() => expect(confirmedRecords(140)).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not publish a partial record total if one count fails', async () => {
    state.mode = 'countError';
    renderUsage();
    await waitFor(() => expect(screen.getByText('adminUsage.usageLoadFailed')).toBeInTheDocument());
    expect(screen.queryByText('adminUsage.recordsValue:130')).not.toBeInTheDocument();
  });

  it('does not publish a partial file size if one attachment read fails', async () => {
    state.mode = 'sizeError';
    renderUsage();
    await waitFor(() => expect(screen.getByText('adminUsage.usageLoadFailed')).toBeInTheDocument());
    expect(screen.queryByText('2 KB')).not.toBeInTheDocument();
  });

  it('keeps the last successful numbers labelled stale after refresh failure, then recovers', async () => {
    renderUsage();
    await waitFor(() => expect(confirmedRecords(140)).toBeInTheDocument());
    state.mode = 'allErrors';
    fireEvent.click(screen.getByRole('button', { name: 'adminUsage.refreshButton' }));
    await waitFor(() => expect(screen.getByText('adminUsage.usageRefreshFailed')).toBeInTheDocument());
    expect(confirmedRecords(140)).toBeInTheDocument();
    expect(screen.getByText('3 KB')).toBeInTheDocument();
    expect(screen.getByText('adminUsage.logsRefreshFailed')).toBeInTheDocument();
    expect(screen.queryByText('adminUsage.recordsValue:0')).not.toBeInTheDocument();
    state.mode = 'success';
    fireEvent.click(screen.getByRole('button', { name: 'adminUsage.retryButton' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('catches a rejected usage request and ends loading with a retryable error', async () => {
    state.mode = 'rejectTasks';
    renderUsage();
    await waitFor(() => expect(screen.getByText('adminUsage.usageLoadFailed')).toBeInTheDocument());
    expect(screen.queryByText('common.loading')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'adminUsage.retryButton' })).toBeEnabled();
  });

  it('handles a rejected log-count request without discarding valid capacity data', async () => {
    state.mode = 'rejectLogs';
    renderUsage();
    await waitFor(() => expect(screen.getByText('adminUsage.logsLoadFailed')).toBeInTheDocument());
    await waitFor(() => expect(confirmedRecords(140)).toBeInTheDocument());
    expect(screen.queryByText('adminUsage.usageLoadFailed')).not.toBeInTheDocument();
  });

  it('keeps actual empty data as confirmed zero', async () => {
    state.mode = 'empty';
    renderUsage();
    await waitFor(() => expect(confirmedRecords(0)).toBeInTheDocument());
    expect(screen.getByText('0 KB')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
