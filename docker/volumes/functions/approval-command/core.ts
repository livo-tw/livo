/** Shared wire validation. Authentication, visibility and atomic writes belong to the adapter/database. */
export type ApprovalOperation = 'submit' | 'approve' | 'reject' | 'return' | 'withdraw' | 'set_requirement';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'returned' | 'cancelled';
export interface ApprovalExpectedTask { statusId: string; requiresApproval: boolean; currentApprovalId: string | null; approvalStatus: string | null; }
export interface ApprovalStepSnapshot {
  step_order: number; approver_type: 'role' | 'user'; approver_role: string | null; approver_user_id: string | null;
  id?: string; rule_id?: string; allow_delegate?: boolean; timeout_hours?: number | null;
  timeout_action?: 'remind' | 'auto_approve' | 'escalate' | null; created_at?: string;
}
export interface ApprovalRequestState {
  id: string; task_id: string; rule_id: string | null; requested_by: string; from_status: string; to_status: string;
  current_step: number; status: ApprovalStatus; created_at: string; completed_at: string | null;
  version: number; steps_snapshot: ApprovalStepSnapshot[] | null; rule_snapshot?: Record<string, unknown> | null;
}
export interface ApprovalTaskState {
  id: string; status_id: string; requires_approval: boolean; approval_status: string | null; current_approval_id: string | null;
  started_at?: string | null; completed_at?: string | null;
}
export type ApprovalCommand =
  | { commandId: string; operation: 'submit'; taskId: string; expected: ApprovalExpectedTask; toStatusId: string; expectedRuleId: string | null; enableRequirement: boolean }
  | { commandId: string; operation: 'approve' | 'reject' | 'return'; requestId: string; expectedVersion: number; expectedStep: number; comment: string | null }
  | { commandId: string; operation: 'withdraw'; requestId: string; expectedVersion: number }
  | { commandId: string; operation: 'set_requirement'; taskId: string; expectedRequiresApproval: boolean; enabled: boolean };
export interface ApprovalCommandResult { commandId: string; replayed: boolean; eventId: string; request: ApprovalRequestState | null; task: ApprovalTaskState; }
export class ApprovalCommandError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); this.name = 'ApprovalCommandError'; }
}
const invalid = (): never => { throw new ApprovalCommandError('approval_invalid_input'); };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  return value as Record<string, unknown>;
};
function keys(value: Record<string, unknown>, allowed: string[], required = allowed) {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) invalid();
}
function id(value: unknown, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > 200 || value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) return invalid();
  return value;
}
const nullableId = (value: unknown) => value === null ? null : id(value);
const bool = (value: unknown): boolean => typeof value === 'boolean' ? value : invalid();
const positive = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : invalid();
export function parseApprovalCommand(input: unknown): ApprovalCommand {
  const v = object(input), commandId = id(v.commandId, 8);
  switch (v.operation) {
    case 'submit': {
      keys(v, ['commandId','operation','taskId','expected','toStatusId','expectedRuleId','enableRequirement']);
      const e = object(v.expected); keys(e, ['statusId','requiresApproval','currentApprovalId','approvalStatus']);
      const expected = {statusId:id(e.statusId),requiresApproval:bool(e.requiresApproval),currentApprovalId:nullableId(e.currentApprovalId),approvalStatus:nullableId(e.approvalStatus)};
      if (expected.approvalStatus !== null && expected.approvalStatus !== 'pending_approval') invalid();
      return {commandId,operation:'submit',taskId:id(v.taskId),expected,toStatusId:id(v.toStatusId),expectedRuleId:nullableId(v.expectedRuleId),enableRequirement:bool(v.enableRequirement)};
    }
    case 'approve': case 'reject': case 'return': {
      keys(v, ['commandId','operation','requestId','expectedVersion','expectedStep','comment'], ['commandId','operation','requestId','expectedVersion','expectedStep']);
      if (v.comment !== undefined && v.comment !== null && (typeof v.comment !== 'string' || [...v.comment].length > 4000 || /\u0000/u.test(v.comment))) invalid();
      const comment = typeof v.comment === 'string' ? v.comment.trim() || null : null;
      return {commandId,operation:v.operation,requestId:id(v.requestId),expectedVersion:positive(v.expectedVersion),expectedStep:positive(v.expectedStep),comment};
    }
    case 'withdraw':
      keys(v, ['commandId','operation','requestId','expectedVersion']);
      return {commandId,operation:'withdraw',requestId:id(v.requestId),expectedVersion:positive(v.expectedVersion)};
    case 'set_requirement':
      keys(v, ['commandId','operation','taskId','expectedRequiresApproval','enabled']);
      return {commandId,operation:'set_requirement',taskId:id(v.taskId),expectedRequiresApproval:bool(v.expectedRequiresApproval),enabled:bool(v.enabled)};
    default: return invalid();
  }
}
/** Parse first so aliases, omitted comments and key insertion order have one fingerprint. */
export function canonicalApprovalPayload(input: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => [key,canonical(item)])) : value;
  return JSON.stringify(canonical(parseApprovalCommand(input)));
}
/** Legacy rows without an immutable snapshot cannot be approved; withdrawal stays available. */
export function approvalSnapshotSteps(request: Pick<ApprovalRequestState,'steps_snapshot'>): ApprovalStepSnapshot[] | null {
  const steps = request.steps_snapshot;
  if (!Array.isArray(steps) || !steps.length || steps.length > 100 || steps.some(step => !step || typeof step !== 'object' || !Number.isSafeInteger(step.step_order))) return null;
  const sorted = [...steps].sort((a,b) => a.step_order - b.step_order);
  return sorted.every((step,index) => step && step.step_order === index + 1 &&
    (step.approver_type === 'role' ? ['member','admin','super_admin'].includes(step.approver_role ?? '') && step.approver_user_id === null
      : step.approver_type === 'user' && typeof step.approver_user_id === 'string' && !!step.approver_user_id && step.approver_role === null)) ? sorted : null;
}
export const APPROVAL_ADMIN_ROLES: readonly string[] = ['admin','super_admin'];
/** Product rule: whoever requested a change never decides it, whatever their role. The request waits for another approver or is withdrawn. */
export function canActOnApproval(request: Pick<ApprovalRequestState,'status'|'rule_id'|'current_step'|'steps_snapshot'|'requested_by'>, actor: {id:string;role:string;active?:boolean}): boolean {
  if (actor.active === false || request.status !== 'pending' || request.requested_by === actor.id) return false;
  const steps = approvalSnapshotSteps(request), step = steps?.find(s => s.step_order === request.current_step);
  if (!step) return false;
  if (request.rule_id === null) return request.current_step === 1 && APPROVAL_ADMIN_ROLES.includes(actor.role);
  return step.approver_type === 'user' ? step.approver_user_id === actor.id : step.approver_role === actor.role;
}
/** Anyone who may edit the task can require approval; only administrators may remove the requirement. */
export function canSetApprovalRequirement(enabled: boolean, actor: {role:string;active?:boolean}): boolean {
  return actor.active !== false && (enabled || APPROVAL_ADMIN_ROLES.includes(actor.role));
}
