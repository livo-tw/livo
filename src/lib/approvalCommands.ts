import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import type { Task } from '@/types';
import { randomUUID } from '@/lib/generateId';
import { ApprovalCommandError, canonicalApprovalPayload, parseApprovalCommand } from './approval/core';
import type { ApprovalCommand, ApprovalCommandResult, ApprovalTaskState } from './approval/core';
export type { ApprovalCommand, ApprovalCommandResult } from './approval/core';
type DB = Pick<SupabaseClient<Database>, 'functions'>;
type WithoutId<T> = T extends unknown ? Omit<T, 'commandId'> : never;
export type ApprovalIntent = WithoutId<ApprovalCommand>;
export function approvalTaskPatch(row: ApprovalTaskState): Partial<Task> {
  return {statusId:row.status_id,requiresApproval:row.requires_approval,approvalStatus:row.approval_status ?? undefined,
    currentApprovalId:row.current_approval_id ?? undefined,
    ...('started_at' in row ? {startedAt:row.started_at ?? undefined} : {}),
    ...('completed_at' in row ? {completedAt:row.completed_at ?? undefined} : {})};
}

const errorCode = (value: unknown): string | null => {
  const code = typeof value === 'string' ? value : value && typeof value === 'object'
    ? (value as {code?:unknown;message?:unknown}).code ?? (value as {message?:unknown}).message : null;
  return typeof code === 'string' && /^approval_[a-z_]+$/.test(code) ? code : null;
};
export async function executeApprovalCommand(db: DB, input: ApprovalCommand): Promise<ApprovalCommandResult> {
  const command = parseApprovalCommand(input);
  for (let attempt=0; attempt<2; attempt++) {
    try {
      const {data,error} = await db.functions.invoke('approval-command', {body:command});
      let code = errorCode(data?.error) || errorCode(error);
      if (!code && error && 'context' in error && error.context instanceof Response) {
        const detail = await error.context.clone().json().catch((): null => null);
        code = errorCode(detail?.error);
      }
      if (code === 'approval_unavailable') throw new Error('transport');
      if (code) throw new ApprovalCommandError(code, code.includes('conflict') ? 409 : 400);
      if (error) throw new Error('transport');
      if (!data || data.commandId !== command.commandId || !data.task || typeof data.task.id !== 'string' ||
        typeof data.task.status_id !== 'string' || typeof data.task.requires_approval !== 'boolean' ||
        !('request' in data) || typeof data.replayed !== 'boolean' || typeof data.eventId !== 'string') {
        throw new Error('invalid_response');
      }
      if ('taskId' in command && data.task.id !== command.taskId) throw new Error('invalid_response');
      if (command.operation !== 'set_requirement' && (!data.request || data.request.task_id !== data.task.id ||
        !Number.isSafeInteger(data.request.version) || data.request.version < 1 ||
        ('requestId' in command && data.request.id !== command.requestId))) throw new Error('invalid_response');
      return data as ApprovalCommandResult;
    } catch (error) {
      if (error instanceof ApprovalCommandError) throw error;
      if (attempt === 1) throw new ApprovalCommandError('approval_transport_error',503);
    }
  }
  throw new ApprovalCommandError('approval_transport_error',503);
}
/** Keep the same command ID after an uncertain network outcome; no actor details enter the payload. */
export function createApprovalCommandRunner(db: DB) {
  const pending = new Map<string, ApprovalCommand>();
  const flights = new Map<string, Promise<ApprovalCommandResult>>();
  return (intent: ApprovalIntent): Promise<ApprovalCommandResult> => {
    const key = canonicalApprovalPayload({...intent,commandId:'pending-intent'});
    const inFlight = flights.get(key); if (inFlight) return inFlight;
    const command = pending.get(key) ?? parseApprovalCommand({...intent,commandId:randomUUID()});
    pending.set(key,command);
    const flight = executeApprovalCommand(db,command).then(result => {pending.delete(key);return result;}, error => {
      if (error instanceof ApprovalCommandError && error.code !== 'approval_transport_error') pending.delete(key);
      throw error;
    }).finally(() => flights.delete(key));
    flights.set(key,flight); return flight;
  };
}
