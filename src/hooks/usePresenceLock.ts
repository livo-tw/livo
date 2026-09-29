import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useAuthContext } from '@/context/AuthContext';
import { useMemberContext } from '@/context/MemberContext';
import { rpcUrl, getAccessTokenSync } from '@/lib/apiBase';

export interface PresenceViewer {
  memberId: string;
  name: string;
  avatar: string;
  color: string;
  editingField?: string;
}

const IS_LOCAL = import.meta.env.VITE_LOCAL_MODE === 'true';
const LOCK_TTL = 15;        // seconds — max time a lock survives without heartbeat
const HEARTBEAT_MS = 6_000;  // 6s — renew held locks (must be < LOCK_TTL)

/**
 * Hook for edit locking on management views.
 *
 * Production locking:
 *   - acquire/release via `field_locks` DB table (atomic, server-side)
 *   - "who is editing" driven by Realtime subscription on `field_locks`
 *     (much more reliable than Presence API)
 *   - Presence kept only for "who is viewing this page" avatars
 *   - TTL 30s + heartbeat 12s = stale locks clear fast even if release fails
 *
 * Local-mock mode: Presence-only (same as before).
 */
export function usePresenceLock(channelName: string, disabled = false) {
  const { currentMemberId } = useAuthContext();
  const { users } = useMemberContext();
  const [viewers, setViewers] = useState<PresenceViewer[]>([]);
  // DB-driven active locks from other users: { lock_key → locked_by }
  const [activeLocks, setActiveLocks] = useState<Map<string, string>>(new Map());
  const channelRef = useRef<RealtimeChannel | null>(null);
  const usersRef = useRef(users);
  const editingFieldRef = useRef<string | null>(null);
  const heldLocksRef = useRef<Set<string>>(new Set());
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { usersRef.current = users; }, [users]);

  // ── Subscribe to field_locks table changes (reliable editing indicator) ──
  useEffect(() => {
    if (IS_LOCAL || !currentMemberId || disabled) return;

    // Initial load: fetch current locks
    const loadLocks = async () => {
      const { data } = await supabase
        .from('field_locks')
        .select('lock_key, locked_by')
        .gt('expires_at', new Date().toISOString());
      if (data) {
        const map = new Map<string, string>();
        data.forEach((row: { lock_key: string; locked_by: string }) => {
          if (row.locked_by !== currentMemberId) {
            map.set(row.lock_key, row.locked_by);
          }
        });
        setActiveLocks(map);
      }
    };
    loadLocks();

    // Realtime subscription for lock changes
    const lockChannel = supabase
      .channel(`field-locks-${channelName}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'field_locks' }, () => {
        // Re-fetch all active locks on any change
        loadLocks();
      })
      .subscribe();

    // Periodic re-fetch as a safety net (every 10s)
    const pollInterval = setInterval(loadLocks, 10_000);

    return () => {
      clearInterval(pollInterval);
      supabase.removeChannel(lockChannel);
    };
  }, [channelName, currentMemberId]);

  // ── Presence channel (who is VIEWING — avatars only) ──────────────
  useEffect(() => {
    if (!currentMemberId || disabled) return;

    const channel = supabase.channel(channelName, {
      config: { presence: { key: currentMemberId } },
    });

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        const list: PresenceViewer[] = [];
        Object.entries(state).forEach(([key, presences]) => {
          if (key !== currentMemberId && Array.isArray(presences) && presences.length > 0) {
            const p = presences[0] as { name?: string; avatar?: string; color?: string; editingField?: string };
            list.push({
              memberId: key,
              name: p.name || '',
              avatar: p.avatar || '',
              color: p.color || '#6B778C',
              editingField: p.editingField || undefined,
            });
          }
        });
        setViewers(list);
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          const me = usersRef.current.find(u => u.id === currentMemberId);
          await channel.track({
            name: me?.name || '',
            avatar: me?.avatar || '',
            color: me?.color || '#6B778C',
            editingField: editingFieldRef.current,
          });
        }
      });

    channelRef.current = channel;

    return () => {
      channel.untrack();
      supabase.removeChannel(channel);
      channelRef.current = null;
      setViewers([]);
    };
  }, [channelName, currentMemberId, disabled]);

  // ── Heartbeat: renew DB locks every 12s ─────────────────────────
  useEffect(() => {
    if (IS_LOCAL || !currentMemberId || disabled) return;

    heartbeatRef.current = setInterval(async () => {
      for (const lockKey of heldLocksRef.current) {
        try {
          await supabase.rpc('acquire_field_lock', {
            p_lock_key: lockKey,
            p_member_id: currentMemberId,
            p_ttl_seconds: LOCK_TTL,
          });
        } catch { /* lock will expire naturally */ }
      }
    }, HEARTBEAT_MS);

    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    };
  }, [currentMemberId, disabled]);

  // ── Release all DB locks on unmount / page unload ───────────────
  useEffect(() => {
    if (IS_LOCAL || !currentMemberId || disabled) return;

    // Use fetch+keepalive so the request survives page close
    const releaseAllBeacon = () => {
      const url = rpcUrl('release_all_locks');
      const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
      const token = getAccessTokenSync() || key;
      try {
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': key,
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ p_member_id: currentMemberId }),
          keepalive: true,
        }).catch((_err: unknown) => { console.error('[LIVO] beforeunload fetch release failed:', _err); });
      } catch (_err: unknown) {
        // Best-effort cleanup on page close
      }
      heldLocksRef.current.clear();
    };

    // Normal async release for React unmount (not page close)
    const releaseAllAsync = () => {
      for (const lockKey of heldLocksRef.current) {
        supabase.rpc('release_field_lock', {
          p_lock_key: lockKey,
          p_member_id: currentMemberId,
        }).catch((_err: unknown) => { console.error('[LIVO] unmount lock release failed:', _err); });
      }
      heldLocksRef.current.clear();
    };

    window.addEventListener('beforeunload', releaseAllBeacon);
    return () => {
      window.removeEventListener('beforeunload', releaseAllBeacon);
      releaseAllAsync();
    };
  }, [currentMemberId]);

  // ── acquireLock ─────────────────────────────────────────────────
  const acquireLock = useCallback(async (fieldKey: string): Promise<{ acquired: boolean; lockerName?: string }> => {
    if (!currentMemberId || disabled) return { acquired: false };

    if (IS_LOCAL) {
      const existing = viewers.find(v => v.editingField === fieldKey);
      if (existing) return { acquired: false, lockerName: existing.name };
      editingFieldRef.current = fieldKey;
      const channel = channelRef.current;
      if (channel) {
        const me = usersRef.current.find(u => u.id === currentMemberId);
        await channel.track({ name: me?.name || '', avatar: me?.avatar || '', color: me?.color || '#6B778C', editingField: fieldKey });
      }
      return { acquired: true };
    }

    // Production: atomic DB lock
    try {
      const { data, error } = await supabase.rpc('acquire_field_lock', {
        p_lock_key: fieldKey,
        p_member_id: currentMemberId,
        p_ttl_seconds: LOCK_TTL,
      });

      if (error) {
        console.error('[LIVO] acquire_field_lock error:', error);
      } else if (data && !data.acquired) {
        const locker = usersRef.current.find(u => u.id === data.locked_by);
        return { acquired: false, lockerName: locker?.name || data.locked_by };
      }

      heldLocksRef.current.add(fieldKey);
    } catch (err) {
      console.error('[LIVO] acquire_field_lock exception:', err);
    }

    // Also update presence for viewing indicator
    editingFieldRef.current = fieldKey;
    const channel = channelRef.current;
    if (channel) {
      const me = usersRef.current.find(u => u.id === currentMemberId);
      await channel.track({ name: me?.name || '', avatar: me?.avatar || '', color: me?.color || '#6B778C', editingField: fieldKey });
    }
    return { acquired: true };
  }, [currentMemberId, viewers]);

  // ── releaseLock ─────────────────────────────────────────────────
  const releaseLock = useCallback(async (fieldKey?: string) => {
    if (!currentMemberId) return;

    if (fieldKey && !IS_LOCAL) {
      heldLocksRef.current.delete(fieldKey);
      supabase.rpc('release_field_lock', {
        p_lock_key: fieldKey,
        p_member_id: currentMemberId,
      }).catch(() => {
        // Fallback: fetch+keepalive
        try {
          const url = rpcUrl('release_field_lock');
          const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
          const token = getAccessTokenSync() || key;
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ p_lock_key: fieldKey, p_member_id: currentMemberId }),
            keepalive: true,
          }).catch((_err: unknown) => { console.error('[LIVO] fallback fetch release failed:', _err); });
        } catch (_err: unknown) {
          // Best-effort release on beforeunload
        }
      });
    }

    editingFieldRef.current = null;
    const channel = channelRef.current;
    if (channel) {
      const me = usersRef.current.find(u => u.id === currentMemberId);
      await channel.track({ name: me?.name || '', avatar: me?.avatar || '', color: me?.color || '#6B778C', editingField: null });
    }
  }, [currentMemberId]);

  // ── Legacy API ──────────────────────────────────────────────────
  const trackEditing = useCallback(async (fieldKey: string | null) => {
    if (fieldKey === null) {
      const prev = editingFieldRef.current;
      await releaseLock(prev || undefined);
    } else {
      await acquireLock(fieldKey);
    }
  }, [acquireLock, releaseLock]);

  // ── isLockedBy: check DB-driven activeLocks first, then presence ──
  const isLockedBy = useCallback((fieldKey: string): PresenceViewer | null => {
    // Check DB locks first (reliable)
    const lockedById = activeLocks.get(fieldKey);
    if (lockedById) {
      const member = usersRef.current.find(u => u.id === lockedById);
      if (member) {
        return {
          memberId: member.id,
          name: member.name,
          avatar: member.avatar || '',
          color: member.color || '#6B778C',
          editingField: fieldKey,
        };
      }
      return { memberId: lockedById, name: lockedById, avatar: '', color: '#6B778C', editingField: fieldKey };
    }
    // Fallback: presence (for local mode / graceful degradation)
    return viewers.find(v => v.editingField === fieldKey) || null;
  }, [activeLocks, viewers]);

  return { viewers, trackEditing, isLockedBy, acquireLock, releaseLock };
}
