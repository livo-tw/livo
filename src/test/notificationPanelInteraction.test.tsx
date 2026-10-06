import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import NotificationPanel from '@/components/NotificationPanel';

const state = vi.hoisted(() => ({
  mobile: true, permission: 'default', requestPermission: vi.fn(), updates: vi.fn(), selectedTask: vi.fn(),
  rows: [] as Record<string, unknown>[],
}));
vi.mock('@/integrations/supabase/client', () => {
  const query = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: state.rows, error: null as null }) };
  const channel = { on: () => channel, subscribe: () => channel };
  return { supabase: {
    from: () => ({ ...query, update: (value: unknown) => { state.updates(value); return {
      eq: async () => ({ error: null as null }), in: async () => ({ error: null as null }),
    }; } }),
    channel: () => channel, removeChannel: () => {},
  } };
});
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'example-member' }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as never[] }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [{ id: 'example-task', taskKey: 'EX-1', title: 'Example task' }] }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({
  approvalsEnabled: true, featureToggles: { qa: true }, featureTogglesReady: true,
  setSelectedTask: state.selectedTask, currentView: 'board', setCurrentView: vi.fn(),
}) }));
vi.mock('@/hooks/useBrowserNotification', () => ({ useBrowserNotification: () => ({
  permission: state.permission, requestPermission: state.requestPermission, sendNotification: vi.fn(),
}) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => state.mobile }));

beforeEach(async () => {
  vi.clearAllMocks(); state.mobile = true; state.permission = 'default'; state.rows = [];
  await i18n.changeLanguage('en');
});
afterEach(async () => { cleanup(); await i18n.changeLanguage('zh-TW'); });

const openPanel = async () => {
  const trigger = screen.getByRole('button', { name: /notifications/i });
  trigger.focus(); await act(async () => { fireEvent.click(trigger); });
  return { trigger, panel: screen.getByRole('dialog', { name: i18n.t('notification.panelTitle') }) };
};

describe('notification panel dismissal and navigation', () => {
  it('provides a translated close button that returns focus without requesting browser permission or changing notifications', async () => {
    render(<NotificationPanel />); const { trigger, panel } = await openPanel();
    const close = within(panel).getByRole('button', { name: i18n.t('common.close') });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(state.requestPermission).not.toHaveBeenCalled(); expect(state.updates).not.toHaveBeenCalled();
  });

  it('dismisses Escape from the browser-notification action and restores the invoking trigger', async () => {
    render(<NotificationPanel />); const { trigger, panel } = await openPanel();
    const enable = within(panel).getByRole('button', { name: i18n.t('notification.enableButton') });
    enable.focus(); fireEvent.keyDown(enable, { key: 'Escape', code: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger);
    expect(state.requestPermission).not.toHaveBeenCalled();
  });

  it('keeps the explicit permission action available without requesting permission on open', async () => {
    render(<NotificationPanel />); const { panel } = await openPanel();
    expect(state.requestPermission).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole('button', { name: i18n.t('notification.enableButton') }));
    expect(state.requestPermission).toHaveBeenCalledTimes(1); expect(screen.getByRole('dialog')).toBe(panel);
  });

  it('contains keyboard focus on a phone and respects an Escape already consumed by another control', async () => {
    render(<NotificationPanel />); const { panel } = await openPanel();
    const close = within(panel).getByRole('button', { name: i18n.t('common.close') });
    const enable = within(panel).getByRole('button', { name: i18n.t('notification.enableButton') });
    enable.focus(); fireEvent.keyDown(enable, { key: 'Tab' }); expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(enable);
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); consumed.preventDefault();
    fireEvent(enable, consumed); expect(screen.getByRole('dialog')).toBe(panel);
  });

  it('retains desktop dropdown semantics and closes Escape without trapping focus', async () => {
    state.mobile = false;
    render(<><NotificationPanel /><button>Outside panel</button></>); const { trigger, panel } = await openPanel();
    expect(panel).not.toHaveAttribute('aria-modal'); expect(document.activeElement).toBe(trigger);
    const outside = screen.getByRole('button', { name: 'Outside panel' }); outside.focus();
    fireEvent.keyDown(outside, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger);
    outside.focus(); fireEvent.keyDown(outside, { key: 'Escape' }); expect(document.activeElement).toBe(outside);
  });

  it('still marks a selected notification as read and opens its task', async () => {
    state.rows = [{ id: 'example-notification', recipient_id: 'example-member', sender_id: 'example-sender',
      type: 'comment', task_id: 'example-task', content: 'Example reply', is_read: false, created_at: new Date().toISOString() }];
    render(<NotificationPanel />); await openPanel();
    const notification = await screen.findByRole('button', { name: /Example reply/ }); fireEvent.click(notification);
    await waitFor(() => expect(state.updates).toHaveBeenCalledWith({ is_read: true }));
    expect(state.selectedTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'example-task' }));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(state.requestPermission).not.toHaveBeenCalled();
  });
});
