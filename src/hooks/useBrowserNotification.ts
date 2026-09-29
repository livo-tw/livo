import { useState, useEffect, useCallback } from 'react';

type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

export const useBrowserNotification = () => {
  const [permission, setPermission] = useState<PermissionState>(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return Notification.permission as PermissionState;
  });

  // Auto-request permission on mount if not yet decided
  useEffect(() => {
    if (!('Notification' in window)) return;
    const current = Notification.permission;
    setPermission(current as PermissionState);
    if (current === 'default') {
      Notification.requestPermission().then(result => {
        setPermission(result as PermissionState);
      });
    }
  }, []);

  const requestPermission = useCallback(async () => {
    if (!('Notification' in window)) return 'unsupported' as const;
    const result = await Notification.requestPermission();
    setPermission(result as PermissionState);
    return result as PermissionState;
  }, []);

  const sendNotification = useCallback((title: string, options?: NotificationOptions) => {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    // Don't send if tab is focused
    if (document.visibilityState === 'visible') return;
    try {
      const n = new Notification(title, {
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        ...options,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      // Safari / iOS may throw
    }
  }, []);

  return { permission, requestPermission, sendNotification };
};
