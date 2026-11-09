import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import NotificationPanel from '@/components/NotificationPanel';

const rows = vi.hoisted(() => ({ value: [] as Record<string, unknown>[], memberId: 'member-1',
  handler: undefined as undefined | ((payload: { new: Record<string, unknown> }) => void), people: vi.fn(), notify: vi.fn() }));
vi.mock('@/lib/qa/notificationPeople', () => ({ qaNotificationPeople: rows.people }));
vi.mock('@/integrations/supabase/client', () => {
  const query = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: rows.value, error: null as null }) };
  const channel = { on: (_event: string, _filter: unknown, callback: typeof rows.handler) => { rows.handler = callback; return channel; }, subscribe: () => channel };
  return { supabase: { from: () => query, channel: () => channel, removeChannel: () => {} } };
});
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: rows.memberId }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [{ id: 'member-2', name: 'Example approver', avatar: 'E', color: '#0065FF' }] }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [] as never[] }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({
  approvalsEnabled: true, featureToggles: { qa: true }, featureTogglesReady: true,
  setSelectedTask: vi.fn(), setTaskDisplayMode: vi.fn(), currentView: 'board', setCurrentView: vi.fn(),
}) }));
vi.mock('@/hooks/useBrowserNotification', () => ({ useBrowserNotification: () => ({ permission: 'unsupported', requestPermission: vi.fn(), sendNotification: rows.notify }) }));

const notification = (id: string, type: string, content: string) => ({
  id, recipient_id: 'member-1', sender_id: 'member-2', type, task_id: null as string | null, content, is_read: false, created_at: new Date().toISOString(),
});
const qa = (event: string) => JSON.stringify({ kind: 'qa', issueId: `issue-${event}`, title: `Checkout ${event}`, event });

beforeEach(async () => { rows.memberId = 'member-1'; rows.people.mockReset().mockResolvedValue({}); rows.notify.mockReset(); await i18n.changeLanguage('en'); });
afterEach(async () => { cleanup(); rows.value = []; await i18n.changeLanguage('zh-TW'); });

describe('QA notifications', () => {
  it('shows the actual external reporter beside the same ordinary QA event', async () => {
    rows.value = [{ ...notification('n-external', 'qa_update', qa('create')), sender_id: 'visitor-example' }];
    rows.people.mockResolvedValue({ 'visitor-example': 'Example collaborator' });
    render(<NotificationPanel />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    expect(await screen.findByText('Example collaborator')).toBeTruthy();
    expect(screen.getByText('reported a new bug')).toBeTruthy();
  });
  it('uses the real external sender in browser notifications', async () => {
    rows.people.mockResolvedValue({ 'visitor-example': 'Example collaborator' });
    render(<NotificationPanel />);
    await act(async () => { rows.handler?.({ new: { ...notification('n-live', 'qa_update', qa('comment')), sender_id: 'visitor-example' } }); });
    await waitFor(() => expect(rows.notify).toHaveBeenCalledWith('Example collaborator commented on a bug', expect.objectContaining({ tag: 'n-live' })));
  });
  it('does not render inherited object properties as sender names', async () => {
    rows.value = [{ ...notification('n-prototype', 'qa_update', qa('create')), sender_id: 'constructor' }];
    render(<NotificationPanel />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    expect(await screen.findByText('Checkout create')).toBeTruthy();
    await waitFor(() => expect(rows.people).toHaveBeenCalled());
    expect(screen.getByText(i18n.t('notification.unknownSender'))).toBeTruthy();
  });
  it('does not apply a previous account\'s delayed sender labels', async () => {
    let resolve!: (names: Record<string, string>) => void;
    rows.people.mockImplementation(() => new Promise<Record<string, string>>(done => { resolve = done; }));
    rows.value = [{ ...notification('n-old', 'qa_update', qa('create')), sender_id: 'visitor-example' }];
    const view = render(<NotificationPanel />);
    await waitFor(() => expect(rows.people).toHaveBeenCalledTimes(1));
    rows.memberId = 'member-new'; rows.value = [];
    view.rerender(<NotificationPanel />);
    await act(async () => resolve({ 'visitor-example': 'Previous account label' }));
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    expect(screen.queryByText('Previous account label')).toBeNull();
    expect(screen.queryByText('Checkout create')).toBeNull();
  });
  it('ignores late realtime inserts from a previous account subscription', async () => {
    const view = render(<NotificationPanel />);
    const oldHandler = rows.handler;
    rows.memberId = 'member-new'; rows.value = [];
    view.rerender(<NotificationPanel />);
    await act(async () => oldHandler?.({ new: { ...notification('n-old-live', 'qa_update', qa('comment')), sender_id: 'visitor-example' } }));
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    expect(screen.queryByText('Checkout comment')).toBeNull();
    expect(rows.notify).not.toHaveBeenCalled();
    expect(rows.people).not.toHaveBeenCalled();
  });
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
