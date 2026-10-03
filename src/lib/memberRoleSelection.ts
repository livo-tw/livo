import i18n from '@/i18n';
import { getRoleColor, getRoleLabel, type MemberRole } from './permissions';

/** QA administration is a scoped capability, not a new global database role. */
export type MemberRoleSelection = MemberRole | 'qa_admin';
export const MEMBER_ROLE_OPTIONS: MemberRoleSelection[] = ['super_admin', 'admin', 'qa_admin', 'member'];
type RoleMember = { role: string; qaAdmin?: boolean };

export const selectedMemberRole = (member: RoleMember): MemberRoleSelection =>
  member.role === 'member' && member.qaAdmin ? 'qa_admin' : member.role as MemberRole;
export const selectionRoleLabel = (role: MemberRoleSelection): string =>
  role === 'qa_admin' ? i18n.t('role.qaAdmin') : getRoleLabel(role);
export const getMemberRoleLabel = (member: RoleMember): string => selectionRoleLabel(selectedMemberRole(member));
export const getMemberRoleColor = (member: RoleMember): string =>
  selectedMemberRole(member) === 'qa_admin' ? '#7C3AED' : getRoleColor(member.role as MemberRole);
