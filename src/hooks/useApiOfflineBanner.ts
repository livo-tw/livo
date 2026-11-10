import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  getApiReachability, invalidateApiReachability, subscribeApiReachability,
} from '@/lib/apiReachability';

const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine;

/** Reconcile the browser's network hint with real SDK HTTP transport evidence. */
export function useApiOfflineBanner(): boolean {
  const [onlineHint, setOnlineHint] = useState(browserOnline);
  const previousHint = useRef(onlineHint);
  const api = useSyncExternalStore(subscribeApiReachability, getApiReachability, () => 'unknown');

  useEffect(() => {
    const refresh = () => {
      const next = browserOnline();
      // A real network-hint transition starts a new transport context. Merely
      // focusing an unchanged connection must not hide an API transport failure.
      if (next !== previousHint.current) invalidateApiReachability();
      previousHint.current = next;
      setOnlineHint(next);
    };
    const offline = () => {
      invalidateApiReachability();
      previousHint.current = false;
      setOnlineHint(false);
    };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('online', refresh);
    window.addEventListener('offline', offline);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    refresh();
    return () => {
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', offline);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  return api === 'failed' || (api === 'unknown' && !onlineHint);
}
