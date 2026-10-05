import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { requestQueries, type ApprovalRequest } from '@/lib/approvalQueries';
import { actionableApprovals } from '@/lib/approval/pending';
import { useAuthContext } from '@/context/AuthContext';

/**
 * How many pending approvals the current member can act on: the same rule as
 * the pending list, not every pending task in the workspace. Re-read whenever
 * `refreshKey` changes (a task's approval state changed, the list closed).
 * Null while unknown or when the read failed, so no wrong number is shown.
 */
export function useActionableApprovalCount(enabled: boolean, refreshKey: unknown): number | null {
  const { currentMemberId, currentMember } = useAuthContext();
  const role = currentMember?.role, isActive = currentMember?.isActive;
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || !currentMemberId) { setCount(null); return; }
    let current = true;
    Promise.resolve(requestQueries.fetchPending(supabase)).then(({ data, error }: { data: unknown; error: unknown }) => {
      if (!current) return;
      setCount(error ? null : actionableApprovals((data as ApprovalRequest[] | null) ?? [], { id: currentMemberId, role, isActive }).length);
    }, () => { if (current) setCount(null); });
    return () => { current = false; };
  }, [enabled, refreshKey, currentMemberId, role, isActive]);
  return count;
}
