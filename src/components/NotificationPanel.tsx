import { isEventEnabled } from '@/lib/featureToggles';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, BellRing, BellOff, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuthContext } from '@/context/AuthContext';
import { useMemberContext } from '@/context/MemberContext';
import { useTaskContext } from '@/context/TaskContext';
import { useUIContext } from '@/context/UIContext';
import { useBrowserNotification } from '@/hooks/useBrowserNotification';
import { parseQaNotification } from '@/lib/qa/notifications';

// ── Constants ────────────────────────────────────────────────────────────────

const NOTIFICATION_TYPE_KEYS: Record<string, string> = {
  mention: 'notification.types.mention',
  assign: 'notification.types.assign',
  review: 'notification.types.review',
  comment: 'notification.types.comment',
  comment_reply: 'notification.types.commentReply',
  status_changed: 'notification.types.statusChanged',
  due_soon: 'notification.types.dueSoon',
  system: 'notification.types.system',
  qa_update: 'qa.title',
};

// ── Types ────────────────────────────────────────────────────────────────────

interface Notification {
  id: string;
  recipientId: string;
  senderId: string;
  type: string;
  taskId: string | null;
  content: string;
  isRead: boolean;
  createdAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

import i18n from '@/i18n';

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return i18n.t('time.justNow');
  if (mins < 60) return i18n.t('time.minutesAgo', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return i18n.t('time.hoursAgo', { count: hrs });
  return i18n.t('time.daysAgo', { count: Math.floor(hrs / 24) });
}

// ── Component ────────────────────────────────────────────────────────────────

const NotificationPanel = () => {
  const { t } = useTranslation();
  const { currentMemberId } = useAuthContext();
  const { users } = useMemberContext();
  const { allTasks } = useTaskContext();
  const { approvalsEnabled, featureToggles, featureTogglesReady, setSelectedTask, setTaskDisplayMode, currentView, setCurrentView } = useUIContext();
  const qaEnabled = featureTogglesReady && featureToggles.qa;
  const [allNotifications, setNotifications] = useState<Notification[]>([]);
  const notifications = allNotifications.filter(notification => isEventEnabled(notification.type, approvalsEnabled) && (notification.type !== 'qa_update' || qaEnabled));
  const notificationText = (type: string, content: string) => type === 'qa_update' ? parseQaNotification(content)?.title || t('qa.title') : content;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { permission, requestPermission, sendNotification } = useBrowserNotification();

  // ── Lookup maps (O(1) lookups instead of O(n) in render) ─────────────────

  const userMap = useMemo(
    () => new Map(users.map(u => [u.id, u])),
    [users],
  );

  const taskMap = useMemo(
    () => new Map(allTasks.map(t => [t.id, t])),
    [allTasks],
  );

  // ── Data fetching ─────────────────────────────────────────────────────────

  const fetchNotifications = useCallback(async () => {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('recipient_id', currentMemberId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) {
      console.error('[LIVO] NotificationPanel load failed:', error);
      toast.error(t('notification.loadFailed'));
      return;
    }
    if (data) {
      setNotifications(data.map(r => ({
        id: r.id,
        recipientId: r.recipient_id,
        senderId: r.sender_id,
        type: r.type,
        taskId: r.task_id,
        content: r.content,
        isRead: r.is_read,
        createdAt: r.created_at,
      })));
    }
  }, [currentMemberId]);

  useEffect(() => {
    if (currentMemberId) fetchNotifications();
  }, [currentMemberId, fetchNotifications]);

  // ── Realtime subscription + browser notification ──────────────────────────

  useEffect(() => {
    const channel = supabase
      .channel('notifications-rt')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, (payload) => {
        const r = payload.new as { id: string; recipient_id: string; sender_id: string; type: string; task_id: string; content: string; is_read: boolean; created_at: string };
        if (r.recipient_id === currentMemberId && isEventEnabled(r.type, approvalsEnabled) && (r.type !== 'qa_update' || qaEnabled)) {
          const newNotif: Notification = {
            id: r.id, recipientId: r.recipient_id, senderId: r.sender_id,
            type: r.type, taskId: r.task_id, content: r.content,
            isRead: r.is_read, createdAt: r.created_at,
          };
          setNotifications(prev => [newNotif, ...prev]);

          const senderName = userMap.get(r.sender_id)?.name || t('notification.systemSender');
          const action = NOTIFICATION_TYPE_KEYS[r.type] ? t(NOTIFICATION_TYPE_KEYS[r.type]) : t('notification.types.system');
          sendNotification(`${senderName} ${action}`, { body: notificationText(r.type, r.content || ''), tag: r.id });
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [approvalsEnabled, qaEnabled, currentMemberId, userMap, sendNotification]);

  // ── Close on click outside ────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────────

  const unreadCount = notifications.filter(n => !n.isRead).length;

  const markAllRead = async () => {
    const unreadIds = notifications.filter(n => !n.isRead).map(n => n.id);
    if (unreadIds.length === 0) return;
    try {
      const { error } = await supabase.from('notifications').update({ is_read: true }).in('id', unreadIds);
      if (error) { console.error('[NotificationPanel] markAllRead failed:', error.message); return; }
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
    } catch (err: any) {
      toast.error(t('error.operationFailed'));
      console.error(err);
    }
  };

  const handleClick = (n: Notification) => {
    const qa = n.type === 'qa_update' ? parseQaNotification(n.content) : null;
    if (n.type === 'qa_update' && (!qaEnabled || !qa)) return;
    if (!n.isRead) {
      Promise.resolve(supabase.from('notifications').update({ is_read: true }).eq('id', n.id)).then(({ error }) => {
        if (error) { console.error('[NotificationPanel] markRead failed:', error.message); return; }
        setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, isRead: true } : x));
      }).catch((err: any) => {
        toast.error(t('error.operationFailed'));
        console.error(err);
      });
    }
    if (qa) {
      const url = new URL(window.location.href); url.searchParams.set('qa', qa.issueId);
      window.history.replaceState({}, '', url.toString());
      setSelectedTask(null); setCurrentView('qa'); setOpen(false);
      window.dispatchEvent(new Event('livo:qa-navigation')); return;
    }
    const task = n.taskId ? taskMap.get(n.taskId) : undefined;
    if (task) {
      if (!['board', 'all-list', 'my-tasks', 'gantt', 'backlog', 'dashboard'].includes(currentView)) {
        setCurrentView('board');
      }
      setTaskDisplayMode('side');
      setSelectedTask(task);
      setOpen(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => { setOpen(!open); if (!open) fetchNotifications(); }}
        aria-label={unreadCount > 0 ? t('notification.unreadCount', { count: unreadCount }) : t('notification.panelTitle')}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="relative flex items-center justify-center min-w-[44px] min-h-[44px] rounded-md text-sidebar-foreground hover:bg-sidebar-hover transition-colors"
      >
        <Bell size={18} aria-hidden="true" />
        {unreadCount > 0 && (
          <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* mobile backdrop — tap to close */}
          <div onClick={() => setOpen(false)} className="md:hidden fixed inset-0 z-[99] bg-black/40 backdrop-blur-[2px]" aria-hidden="true" />
          <div role="dialog" aria-label={t('notification.panelTitle')} className="z-[100] bg-card border border-border shadow-xl overflow-hidden flex flex-col fixed inset-x-0 top-14 bottom-0 rounded-t-xl md:absolute md:inset-auto md:right-0 md:top-10 md:bottom-auto md:w-[400px] md:max-w-[calc(100vw-16px)] md:rounded-lg">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
            <span className="text-base font-bold text-foreground">{t('notification.panelTitle')}</span>
            <div className="flex items-center gap-2">
              {permission === 'unsupported' ? null : permission === 'granted' ? (
                <span className="text-[12px] text-green-600 flex items-center gap-1" title={t('notification.browserEnabled')}>
                  <BellRing size={13} /> {t('notification.enabledBadge')}
                </span>
              ) : permission === 'denied' ? (
                <span className="text-[12px] text-muted-foreground flex items-center gap-1" title={t('notification.browserBlocked')}>
                  <BellOff size={13} /> {t('notification.blockedBadge')}
                </span>
              ) : (
                <button
                  onClick={requestPermission}
                  className="text-[12px] text-primary hover:underline font-medium flex items-center gap-1"
                  title={t('notification.enableButtonTitle')}
                >
                  <BellRing size={13} /> {t('notification.enableButton')}
                </button>
              )}
              {unreadCount > 0 && (
                <button onClick={markAllRead} className="text-[13px] text-primary hover:underline font-medium">
                  {t('notification.markAllRead')}
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 md:max-h-[420px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
                <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                  <Bell size={22} className="text-muted-foreground" aria-hidden="true" />
                </div>
                <p className="text-sm font-medium text-foreground">{t('notification.emptyTitle')}</p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t('notification.emptyDescription')}
                </p>
              </div>
            ) : (
              notifications.map(n => {
                const sender = userMap.get(n.senderId);
                const task = n.taskId ? taskMap.get(n.taskId) : undefined;
                const isDueSoon = n.type === 'due_soon' || n.type === 'system';
                return (
                  <button
                    key={n.id}
                    onClick={() => handleClick(n)}
                    className={`w-full text-left px-4 py-3.5 border-b border-border/50 hover:bg-accent/50 transition-colors min-h-[56px] ${
                      !n.isRead ? 'bg-primary/5' : ''
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      {isDueSoon ? (
                        <div className="w-7 h-7 rounded-full bg-amber-500 flex items-center justify-center text-white flex-shrink-0 mt-0.5">
                          <Clock size={14} />
                        </div>
                      ) : sender ? (
                        <span
                          className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 mt-0.5"
                          style={{ backgroundColor: sender.color }}
                        >
                          {sender.avatar}
                        </span>
                      ) : (
                        <span className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-[10px] flex-shrink-0 mt-0.5">?</span>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-foreground leading-snug">
                          {!isDueSoon && <span className="font-bold">{sender?.name || t('notification.unknownSender')} </span>}
                          {NOTIFICATION_TYPE_KEYS[n.type] ? t(NOTIFICATION_TYPE_KEYS[n.type]) : t('notification.types.system')}
                        </p>
                        {task && (
                          <p className="text-[13px] text-muted-foreground mt-0.5 line-clamp-1">
                            <span className="font-mono">{task.taskKey}</span> {task.title}
                          </p>
                        )}
                        {n.content && n.type !== 'assign' && n.type !== 'review' && (
                          <p className="text-[12px] text-muted-foreground/70 line-clamp-2 mt-0.5">{notificationText(n.type, n.content)}</p>
                        )}
                        <p className="text-xs text-muted-foreground/50 mt-0.5">{timeAgo(n.createdAt)}</p>
                      </div>
                      {!n.isRead && <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0 mt-1.5" />}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
        </>
      )}
    </div>
  );
};

export default NotificationPanel;
