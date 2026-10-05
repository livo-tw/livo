import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, USING_MOCK_BACKEND } from '@/integrations/supabase/client';
import { applyNavigation, emptyNavigation, visibleNavigation, type NavigationCommand, type NavigationPage, type NavigationPreferences } from '../../worker/src/knowledgePreferenceModel';

type Cache = { preferences: NavigationPreferences; pending: NavigationCommand[] };
const rpc = supabase as unknown as { rpc: (name: string, args: NavigationCommand) => Promise<{ data: NavigationPreferences | null; error: { message: string } | null }> };
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const storageRead = (key: string): Cache => { try { return JSON.parse(localStorage.getItem(key) || 'null') || { preferences: emptyNavigation(), pending: [] }; } catch { return { preferences: emptyNavigation(), pending: [] }; } };
const storageWrite = (key: string, cache: Cache) => { try { localStorage.setItem(key, JSON.stringify(cache)); return true; } catch { return false; } };

/** Owner IDs are workspace-prefixed in Cloud; origin isolates separate self-hosts.
 * No title, body, link, or attachment is ever persisted in this preference cache. */
export function useKnowledgeNavigation(identity: string, pages: NavigationPage[]) {
  const key = `livo:kb-navigation:v1:${window.location.origin}:${identity}`;
  const [snapshot, setSnapshot] = useState({ identity, data: emptyNavigation() });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'loading' | 'synced' | 'local' | 'memory' | 'error'>('loading');
  const [error, setError] = useState('');
  const latest = useRef({ identity, pages, key }); latest.current = { identity, pages, key };
  const raw = useRef<NavigationPreferences>(emptyNavigation());
  const pending = useRef<NavigationCommand[]>([]);
  const locked = useRef<string | null>(null);
  const publish = useCallback((owner: string, value: NavigationPreferences) => {
    if (latest.current.identity !== owner) return;
    raw.current = value; setSnapshot({ identity: owner, data: value });
  }, []);

  const refresh = useCallback(async () => {
    if (!identity || locked.current === identity) return;
    const owner = identity;
    try {
      const cached = storageRead(key);
      if (USING_MOCK_BACKEND || offline()) {
        pending.current = cached.pending || []; publish(owner, cached.preferences);
        // The demo keeps preferences on this device by design; only a real offline client waits to sync.
        if (latest.current.identity === owner) setStatus(USING_MOCK_BACKEND ? 'synced' : 'local');
        return;
      }
      locked.current = owner; setSaving(true);
      let result = await rpc.rpc('kb_preferences', { p_action: 'read' });
      if (result.error || !result.data) throw new Error(result.error?.message || 'kb_failed');
      let value = result.data;
      const queue = cached.pending || [];
      while (queue.length && latest.current.identity === owner) {
        const command = queue[0];
        // Revalidate pending IDs against the current authorized page snapshot.
        if (!latest.current.pages.some(p => p.id === command.p_page_id)) { queue.shift(); continue; }
        result = await rpc.rpc('kb_preferences', { ...command, p_version: value.version });
        if (result.error || !result.data) {
          if (result.error?.message === 'kb_forbidden') { queue.shift(); continue; }
          throw new Error(result.error?.message || 'kb_failed');
        }
        value = result.data; queue.shift();
        storageWrite(key, { preferences: value, pending: queue });
      }
      if (latest.current.identity !== owner) return;
      pending.current = queue; publish(owner, value); storageWrite(key, { preferences: value, pending: queue }); setError(''); setStatus('synced');
    } catch (failure) {
      if (latest.current.identity !== owner) return;
      // A permission/server failure must never revive an old cached snapshot.
      setError(failure instanceof Error ? failure.message : 'kb_failed'); setStatus('error');
    } finally { if (locked.current === owner) locked.current = null; if (latest.current.identity === owner) setSaving(false); }
  }, [identity, key, publish]);

  useEffect(() => {
    raw.current = emptyNavigation(); pending.current = []; setSnapshot({ identity, data: emptyNavigation() }); setError(''); setStatus('loading');
    void refresh();
    const onFocus = (): void => { void refresh(); };
    window.addEventListener('online', onFocus); window.addEventListener('focus', onFocus);
    const interval = window.setInterval(onFocus, 30000);
    return () => { window.removeEventListener('online', onFocus); window.removeEventListener('focus', onFocus); clearInterval(interval); };
  }, [identity, refresh]);

  const mutate = useCallback(async (command: NavigationCommand) => {
    if (locked.current === identity || !identity) return false;
    const owner = identity; locked.current = owner; setSaving(true); setSaving(true); setError('');
    try {
      if (USING_MOCK_BACKEND || offline()) {
        const value = applyNavigation(raw.current, latest.current.pages, command);
        if (!USING_MOCK_BACKEND) pending.current.push(command);
        publish(owner, value);
        const stored = storageWrite(key, { preferences: value, pending: pending.current });
        setStatus(USING_MOCK_BACKEND ? 'synced' : stored ? 'local' : 'memory');
        return true;
      }
      let result = await rpc.rpc('kb_preferences', { ...command, p_version: raw.current.version });
      if (result.error?.message === 'kb_conflict') {
        const fresh = await rpc.rpc('kb_preferences', { p_action: 'read' });
        if (fresh.error || !fresh.data) throw new Error(fresh.error?.message || 'kb_failed');
        result = await rpc.rpc('kb_preferences', { ...command, p_version: fresh.data.version });
      }
      if (result.error || !result.data) throw new Error(result.error?.message || 'kb_failed');
      if (latest.current.identity !== owner) return false;
      publish(owner, result.data); storageWrite(key, { preferences: result.data, pending: [] }); setStatus('synced'); return true;
    } catch (failure) {
      if (latest.current.identity === owner) { setError(failure instanceof Error ? failure.message : 'kb_failed'); setStatus('error'); }
      return false;
    } finally { if (locked.current === owner) locked.current = null; if (latest.current.identity === owner) setSaving(false); }
  }, [identity, key, publish]);

  return { preferences: visibleNavigation(snapshot.identity === identity ? snapshot.data : emptyNavigation(), pages), mutate, refresh, saving, status, error };
}
