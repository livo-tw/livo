import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import type { Task } from '@/types';
import { useNotificationRules } from '@/hooks/useNotificationRules';
import { useNotificationTemplates } from '@/hooks/useNotificationTemplates';
import { useNotificationSender } from '@/hooks/useNotificationSender';
import NotificationToast from './NotificationToast';

interface ToastItem {
  id: string;
  task: Task;
  fromStatus: string;
  toStatus: string;
}

interface NotificationToastContextValue {
  triggerNotification: (task: Task, fromStatus: string, toStatus: string) => void;
}

const NotificationToastContext = createContext<NotificationToastContextValue>({
  triggerNotification: () => {},
});

// eslint-disable-next-line react-refresh/only-export-components
export function useNotificationToast() {
  return useContext(NotificationToastContext);
}

export function NotificationToastProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<ToastItem[]>([]);
  const { fetchRules, getEffectiveRule } = useNotificationRules();
  const { templates, fetchTemplates } = useNotificationTemplates();
  const { sendNotification } = useNotificationSender(templates);
  // Keep a stable ref to getEffectiveRule so triggerNotification always sees latest rules
  const getEffectiveRuleRef = useRef(getEffectiveRule);
  useEffect(() => { getEffectiveRuleRef.current = getEffectiveRule; }, [getEffectiveRule]);

  useEffect(() => {
    void fetchRules();
    void fetchTemplates();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const triggerNotification = useCallback((task: Task, fromStatus: string, toStatus: string) => {
    const rule = getEffectiveRuleRef.current('status_changed', fromStatus, toStatus, task.projectId);
    if (!rule) return;
    const id = `${task.id}-${Date.now()}`;
    setQueue(prev => [...prev, { id, task, fromStatus, toStatus }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setQueue(prev => prev.filter(t => t.id !== id));
  }, []);

  // Only show the first toast in the queue; others wait
  const current = queue[0];
  const currentRule = current
    ? getEffectiveRuleRef.current('status_changed', current.fromStatus, current.toStatus, current.task.projectId)
    : null;

  // If the rule was deleted while the toast is in the queue, silently discard it
  useEffect(() => {
    if (current && !currentRule) {
      dismiss(current.id);
    }
  }, [current, currentRule, dismiss]);

  return (
    <NotificationToastContext.Provider value={{ triggerNotification }}>
      {children}
      {current && currentRule && (
        <NotificationToast
          key={current.id}
          task={current.task}
          fromStatus={current.fromStatus}
          toStatus={current.toStatus}
          rule={currentRule}
          templates={templates}
          onDismiss={() => dismiss(current.id)}
          sendNotification={sendNotification}
        />
      )}
    </NotificationToastContext.Provider>
  );
}
