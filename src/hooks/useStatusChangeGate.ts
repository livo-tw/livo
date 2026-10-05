import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIContext } from '@/context/UIContext';
import { useTaskContext } from '@/context/TaskContext';
import { useStatusTransitionRules } from '@/hooks/useStatusTransitionRules';
import { checkStatusChange, type StatusChangeCheck } from '@/lib/taskStatusChange';
import type { Task } from '@/types';

/** The one status-change check every entry uses: board, card menu, detail, sub-tasks and bulk edits. */
export function useStatusChangeGate() {
  const { t } = useTranslation();
  const { approvalsEnabled } = useUIContext();
  const { statusLogs, statuses } = useTaskContext();
  const { rules } = useStatusTransitionRules();
  const check = useCallback((task: Task, toStatusId: string) =>
    checkStatusChange({ task, toStatusId, approvalsEnabled, rules, statusLogs }), [approvalsEnabled, rules, statusLogs]);
  /** Why the change cannot be made here, or null when it can (directly or by approval). */
  const refusal = useCallback((result: StatusChangeCheck, toStatusId: string): string | null => {
    if (result.kind === 'pending') return t('error.approvalPending');
    if (result.kind !== 'blocked') return null;
    const name = (id: string) => statuses.find(status => status.id === id)?.name || id;
    return t('board.transitionNotAllowed', { missingNames: result.missingStatusIds.map(name).join(t('common.listSeparator', { defaultValue: '、' })), targetName: name(toStatusId) });
  }, [statuses, t]);
  return { check, refusal };
}
