export type ResponsibilityRole = 'assignee' | 'reviewer';
export type WorkList = 'checks' | 'todos';
type Base = { commandId: string; taskId: string };
export type TaskWorkCommand = Base & (
  | { operation: 'acknowledge'; role: ResponsibilityRole; expectedRevision: number }
  | { operation: 'create_subtask'; title: string; statusId: string; priority: string; assigneeId: string | null; reviewerId: string | null; dueDate: string | null }
  | { operation: 'add_item'; list: WorkList; text: string; isDone: boolean }
  | { operation: 'update_item'; list: WorkList; itemId: string; expectedVersion: number; text?: string; isDone?: boolean }
  | { operation: 'delete_item'; list: WorkList; itemId: string; expectedVersion: number }
  | { operation: 'add_dependency'; dependsOnTaskId: string }
  | { operation: 'remove_dependency'; dependencyId: string }
);
export type TaskWorkTask = {
  id: string; task_key: string; project_id: string; parent_task_id: string | null; title: string;
  status_id: string; priority: string; assignee_id: string | null; reviewer_id: string | null;
  assignee_revision: number; reviewer_revision: number;
  assignee_acknowledged_at: string | null; reviewer_acknowledged_at: string | null;
};
export type TaskWorkTaskState = TaskWorkTask;
export type TaskWorkResult = {
  commandId: string; replayed: boolean; eventId: string; task: TaskWorkTask;
  record: Record<string, unknown> | null; removedId?: string;
};
export class TaskWorkError extends Error {
  constructor(public code: string, public status = 400) { super(code); this.name = 'TaskWorkError'; }
}
const invalid = (): never => { throw new TaskWorkError('work_invalid_input'); };
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const id = (v: unknown): string => typeof v === 'string' && /^[\w-]{1,200}$/.test(v) ? v : invalid();
const revision = (v: unknown): number => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : invalid();
const text = (v: unknown, max: number): string => typeof v === 'string' && v.trim() && !v.includes('\0') && [...v.trim()].length <= max ? v.trim() : invalid();
export const workCalendarDate = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) return invalid();
  const date = new Date(v + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === v ? v : invalid();
};
const bool = (v: unknown): boolean => typeof v === 'boolean' ? v : invalid();

/** Reject extra fields, especially caller-supplied identity or workspace data. */
export function parseTaskWorkCommand(input: unknown): TaskWorkCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const p = input as Record<string, unknown>;
  const base = { commandId: id(p.commandId), taskId: id(p.taskId) };
  if (base.commandId.length < 8) invalid();
  let result: TaskWorkCommand;
  switch (p.operation) {
    case 'acknowledge':
      if (p.role !== 'assignee' && p.role !== 'reviewer') invalid();
      result = { ...base, operation: p.operation, role: p.role as ResponsibilityRole, expectedRevision: revision(p.expectedRevision) }; break;
    case 'create_subtask':
      if (!['highest','high','medium','low','lowest'].includes(String(p.priority))) invalid();
      result = { ...base, operation: p.operation, title: text(p.title, 500), statusId: id(p.statusId), priority: String(p.priority),
        assigneeId: p.assigneeId == null ? null : id(p.assigneeId), reviewerId: p.reviewerId == null ? null : id(p.reviewerId), dueDate: workCalendarDate(p.dueDate) }; break;
    case 'add_item': case 'update_item': case 'delete_item': {
      if (p.list !== 'checks' && p.list !== 'todos') invalid();
      const list = p.list as WorkList;
      if (p.operation === 'add_item') result = { ...base, operation: p.operation, list, text: text(p.text, 2000), isDone: own(p,'isDone') ? bool(p.isDone) : false };
      else if (p.operation === 'delete_item') result = { ...base, operation: p.operation, list, itemId: id(p.itemId), expectedVersion: revision(p.expectedVersion) };
      else {
        if (!own(p,'text') && !own(p,'isDone')) invalid();
        result = { ...base, operation: p.operation, list, itemId: id(p.itemId), expectedVersion: revision(p.expectedVersion),
          ...(own(p,'text') ? {text:text(p.text,2000)} : {}), ...(own(p,'isDone') ? {isDone:bool(p.isDone)} : {}) };
      }
      break;
    }
    case 'add_dependency': result = { ...base, operation: p.operation, dependsOnTaskId: id(p.dependsOnTaskId) }; break;
    case 'remove_dependency': result = { ...base, operation: p.operation, dependencyId: id(p.dependencyId) }; break;
    default: return invalid();
  }
  if (Object.keys(p).some(k => !own(result, k))) invalid();
  return result;
}
export function canonicalTaskWorkPayload(command: TaskWorkCommand): string {
  return JSON.stringify(Object.fromEntries(Object.entries(parseTaskWorkCommand(command)).sort(([a],[b]) => a.localeCompare(b))));
}
export const TASK_WORK_ERRORS: Record<string, number> = {
  work_invalid_input: 400, work_unauthorized: 401, work_forbidden: 403, work_unavailable: 404,
  work_conflict: 409, work_command_reused: 409, work_cycle: 409, work_invalid_parent: 409,
  work_member_unavailable: 409, work_required_fields: 400,
};
export function taskWorkError(error: unknown): TaskWorkError {
  if (error instanceof TaskWorkError) return error;
  const code = (error instanceof Error ? error.message : '').match(/\bwork_[a-z_]+\b/)?.[0];
  return code && own(TASK_WORK_ERRORS,code) ? new TaskWorkError(code,TASK_WORK_ERRORS[code]) : new TaskWorkError('work_unavailable',503);
}
