import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import NotificationPanel from '@/components/NotificationPanel';

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
  approvalsEnabled: true, featureToggles: { qa: true }, featureTogglesReady: true,
  setSelectedTask: vi.fn(), setTaskDisplayMode: vi.fn(), currentView: 'board', setCurrentView: vi.fn(),
}) }));
vi.mock('@/hooks/useBrowserNotification', () => ({ useBrowserNotification: () => ({ permission: 'unsupported', requestPermission: vi.fn(), sendNotification: vi.fn() }) }));

const notification = (id: string, type: string, content: string) => ({
  id, recipient_id: 'member-1', sender_id: 'member-2', type, task_id: null as string | null, content, is_read: false, created_at: new Date().toISOString(),
});
const qa = (event: string) => JSON.stringify({ kind: 'qa', issueId: `issue-${event}`, title: `Checkout ${event}`, event });

beforeEach(async () => { await i18n.changeLanguage('en'); });
afterEach(async () => { cleanup(); rows.value = []; await i18n.changeLanguage('zh-TW'); });

describe('QA notifications', () => {
  it('say what happened to the bug instead of a generic label', async () => {
    rows.value = [notification('n1', 'qa_update', qa('create')), notification('n2', 'qa_update', qa('created')), notification('n3', 'qa_update', qa('comment')),
      notification('n4', 'qa_update', qa('request_handoff')), notification('n5', 'qa_update', qa('something_new'))];
    render(<NotificationPanel />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    expect(await screen.findByText('Checkout comment')).toBeTruthy();
    expect(screen.getAllByText('reported a new bug')).toHaveLength(2);
    expect(screen.getByText('commented on a bug')).toBeTruthy();
    expect(screen.getByText('asked you to take over a bug')).toBeTruthy();
    expect(screen.getByText('updated a bug')).toBeTruthy();
  });
});
