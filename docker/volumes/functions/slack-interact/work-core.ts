export type ResponsibilityRole = 'assignee' | 'reviewer';
export type WorkList = 'checks' | 'todos';
export const TASK_WORK_MAX_BODY_BYTES = 1024 * 1024;
export type TaskWorkCustomValue = {
  fieldId: string; valueText?: string | null; valueNumber?: number | null;
  valueDate?: string | null; valueBoolean?: boolean | null; valueUserId?: string | null;
};
export type TaskWorkSubtaskDetails = {
  background?: string; requirement?: string; notes?: string; startDate?: string | null; gitlabUrl?: string | null;
  checks?: string[]; todos?: string[]; tagIds?: string[];
  deployments?: { environment: string; status: 'scheduled' | 'deployed'; deployDate?: string | null }[];
  customFields?: TaskWorkCustomValue[];
};

type Base = { commandId: string; taskId: string };
export type TaskWorkCommand = Base & (
  | { operation: 'acknowledge'; role: ResponsibilityRole; expectedRevision: number }
  | { operation: 'create_subtask'; title: string; statusId: string; priority: string; assigneeId: string | null; reviewerId: string | null; dueDate: string | null; details?: TaskWorkSubtaskDetails }
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

const plainText = (v: unknown, max: number): string => typeof v === 'string' && !v.includes('\0') && [...v].length <= max ? v : invalid();
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : invalid();
const array = <T>(v: unknown, parse: (item: unknown) => T): T[] => Array.isArray(v) && v.length <= 100 ? v.map(parse) : invalid();
const unique = <T>(values: T[], key: (value: T) => string): T[] => new Set(values.map(key)).size === values.length ? values : invalid();
const supplied = (value: Record<string, unknown>, key: string) => own(value, key) && value[key] !== undefined;
function subtaskDetails(input: unknown): TaskWorkSubtaskDetails {
  const p = object(input), result: TaskWorkSubtaskDetails = {};
  const keys = new Set(['background','requirement','notes','startDate','gitlabUrl','checks','todos','tagIds','deployments','customFields']);
  if (Object.keys(p).some(key => !keys.has(key))) invalid();
  for (const key of ['background','requirement','notes'] as const) if (supplied(p,key)) result[key] = plainText(p[key],50000);
  if (supplied(p,'startDate')) result.startDate = workCalendarDate(p.startDate);
  if (supplied(p,'gitlabUrl')) result.gitlabUrl = p.gitlabUrl === null ? null : plainText(p.gitlabUrl,2000);
  for (const key of ['checks','todos'] as const) if (supplied(p,key)) result[key] = array(p[key],value => text(value,2000));
  if (supplied(p,'tagIds')) result.tagIds = unique(array(p.tagIds,id),value => value);
  if (supplied(p,'deployments')) result.deployments = unique(array(p.deployments,value => {
    const item = object(value);
    if (Object.keys(item).some(key => !['environment','status','deployDate'].includes(key)) || !['scheduled','deployed'].includes(String(item.status))) invalid();
    return { environment:text(item.environment,100),status:item.status as 'scheduled' | 'deployed',
      ...(supplied(item,'deployDate') ? {deployDate:workCalendarDate(item.deployDate)} : {}) };
  }),value => value.environment);
  if (supplied(p,'customFields')) result.customFields = unique(array(p.customFields,value => {
    const item=object(value), out:TaskWorkCustomValue={fieldId:id(item.fieldId)};
    if (Object.keys(item).some(key => !['fieldId','valueText','valueNumber','valueDate','valueBoolean','valueUserId'].includes(key))) invalid();
    if (supplied(item,'valueText')) out.valueText=item.valueText === null ? null : plainText(item.valueText,10000);
    if (supplied(item,'valueNumber')) out.valueNumber=item.valueNumber === null ? null : typeof item.valueNumber==='number' && Number.isFinite(item.valueNumber) ? item.valueNumber : invalid();
    if (supplied(item,'valueDate')) out.valueDate=workCalendarDate(item.valueDate);
    if (supplied(item,'valueBoolean')) out.valueBoolean=item.valueBoolean === null ? null : typeof item.valueBoolean==='boolean' ? item.valueBoolean : invalid();
    if (supplied(item,'valueUserId')) out.valueUserId=item.valueUserId === null || item.valueUserId === '' ? null : id(item.valueUserId);
    return out;
  }),value => value.fieldId);
  return result;
}

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
        assigneeId: p.assigneeId == null ? null : id(p.assigneeId), reviewerId: p.reviewerId == null ? null : id(p.reviewerId), dueDate: workCalendarDate(p.dueDate),
        ...(supplied(p,'details') ? { details: subtaskDetails(p.details) } : {}) }; break;
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
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > TASK_WORK_MAX_BODY_BYTES) invalid();
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
