import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import type { Task } from '@/types';
import { randomUUID } from '@/lib/generateId';
import { TaskWorkError, canonicalTaskWorkPayload, parseTaskWorkCommand } from './core';
import type { TaskWorkCommand, TaskWorkResult } from './core';

type DB = Pick<SupabaseClient<Database>, 'functions'>;
type WithoutId<T> = T extends unknown ? Omit<T, 'commandId'> : never;
export type TaskWorkIntent = WithoutId<TaskWorkCommand>;
export type ResponsibilityRole = 'assignee' | 'reviewer';
export type TaskResponsibility = {
  id: string; assignee_id: string | null; reviewer_id: string | null;
  assignee_revision: number; reviewer_revision: number;
  assignee_acknowledged_at: string | null; reviewer_acknowledged_at: string | null;
};
export type TaskWorkItem = { id: string; task_id: string; text: string; is_done: boolean; sort_order: number; version: number };
export function taskWorkItem(value: unknown, taskId: string): TaskWorkItem {
  if (!value || typeof value !== 'object') throw new TaskWorkError('work_unavailable');
  const row = value as TaskWorkItem;
  if (typeof row.id !== 'string' || !row.id || row.task_id !== taskId || typeof row.text !== 'string' ||
    typeof row.is_done !== 'boolean' || !Number.isFinite(row.sort_order) || !Number.isSafeInteger(row.version) || row.version < 0) throw new TaskWorkError('work_unavailable');
  return row;
}
export async function getTaskWorkItems(db: Pick<SupabaseClient<Database>, 'from'>, list: 'checks' | 'todos', taskId: string): Promise<TaskWorkItem[]> {
  const rows: TaskWorkItem[] = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await db.from(list === 'checks' ? 'task_checks' : 'task_todos').select('*').eq('task_id', taskId).order('sort_order').order('id').range(start, start + 499);
    if (error) throw new TaskWorkError(taskWorkErrorCode(error));
    if (!Array.isArray(data)) throw new TaskWorkError('work_unavailable');
    rows.push(...data.map(row => taskWorkItem(row, taskId)));
    if (data.length < 500) return rows;
  }
}
const codes = new Set(['work_invalid_input', 'work_unauthorized', 'work_forbidden', 'work_unavailable',
  'work_conflict', 'work_command_reused', 'work_cycle', 'work_invalid_parent', 'work_member_unavailable', 'work_required_fields', 'work_transport_error']);
export function taskWorkErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown };
    if (typeof value.code === 'string' && codes.has(value.code)) return value.code;
    if (typeof value.message === 'string' && codes.has(value.message)) return value.message;
  }
  return typeof error === 'string' && codes.has(error) ? error : 'work_unavailable';
}
function responsibilityRow(value: unknown, taskId: string): TaskResponsibility {
  if (!value || typeof value !== 'object') throw new TaskWorkError('work_unavailable');
  const row = value as TaskResponsibility;
  if (row.id !== taskId || ![row.assignee_id, row.reviewer_id].every(id => id === null || (typeof id === 'string' && id.length > 0)) ||
    ![row.assignee_revision, row.reviewer_revision].every(version => Number.isSafeInteger(version) && version >= 0) ||
    ![row.assignee_acknowledged_at, row.reviewer_acknowledged_at].every(at => at === null || (typeof at === 'string' && Number.isFinite(Date.parse(at))))) {
    throw new TaskWorkError('work_unavailable');
  }
  return row;
}
export async function getTaskResponsibility(db: Pick<SupabaseClient<Database>, 'from'>, taskId: string): Promise<TaskResponsibility> {
  const { data, error } = await db.from('tasks').select('id,assignee_id,reviewer_id,assignee_revision,reviewer_revision,assignee_acknowledged_at,reviewer_acknowledged_at').eq('id', taskId).limit(1);
  if (error) throw new TaskWorkError(taskWorkErrorCode(error));
  return responsibilityRow(data?.[0], taskId);
}
export function responsibilityTaskPatch(row: TaskResponsibility, current?: Task): Partial<Task> {
  const patch: Partial<Task> = {};
  if (!current || (current.assigneeRevision ?? 0) < row.assignee_revision || ((current.assigneeRevision ?? 0) === row.assignee_revision && (current.assigneeId || null) === row.assignee_id)) {
    patch.assigneeId = row.assignee_id || undefined;
    patch.assigneeRevision = row.assignee_revision;
    patch.assigneeAcknowledgedAt = row.assignee_acknowledged_at || undefined;
  }
  if (!current || (current.reviewerRevision ?? 0) < row.reviewer_revision || ((current.reviewerRevision ?? 0) === row.reviewer_revision && (current.reviewerId || null) === row.reviewer_id)) {
    patch.reviewerId = row.reviewer_id || undefined;
    patch.reviewerRevision = row.reviewer_revision;
    patch.reviewerAcknowledgedAt = row.reviewer_acknowledged_at || undefined;
  }
  return patch;
}
export async function executeTaskWorkCommand(db: DB, input: TaskWorkCommand): Promise<TaskWorkResult> {
  const command = parseTaskWorkCommand(input);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await db.functions.invoke('task-work-command', { body: command });
      let code = data?.error ? taskWorkErrorCode(data.error) : error ? taskWorkErrorCode(error) : null;
      if ((!code || code === 'work_unavailable') && error && 'context' in error && error.context instanceof Response) {
        const detail = await error.context.clone().json().catch((): null => null);
        if (detail?.error) code = taskWorkErrorCode(detail.error);
      }
      if (code === 'work_unavailable' || code === 'work_transport_error') throw new Error('transport');
      if (code) throw new TaskWorkError(code);
      if (error) throw new Error('transport');
      if (!data || data.commandId !== command.commandId || typeof data.replayed !== 'boolean' ||
        typeof data.eventId !== 'string' || !data.eventId || !('record' in data)) throw new Error('invalid_response');
      try { responsibilityRow(data.task, command.taskId); } catch { throw new Error('invalid_response'); }
      if (command.operation === 'acknowledge' && !data.replayed) {
        const role = command.role;
        if (data.task[`${role}_revision`] !== command.expectedRevision || !data.task[`${role}_acknowledged_at`]) throw new Error('invalid_response');
      }
      if (command.operation === 'add_item' || command.operation === 'update_item') {
        let item: TaskWorkItem;
        try { item = taskWorkItem(data.record, command.taskId); } catch { throw new Error('invalid_response'); }
        if (command.operation === 'update_item' && (item.id !== command.itemId || item.version <= command.expectedVersion)) throw new Error('invalid_response');
      }
      if (command.operation === 'delete_item' && data.removedId !== command.itemId) throw new Error('invalid_response');
      if (command.operation === 'remove_dependency' && data.removedId !== command.dependencyId) throw new Error('invalid_response');
      if (command.operation === 'add_dependency' && (!data.record || typeof data.record.id !== 'string' ||
        data.record.task_id !== command.taskId || data.record.depends_on_task_id !== command.dependsOnTaskId)) throw new Error('invalid_response');
      if (command.operation === 'create_subtask' && (!data.record || typeof data.record.id !== 'string' || data.record.id === command.taskId ||
        data.record.parent_task_id !== command.taskId || typeof data.record.task_key !== 'string' || !data.record.task_key)) throw new Error('invalid_response');
      return data as TaskWorkResult;
    } catch (error) {
      if (error instanceof TaskWorkError) throw error;
      if (attempt === 1) throw new TaskWorkError('work_transport_error', 503);
    }
  }
  throw new TaskWorkError('work_transport_error', 503);
}
/** Reuse the same command after an uncertain result and coalesce double clicks. */
export function createTaskWorkCommandRunner(db: DB) {
  const pending = new Map<string, TaskWorkCommand>();
  const flights = new Map<string, Promise<TaskWorkResult>>();
  return (intent: TaskWorkIntent): Promise<TaskWorkResult> => {
    const key = canonicalTaskWorkPayload({ ...intent, commandId: '00000000-0000-4000-8000-000000000001' });
    const inFlight = flights.get(key);
    if (inFlight) return inFlight;
    const command = pending.get(key) ?? parseTaskWorkCommand({ ...intent, commandId: randomUUID() });
    pending.set(key, command);
    const flight = executeTaskWorkCommand(db, command).then(result => { pending.delete(key); return result; }, error => {
      if (taskWorkErrorCode(error) !== 'work_transport_error') pending.delete(key);
      throw error;
    }).finally(() => flights.delete(key));
    flights.set(key, flight);
    return flight;
  };
}
