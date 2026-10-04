import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import NotificationPanel from '@/components/NotificationPanel';
import { formatApprovalNotification, parseApprovalNotification } from '@/lib/approvalNotifications';

const rows = vi.hoisted(() => ({ value: [] as Record<string, unknown>[] }));
vi.mock('@/integrations/supabase/client', () => {
  const query = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: rows.value, error: null as null }) };
  const channel = { on: () => channel, subscribe: () => channel };
  return { supabase: { from: () => query, channel: () => channel, removeChannel: () => {} } };
});
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'member-1' }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [{ id: 'member-2', name: 'Example approver', avatar: 'E', color: '#0065FF' }] }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [] as never[] }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({
  approvalsEnabled: true, featureToggles: { qa: false }, featureTogglesReady: true,
  setSelectedTask: vi.fn(), setTaskDisplayMode: vi.fn(), currentView: 'board', setCurrentView: vi.fn(),
}) }));
vi.mock('@/hooks/useBrowserNotification', () => ({ useBrowserNotification: () => ({ permission: 'unsupported', requestPermission: vi.fn(), sendNotification: vi.fn() }) }));

const notification = (id: string, type: string, content: string) => ({
  id, recipient_id: 'member-1', sender_id: 'member-2', type, task_id: null as string | null, content, is_read: false, created_at: new Date().toISOString(),
});
const cloudJson = (operation: string) => JSON.stringify({ kind: 'approval', requestId: 'request-1', taskTitle: 'Example release checklist', operation, version: 2 });

beforeEach(async () => { await i18n.changeLanguage('en'); });
afterEach(async () => { cleanup(); rows.value = []; await i18n.changeLanguage('zh-TW'); });

describe('approval notifications', () => {
  it('renders Cloud approval JSON as readable text and keeps Docker plain text', async () => {
    rows.value = [
      notification('n1', 'approval_requested', cloudJson('submit')),
      notification('n2', 'approval_completed', cloudJson('approve')),
      notification('n3', 'approval_completed', cloudJson('something_new')),
      notification('n4', 'approval_completed', 'EX-1 - Example release checklist [approved]'),
    ];
    render(<NotificationPanel />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    expect(await screen.findByText('Submitted for approval: Example release checklist')).toBeTruthy();
    expect(screen.getByText('Approved: Example release checklist')).toBeTruthy();
    expect(screen.getByText('Approval updated: Example release checklist')).toBeTruthy();
    expect(screen.getByText('EX-1 - Example release checklist [approved]')).toBeTruthy();
    expect(screen.getByText('requested your approval')).toBeTruthy();
    expect(screen.getAllByText('updated an approval')).toHaveLength(3);
    expect(document.body.textContent).not.toContain('"kind"');
  });

  it('parses only approval JSON and localizes the action', async () => {
    expect(parseApprovalNotification('EX-1 - Title [requested]')).toBeNull();
    expect(parseApprovalNotification('{"kind":"qa","title":"x"}')).toBeNull();
    expect(parseApprovalNotification('{not json')).toBeNull();
    const value = parseApprovalNotification(cloudJson('reject'))!;
    expect(value).toMatchObject({ kind: 'approval', requestId: 'request-1', operation: 'reject' });
    await i18n.changeLanguage('zh-TW');
    expect(formatApprovalNotification(value, i18n.t.bind(i18n))).toBe('已駁回：Example release checklist');
    await i18n.changeLanguage('zh-CN');
    expect(formatApprovalNotification({ ...value, operation: 'return' }, i18n.t.bind(i18n))).toBe('已退回修改：Example release checklist');
  });
});
