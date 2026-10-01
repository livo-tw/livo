import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { fromTable } from './supabaseQuery';
import type { ApprovalRequest } from './approvalQueries';
import { canManageFeatureToggles } from './featureToggles';

/** Shared by requester cancellation and the admin's withdraw-all flow. */
export async function withdrawApproval(
  db: SupabaseClient<Database>, requestId: string, actor: { id: string; role?: string },
  recordActivity: (request: ApprovalRequest) => Promise<void>,
): Promise<void> {
  const result = await fromTable(db, 'approval_requests').select('*').eq('id', requestId).single();
  if (result.error) throw result.error;
  const request = result.data as ApprovalRequest | null;
  if (!request) throw new Error('Approval request not found');
  const admin = canManageFeatureToggles(actor.role);
  if (request.requested_by !== actor.id && !admin) throw new Error('Not allowed to withdraw this request');
  if (request.status !== 'pending' && request.status !== 'cancelled') return;
  const wasPending = request.status === 'pending';

  if (wasPending) {
    let query = fromTable(db, 'approval_requests')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', requestId).eq('status', 'pending');
    if (!admin) query = query.eq('requested_by', actor.id);
    const cancelled = await query.select('id').maybeSingle();
    if (cancelled.error) throw cancelled.error;
    if (!cancelled.data) throw new Error('Approval changed; reload and try again');
  }
  // The database also clears this atomically on cancellation. Keep this guarded
  // write for demo clients and retrying a previously interrupted withdrawal.
  const cleared = await fromTable(db, 'tasks')
    .update({ approval_status: null, current_approval_id: null })
    .eq('id', request.task_id).eq('current_approval_id', requestId);
  if (cleared.error) throw cleared.error;
  if (wasPending) await recordActivity(request);
}

/** Do not persist OFF until every withdrawal and the final live check succeed. */
export async function withdrawAllAndDisable(
  requests: Pick<ApprovalRequest, 'id'>[],
  withdraw: (id: string) => Promise<boolean>,
  checkPending: () => Promise<unknown[]>,
  disable: () => Promise<void>,
) {
  for (const request of requests) {
    if (!await withdraw(request.id)) throw new Error('Could not withdraw all approval requests');
  }
  if ((await checkPending()).length) throw new Error('New approval requests arrived; review them before disabling');
  await disable();
}
