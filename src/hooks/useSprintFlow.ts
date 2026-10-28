import { useCallback, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSprintContext, type PendingTaskAction } from '@/context/SprintContext';
import { useAuthContext } from '@/context/AuthContext';
import { logActivity } from '@/lib/activityLog';

/**
 * Completing and starting a sprint, the same on the board, the backlog and the
 * stand-up. Choosing "move unfinished tasks to the next sprint" opens the start
 * dialog straight away with those tasks; they stay chosen until a sprint starts
 * or the dialog is cancelled (they are already back in the backlog then).
 */
export function useSprintFlow({ startAfterComplete = 'next-sprint', onStarted, onStartClosed }: {
  /** 'always' opens the start dialog after every completion (the stand-up's flow). */
  startAfterComplete?: 'always' | 'next-sprint';
  onStarted?: () => void;
  /** After the start dialog closes without starting. */
  onStartClosed?: () => void;
} = {}) {
  const { t } = useTranslation();
  const { currentSprint, completeSprint, startSprint, commandState } = useSprintContext();
  const { currentMemberId } = useAuthContext();
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [showStartModal, setShowStartModal] = useState(false);
  const [carryOverTaskIds, setCarryOverTaskIds] = useState<string[]>([]);
  const [skippedCarryCount, setSkippedCarryCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const complete = useCallback(async (action: PendingTaskAction) => {
    if (submittingRef.current) return false;
    submittingRef.current = true;
    setSubmitting(true);
    try {
    const sprintName = currentSprint?.name || '';
    const result = await completeSprint(action);
    if (!result) return false;
    setShowCompleteModal(false);
    const carry = action === 'next-sprint' ? result.carryIds ?? result.pendingIds : [];
    setSkippedCarryCount(action === 'next-sprint' ? result.pendingIds.length - carry.length : 0);
    setCarryOverTaskIds(carry);
    if (startAfterComplete === 'always' || action === 'next-sprint') setShowStartModal(true);
    if (currentMemberId) void Promise.resolve().then(() => logActivity(currentMemberId, 'complete_sprint', `${t('activityLog.completeSprint')}「${sprintName}」`, undefined, undefined, 'sprint')).catch(() => console.warn('[LIVO] Sprint activity log unavailable'));
    return true;
    } finally { submittingRef.current = false; setSubmitting(false); }
  }, [completeSprint, currentMemberId, currentSprint, startAfterComplete, t]);

  const confirmStart = useCallback(async (name: string, includeBacklog: boolean) => {
    if (submittingRef.current) return false;
    submittingRef.current = true;
    setSubmitting(true);
    try {
    const started = await startSprint(name, carryOverTaskIds.length > 0 ? carryOverTaskIds : undefined, includeBacklog);
    if (!started) return false;
    setShowStartModal(false);
    setCarryOverTaskIds([]);
    setSkippedCarryCount(0);
    if (currentMemberId) void Promise.resolve().then(() => logActivity(currentMemberId, 'start_sprint', `${t('activityLog.startSprint')}「${name}」`, undefined, undefined, 'sprint')).catch(() => console.warn('[LIVO] Sprint activity log unavailable'));
    onStarted?.();
    return started;
    } finally { submittingRef.current = false; setSubmitting(false); }
  }, [carryOverTaskIds, currentMemberId, onStarted, onStartClosed, startSprint, t]);

  const busy = submitting || !!commandState?.busy;
  const retryOnly = !!commandState?.unresolved;
  const cancelStart = useCallback(() => { if (busy || retryOnly) return; setShowStartModal(false); setCarryOverTaskIds([]); setSkippedCarryCount(0); onStartClosed?.(); }, [onStartClosed, busy, retryOnly]);

  return {
    showCompleteModal, openComplete: useCallback(() => setShowCompleteModal(true), []), closeComplete: useCallback(() => { if (!busy && !retryOnly) setShowCompleteModal(false); }, [busy, retryOnly]), complete,
    showStartModal, openStart: useCallback(() => setShowStartModal(true), []), cancelStart, confirmStart,
    carryOverTaskIds, skippedCarryCount, busy, retryOnly,
  };
}
