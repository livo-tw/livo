import { useCallback, useState } from 'react';
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
  const { currentSprint, completeSprint, startSprint } = useSprintContext();
  const { currentMemberId } = useAuthContext();
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [showStartModal, setShowStartModal] = useState(false);
  const [carryOverTaskIds, setCarryOverTaskIds] = useState<string[]>([]);

  const complete = useCallback(async (action: PendingTaskAction) => {
    setShowCompleteModal(false);
    const sprintName = currentSprint?.name || '';
    const result = await completeSprint(action);
    if (!result) return false;
    if (currentMemberId) await logActivity(currentMemberId, 'complete_sprint', `${t('activityLog.completeSprint')}「${sprintName}」`, undefined, undefined, 'sprint');
    const carry = action === 'next-sprint' ? result.pendingIds : [];
    setCarryOverTaskIds(carry);
    if (startAfterComplete === 'always' || action === 'next-sprint') setShowStartModal(true);
    return true;
  }, [completeSprint, currentMemberId, currentSprint, startAfterComplete, t]);

  const confirmStart = useCallback(async (name: string, includeBacklog: boolean) => {
    setShowStartModal(false);
    const started = await startSprint(name, carryOverTaskIds.length > 0 ? carryOverTaskIds : undefined, includeBacklog);
    setCarryOverTaskIds([]);
    if (started && currentMemberId) await logActivity(currentMemberId, 'start_sprint', `${t('activityLog.startSprint')}「${name}」`, undefined, undefined, 'sprint');
    if (started) onStarted?.(); else onStartClosed?.();
    return started;
  }, [carryOverTaskIds, currentMemberId, onStarted, onStartClosed, startSprint, t]);

  const cancelStart = useCallback(() => { setShowStartModal(false); setCarryOverTaskIds([]); onStartClosed?.(); }, [onStartClosed]);

  return {
    showCompleteModal, openComplete: useCallback(() => setShowCompleteModal(true), []), closeComplete: useCallback(() => setShowCompleteModal(false), []), complete,
    showStartModal, openStart: useCallback(() => setShowStartModal(true), []), cancelStart, confirmStart,
    carryOverTaskIds,
  };
}
