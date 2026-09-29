import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { User } from '@/types';
import type { OtherViewer } from './types';

/** Shape tracked via Supabase Presence for each viewer. */
type PresencePayload = {
  name: string;
  avatar: string;
  color: string;
  editingField?: string;
};

export function useTaskPresence(
  taskId: string | undefined,
  currentMemberId: string | undefined,
  users: User[],
) {
  const [otherViewers, setOtherViewers] = useState<OtherViewer[]>([]);
  const presenceChannelRef = useRef<RealtimeChannel | null>(null);

  const trackPresence = useCallback(async (extraFields: Record<string, unknown> = {}) => {
    const channel = presenceChannelRef.current;
    if (!channel || !currentMemberId) return;
    const me = users.find(u => u.id === currentMemberId);
    await channel.track({ name: me?.name || '', avatar: me?.avatar || '', color: me?.color || '#6B778C', ...extraFields });
  }, [currentMemberId, users]);

  const getFieldLocker = useCallback((fieldKey: string): OtherViewer | undefined => {
    return otherViewers.find(v => v.editingField === fieldKey);
  }, [otherViewers]);

  // Presence channel effect
  useEffect(() => {
    if (!taskId || !currentMemberId) return;
    const channelName = `task-presence-${taskId}`;
    const channel = supabase.channel(channelName, { config: { presence: { key: currentMemberId } } });
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        const viewers: OtherViewer[] = [];
        Object.entries(state).forEach(([key, presences]) => {
          if (key !== currentMemberId && Array.isArray(presences) && presences.length > 0) {
            const p = presences[0] as PresencePayload;
            viewers.push({ memberId: key, name: p.name || '', avatar: p.avatar || '', color: p.color || '#6B778C', editingField: p.editingField || undefined });
          }
        });
        setOtherViewers(viewers);
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          const me = users.find(u => u.id === currentMemberId);
          await channel.track({ name: me?.name || '', avatar: me?.avatar || '', color: me?.color || '#6B778C' });
        }
      });
    presenceChannelRef.current = channel;
    return () => {
      channel.untrack();
      supabase.removeChannel(channel);
      presenceChannelRef.current = null;
      setOtherViewers([]);
    };
  }, [taskId, currentMemberId, users]);

  return { otherViewers, trackPresence, getFieldLocker };
}
