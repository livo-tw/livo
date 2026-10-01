import { describe, expect, it } from 'vitest';
import { canManageFeatureToggles, isEventEnabled, isNotificationVariableEnabled, resolveApprovalView, resolveFeatureToggles } from '@/lib/featureToggles';

describe('team feature defaults', () => {
  it.each([
    [undefined, false, false, false],
    [null, true, false, true],
    [{}, false, true, true],
    [{}, true, true, true],
    [{ approvals: true }, false, false, true],
    [{ approvals: false }, true, true, false],
    [{ approvals: 'false' }, true, false, true],
    [{ approvals: 1 }, false, false, false],
  ])('resolves %j with rules=%s requests=%s to %s', (value, hasApprovalRules, hasApprovalRequests, expected) => {
    expect(resolveFeatureToggles(value, { hasApprovalRules, hasApprovalRequests }).approvals).toBe(expected);
  });
  it.each(['admin', 'super_admin'])('allows %s to manage switches', role => {
    expect(canManageFeatureToggles(role)).toBe(true);
  });
  it.each(['member', undefined, 'owner'])('does not allow %s to manage switches', role => {
    expect(canManageFeatureToggles(role)).toBe(false);
  });
  it('falls back to the board only for a disabled approvals view', () => {
    expect(resolveApprovalView('approvals', false)).toBe('board');
    expect(resolveApprovalView('approvals', true)).toBe('approvals');
    expect(resolveApprovalView('my-tasks', false)).toBe('my-tasks');
  });
  it('hides approval events without suppressing unrelated notifications', () => {
    for (const event of ['approval_requested', 'approval_completed', 'approval_approve', 'approval_cancelled']) {
      expect(isEventEnabled(event, false)).toBe(false);
      expect(isEventEnabled(event, true)).toBe(true);
    }
    expect(isEventEnabled('status_changed', false)).toBe(true);
  });
  it('hides approval-specific template variables while keeping task variables', () => {
    expect(isNotificationVariableEnabled('approver_name', false)).toBe(false);
    expect(isNotificationVariableEnabled('requester_name', false)).toBe(false);
    expect(isNotificationVariableEnabled('approver', true)).toBe(true);
    expect(isNotificationVariableEnabled('assignee', false)).toBe(true);
  });
});
