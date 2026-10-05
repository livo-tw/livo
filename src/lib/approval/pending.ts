import type { ApprovalRequest } from '@/lib/approvalQueries';
import { approvalSnapshotSteps, canActOnApproval } from '@/lib/approval/core';

/**
 * The pending requests a member has something to do with: a step they can
 * approve, or an old request without steps that its requester or an admin settles.
 * The top-bar count and the pending list both use this, so they always agree.
 */
export function actionableApprovals(pending: ApprovalRequest[], member: { id: string | null | undefined; role?: string | null; isActive?: boolean }): ApprovalRequest[] {
  if (!member.id) return [];
  const role = member.role ?? '';
  const admin = ['admin', 'super_admin'].includes(role);
  return pending.filter(request => canActOnApproval(request, { id: member.id!, role, active: member.isActive })
    || (!approvalSnapshotSteps(request) && (request.requested_by === member.id || admin)));
}
