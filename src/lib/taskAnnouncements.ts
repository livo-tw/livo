import i18n from 'i18next';
import { sendSlackNotify } from '@/lib/slackNotify';
import { createNotification } from '@/components/task-detail/utils';
import type { Project, Status, Task, User } from '@/types';

/**
 * What others hear about a saved task change, the same from every entry point
 * (board drag, card quick edit, task detail, subtasks, an approval's direct
 * change, bulk edits). Call these only after the change was saved, so nobody is
 * told about a change that was refused.
 */
export interface TaskAnnouncementContext {
  actor: User | null | undefined;
  users: User[];
  projects: Project[];
  statuses: Status[];
  /** The on-screen notification rules (NotificationToastProvider). */
  showRules?: (task: Task, fromStatus: string, toStatus: string) => void;
}

/** A status change: the assignee and reviewer in their inbox, Slack, and the notification rules. */
export function announceStatusChange(task: Task, fromStatusId: string, toStatusId: string, ctx: TaskAnnouncementContext): void {
  const from = ctx.statuses.find(status => status.id === fromStatusId)?.name || '—';
  const to = ctx.statuses.find(status => status.id === toStatusId)?.name || '—';
  if (ctx.actor?.id) {
    const message = i18n.t('taskDetail.statusChanged', { statusName: to });
    for (const recipient of new Set([task.assigneeId, task.reviewerId])) if (recipient) void createNotification(recipient, ctx.actor.id, 'status_changed', task.id, message);
  }
  sendSlackNotify({
    type: 'status_changed', taskKey: task.taskKey, taskTitle: task.title, taskId: task.id,
    projectName: ctx.projects.find(project => project.id === task.projectId)?.name, actorName: ctx.actor?.name || i18n.t('common.unknown'),
    fromStatus: from, toStatus: to, assigneeName: ctx.users.find(user => user.id === task.assigneeId)?.name, priority: task.priority,
  }).catch(error => console.error('[LIVO] sendSlackNotify error:', error));
  try { ctx.showRules?.(task, from, to); } catch (error) { console.error('[LIVO] triggerNotification error:', error); }
}

/**
 * A new assignee: an inbox notification, and a Slack notice with a direct message
 * to them. Bulk edits pass slack: false so one action does not flood the channel.
 */
export function announceAssignment(task: Task, assigneeId: string | null | undefined, ctx: TaskAnnouncementContext, { slack = true }: { slack?: boolean } = {}): void {
  if (!assigneeId || assigneeId === task.assigneeId || !ctx.actor?.id) return;
  void createNotification(assigneeId, ctx.actor.id, 'assign', task.id, task.title);
  if (!slack) return;
  const previous = ctx.users.find(user => user.id === task.assigneeId), next = ctx.users.find(user => user.id === assigneeId);
  sendSlackNotify({
    type: 'assignee_changed', taskKey: task.taskKey, taskTitle: task.title, taskId: task.id,
    projectName: ctx.projects.find(project => project.id === task.projectId)?.name, actorName: ctx.actor.name || i18n.t('common.unknown'),
    oldAssignee: previous?.name || i18n.t('common.unassigned'), newAssignee: next?.name || i18n.t('common.unassigned'),
    statusName: ctx.statuses.find(status => status.id === task.statusId)?.name, priority: task.priority,
    dmTargets: next && next.id !== ctx.actor.id && next.email ? [{ email: next.email, name: next.name, reason: i18n.t('taskDetail.assignedAsAssignee') }] : [],
  }).catch(error => console.error('[LIVO] sendSlackNotify error:', error));
}
