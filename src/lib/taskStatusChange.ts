import type { Status, StatusLog, Task } from '@/types';

export interface StatusTransitionRule {
  id: string;
  targetStatusId: string;
  requiredStatusId: string;
  createdAt: string;
}

/** Statuses a task must have passed through before it may enter the target status. */
export function missingRequiredStatuses(rules: readonly StatusTransitionRule[], taskId: string, targetStatusId: string, statusLogs: readonly StatusLog[]): string[] {
  const required = rules.filter(rule => rule.targetStatusId === targetStatusId);
  if (!required.length) return [];
  const visited = new Set(statusLogs.filter(log => log.taskId === taskId).map(log => log.toStatusId));
  return required.filter(rule => !visited.has(rule.requiredStatusId)).map(rule => rule.requiredStatusId);
}

/**
 * What a status change needs, decided the same way on the board, the card's
 * quick menu, the detail view, sub-tasks and bulk edits:
 * - pending: an approval is in progress, the server keeps the status as is;
 * - blocked: a transition rule names statuses the task has not been through;
 * - approval: the task requires approval, so the change is submitted instead;
 * - direct: it can be saved now.
 */
export type StatusChangeCheck =
  | { kind: 'same' }
  | { kind: 'pending' }
  | { kind: 'blocked'; missingStatusIds: string[] }
  | { kind: 'approval' }
  | { kind: 'direct' };

export function checkStatusChange({ task, toStatusId, approvalsEnabled, rules, statusLogs }: {
  task: Pick<Task, 'id' | 'statusId' | 'requiresApproval' | 'approvalStatus' | 'currentApprovalId'>;
  toStatusId: string;
  approvalsEnabled: boolean;
  rules: readonly StatusTransitionRule[];
  statusLogs: readonly StatusLog[];
}): StatusChangeCheck {
  if (task.statusId === toStatusId) return { kind: 'same' };
  if (approvalsEnabled && (task.approvalStatus === 'pending_approval' || !!task.currentApprovalId)) return { kind: 'pending' };
  const missingStatusIds = missingRequiredStatuses(rules, task.id, toStatusId, statusLogs);
  if (missingStatusIds.length) return { kind: 'blocked', missingStatusIds };
  if (approvalsEnabled && task.requiresApproval) return { kind: 'approval' };
  return { kind: 'direct' };
}

type StatusFlags = Pick<Status, 'id'> & Partial<Pick<Status, 'isDone' | 'autoStart'>>;

/** The fields one status change writes: the status, the start date and the completion time. */
export function statusChangeUpdates(task: Pick<Task, 'statusId' | 'startedAt'>, statuses: readonly StatusFlags[], toStatusId: string, now = new Date()): Partial<Task> {
  const target = statuses.find(status => status.id === toStatusId);
  const current = statuses.find(status => status.id === task.statusId);
  const updates: Partial<Task> = { statusId: toStatusId };
  if (target?.autoStart && !task.startedAt) updates.startedAt = now.toISOString().split('T')[0];
  if (target?.isDone && !current?.isDone) updates.completedAt = now.toISOString();
  if (!target?.isDone && current?.isDone) updates.completedAt = undefined;
  return updates;
}
