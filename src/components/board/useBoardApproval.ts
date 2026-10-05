import { useState, useEffect, useCallback } from 'react';
import { useUIContext } from '@/context/UIContext';
import { toast } from 'sonner';
import type { Task } from '@/types';
import { statusChangeUpdates } from '@/lib/taskStatusChange';
import type { ApprovalConfirmPayload } from '@/components/board/BoardApprovalModal';

interface UseBoardApprovalDeps {
  allTasks: Task[];
  statuses: { id: string; name?: string; color?: string; autoStart?: boolean; isDone?: boolean }[];
  setAllTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  updateTaskInDb: (taskId: string, updates: Record<string, unknown>) => Promise<boolean | void>;
  getRuleForTransition: (projectId: string, fromStatusId: string, toStatusId: string) => Promise<{ rule: { id: string } } | null>;
  requestApproval: (taskId: string, ruleId: string, fromStatusId: string, toStatusId: string, task: Task, enableRequirement?: boolean) => Promise<import('@/lib/approvalQueries').ApprovalRequest | null>;
  t: (key: string, options?: Record<string, unknown>) => string;
  /** Tells others about a saved direct change (lib/taskAnnouncements). */
  announce?: (task: Task, fromStatusId: string, toStatusId: string) => void;
}

export function useBoardApproval({
  allTasks,
  statuses,
  setAllTasks,
  updateTaskInDb,
  getRuleForTransition,
  requestApproval,
  t,
  announce,
}: UseBoardApprovalDeps) {
  const { approvalsEnabled, featureTogglesReady } = useUIContext();
  useEffect(() => { if (!approvalsEnabled) setApprovalConfirm(null); }, [approvalsEnabled]);
  const [approvalConfirm, setApprovalConfirm] = useState<ApprovalConfirmPayload | null>(null);

  // Escape key handler for approval modal
  useEffect(() => {
    if (!approvalConfirm) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setApprovalConfirm(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [approvalConfirm]);

  const handleApprovalDirectChange = useCallback(async (payload: ApprovalConfirmPayload) => {
    try {
      const { taskId, toStatusId } = payload;
      setApprovalConfirm(null);
      const task = allTasks.find(t2 => t2.id === taskId);
      if (!task) return;
      const updates = statusChangeUpdates(task, statuses, toStatusId);
      setAllTasks(prev => prev.map(t2 => t2.id !== taskId ? t2 : { ...t2, ...updates }));
      if ((await updateTaskInDb(taskId, updates)) === false) return;
      announce?.(task, task.statusId, toStatusId);
    } catch (err) {
      console.error('[LIVO] advisory direct change error:', err);
      toast.error(t('error.updateFailed') + String(err));
    }
  }, [allTasks, statuses, setAllTasks, updateTaskInDb, t, announce]);

  const handleApprovalSubmit = useCallback(async (payload: ApprovalConfirmPayload) => {
    if (!approvalsEnabled || !featureTogglesReady) return;
    try {
      const { taskId, fromStatusId, toStatusId, projectId } = payload;
      setApprovalConfirm(null);
      const task = allTasks.find(t2 => t2.id === taskId);
      if (!task) return;
      const ruleResult = projectId ? await getRuleForTransition(projectId, fromStatusId, toStatusId) : null;
      const ruleId = ruleResult?.rule?.id ?? null;
      const result = await requestApproval(taskId, ruleId as string, fromStatusId, toStatusId, task, true);
      if (result) {
        setAllTasks(prev => prev.map(card => card.id === taskId ? {...card,requiresApproval:true,approvalStatus:'pending_approval',currentApprovalId:result.id} : card));
        toast.success(t('approval.requested'));
      }
    } catch (err) {
      console.error('[LIVO] advisory submit approval error:', err);
      toast.error(t('error.updateFailed') + String(err));
    }
  }, [approvalsEnabled, featureTogglesReady, allTasks, setAllTasks, getRuleForTransition, requestApproval, t]);

  const handleMandatoryApproval = useCallback(async (payload: ApprovalConfirmPayload) => {
    if (!approvalsEnabled || !featureTogglesReady) return;
    try {
      const { taskId, fromStatusId, toStatusId, projectId } = payload;
      setApprovalConfirm(null);
      const ruleResult = projectId ? await getRuleForTransition(projectId, fromStatusId, toStatusId) : null;
      const ruleId = ruleResult?.rule?.id ?? null;
      const task = allTasks.find(t2 => t2.id === taskId);
      if (!task) return;
      const result = await requestApproval(taskId, ruleId as string, fromStatusId, toStatusId, task);
      if (result) {
        setAllTasks(prev => prev.map(card => card.id === taskId ? {...card,approvalStatus:'pending_approval',currentApprovalId:result.id} : card));
        toast.success(t('approval.requested'));
      }
    } catch (err) {
      console.error('[LIVO] approval submit error:', err);
      toast.error(t('error.updateFailed') + String(err));
    }
  }, [approvalsEnabled, featureTogglesReady, allTasks, getRuleForTransition, requestApproval, t]);

  return {
    approvalConfirm,
    setApprovalConfirm,
    handleApprovalDirectChange,
    handleApprovalSubmit,
    handleMandatoryApproval,
  };
}
