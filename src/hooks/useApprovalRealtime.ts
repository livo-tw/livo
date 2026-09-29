import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Subscribes to Realtime changes on approval_requests and calls onRefresh
 * whenever an INSERT or UPDATE occurs. Cleans up on unmount.
 */
export function useApprovalRealtime(
  currentMemberId: string | null | undefined,
  onRefresh: () => void,
) {
  const refreshRef = useRef(onRefresh);
  useEffect(() => { refreshRef.current = onRefresh; }, [onRefresh]);

  useEffect(() => {
    if (!currentMemberId) return;
    const channel = supabase
      .channel('approval-requests-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'approval_requests' },
        () => { void refreshRef.current(); })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'approval_requests' },
        () => { void refreshRef.current(); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [currentMemberId]);
}
