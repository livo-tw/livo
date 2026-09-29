import { User } from '@/types';
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
