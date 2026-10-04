import i18n from '@/i18n';
import {ApprovalCommandError} from './core';
export function approvalErrorText(error: unknown): string {
  const code = error instanceof ApprovalCommandError ? error.code : 'approval_transport_error';
  const key = ({approval_conflict:'conflict',approval_idempotency_conflict:'conflict',approval_legacy_request:'legacy',
    approval_command_reused:'conflict',approval_rule_changed:'conflict',approval_pending:'conflict',
    approval_legacy_snapshot:'legacy',approval_invalid_steps:'legacy',approval_snapshot_required:'legacy',approval_rule_invalid:'legacy',approval_forbidden:'forbidden',approval_disabled:'disabled',
    approval_rule_in_use:'ruleInUse',approval_unavailable:'unavailable',approval_invalid_input:'invalid',
    approval_transition_prerequisite:'prerequisite',approval_self_decision_forbidden:'selfDecision',
    approval_requirement_admin_only:'requirementAdminOnly'} as Record<string,string>)[code] ?? 'failed';
  return i18n.t('approvalCommand.' + key);
}
/** A task write refused by the database; a pending approval gets its own text, not the raw code. */
export function taskWriteErrorText(message: string): string {
  return message === 'approval_pending' ? i18n.t('error.approvalPending') : i18n.t('error.updateFailed') + message;
}
