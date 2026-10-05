import type { Status, Task } from '@/types';
import i18n from '@/i18n';

export type MemberRole = 'super_admin' | 'admin' | 'member';

export interface Permissions {
  canDeleteProject: boolean;
  canEditProject: boolean;
  canManageStatuses: boolean;
  canDeleteTask: boolean;
  canManageMembers: boolean;
  canViewMemberList: boolean;
}

export function getPermissions(role: MemberRole): Permissions {
  switch (role) {
    case 'super_admin':
      return {
        canDeleteProject: true,
        canEditProject: true,
        canManageStatuses: true,
        canDeleteTask: true,
        canManageMembers: true,
        canViewMemberList: true,
      };
    case 'admin':
      return {
        canDeleteProject: false,
        canEditProject: true,
        canManageStatuses: true,
        canDeleteTask: true,
        canManageMembers: false,
        canViewMemberList: true,
      };
    case 'member':
      return {
        canDeleteProject: false,
        canEditProject: false,
        canManageStatuses: false,
        canDeleteTask: false,
        canManageMembers: false,
        canViewMemberList: false,
      };
  }
}

/**
 * A task nobody has picked up yet: never started, not completed and still in the
 * first open column (the lowest sort order among statuses that are not done).
 * The Docker policy (20261025_record_delete.sql) and the cloud query floor (db.ts)
 * use the same rule.
 */
export function isUntouchedTask(task: Pick<Task, 'statusId' | 'startedAt' | 'completedAt'>, statuses: Pick<Status, 'id' | 'sortOrder' | 'isDone'>[]): boolean {
  if (task.startedAt || task.completedAt) return false;
  const open = statuses.filter(status => !status.isDone);
  if (!open.length) return false;
  const first = Math.min(...open.map(status => status.sortOrder));
  return open.some(status => status.id === task.statusId && status.sortOrder === first);
}

/** Admins delete any task; anyone else only a task they created that nobody has picked up. */
export function canDeleteTaskRecord(task: Pick<Task, 'creatorId' | 'statusId' | 'startedAt' | 'completedAt'>, member: { id: string; role: string } | null | undefined, statuses: Pick<Status, 'id' | 'sortOrder' | 'isDone'>[]): boolean {
  if (!member) return false;
  if (member.role === 'admin' || member.role === 'super_admin') return true;
  return task.creatorId === member.id && isUntouchedTask(task, statuses);
}

export function getRoleLabel(role: MemberRole): string {
  switch (role) {
    case 'super_admin': return i18n.t('role.superAdmin');
    case 'admin': return i18n.t('role.admin');
    case 'member': return i18n.t('role.member');
  }
}

export function getRoleColor(role: MemberRole): string {
  switch (role) {
    case 'super_admin': return '#FF5630';
    case 'admin': return '#0065FF';
    case 'member': return '#6B778C';
  }
}
