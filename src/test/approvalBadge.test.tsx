import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@/lib/approvalQueries';

const mocks = vi.hoisted(() => ({ pending: vi.fn(), member: { id: 'approver', role: 'member', isActive: true } as { id: string; role: string; isActive: boolean } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/approvalQueries', () => ({ requestQueries: { fetchPending: mocks.pending } }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: mocks.member.id, currentMember: mocks.member }) }));
import { actionableApprovals } from '@/lib/approval/pending';
import { useActionableApprovalCount } from '@/hooks/useActionableApprovalCount';

const step = (approver: string) => [{ step_order: 1, approver_type: 'user', approver_user_id: approver, approver_role: null as string | null }];
const request = (id: string, more: Partial<ApprovalRequest>) => ({ id, status: 'pending', rule_id: 'rule', current_step: 1, requested_by: 'requester', steps_snapshot: step('approver'), ...more }) as unknown as ApprovalRequest;
const pending = [
  request('mine', {}),
  request('someone-else', { steps_snapshot: step('other') as never }),
  request('my-own-request', { requested_by: 'approver' }),
  request('legacy-mine', { steps_snapshot: null as never, requested_by: 'approver' }),
];

beforeEach(() => { vi.clearAllMocks(); mocks.member = { id: 'approver', role: 'member', isActive: true }; });

describe('pending approvals a member can act on', () => {
  it('counts the step assigned to them and their own old request without steps, not other people\'s', () => {
    expect(actionableApprovals(pending, mocks.member).map(r => r.id)).toEqual(['mine', 'legacy-mine']);
    expect(actionableApprovals(pending, { ...mocks.member, isActive: false }).map(r => r.id)).toEqual(['legacy-mine']);
    expect(actionableApprovals(pending, { id: null })).toEqual([]);
  });

  it('the top-bar badge uses the same rule and shows nothing when the read fails', async () => {
    mocks.pending.mockResolvedValueOnce({ data: pending, error: null });
    const { result, rerender } = renderHook(({ key }) => useActionableApprovalCount(true, key), { initialProps: { key: 'a' } });
    await waitFor(() => expect(result.current).toBe(2));
    mocks.pending.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });
    rerender({ key: 'b' });
    await waitFor(() => expect(result.current).toBeNull());
    expect(mocks.pending).toHaveBeenCalledTimes(2);
  });

  it('does not read anything when approvals are off', () => {
    const { result } = renderHook(() => useActionableApprovalCount(false, 'a'));
    expect(result.current).toBeNull();
    expect(mocks.pending).not.toHaveBeenCalled();
  });
});
