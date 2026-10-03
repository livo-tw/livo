import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { fromTable } from './supabaseQuery';
import type { ApprovalRequest } from './approvalQueries';
import { createApprovalCommandRunner } from './approvalCommands';
import type { ApprovalCommandResult } from './approval/core';
import { ApprovalCommandError } from './approval/core';
/** Authorization, cleanup and activity commit together on the server. */
export async function withdrawApproval(db:SupabaseClient<Database>,requestId:string,run=createApprovalCommandRunner(db)):Promise<ApprovalCommandResult> {
  const {data,error} = await fromTable(db,'approval_requests').select('*').eq('id',requestId).single();
  if (error) throw error;
  const request = data as ApprovalRequest|null;
  if (!request) throw new ApprovalCommandError('approval_unavailable',404);
  return await run({operation:'withdraw',requestId,expectedVersion:request.version});
}
/** Do not persist OFF until every withdrawal and the final live check succeed. */
export async function withdrawAllAndDisable(requests:Pick<ApprovalRequest,'id'>[],withdraw:(id:string)=>Promise<boolean>,
  checkPending:()=>Promise<unknown[]>,disable:()=>Promise<void>) {
  for (const request of requests) if (!await withdraw(request.id)) throw new Error('Could not withdraw all approval requests');
  if ((await checkPending()).length) throw new Error('New approval requests arrived; review them before disabling');
  await disable();
}
