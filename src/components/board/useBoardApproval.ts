import { useState, useEffect, useCallback } from 'react';
import { useUIContext } from '@/context/UIContext';
import { toast } from 'sonner';
import type { Task } from '@/types';
import type { ApprovalConfirmPayload } from '@/components/board/BoardApprovalModal';

interface UseBoardApprovalDeps {
  allTasks: Task[];
  statuses: { id: string; name?: string; color?: string; autoStart?: boolean; isDone?: boolean }[];
  setAllTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  updateTaskInDb: (taskId: string, updates: Record<string, unknown>) => Promise<boolean | void>;
  getRuleForTransition: (projectId: string, fromStatusId: string, toStatusId: string) => Promise<{ rule: { id: string } } | null>;
  requestApproval: (taskId: string, ruleId: string, fromStatusId: string, toStatusId: string, task: Task, enableRequirement?: boolean) => Promise<import('@/lib/approvalQueries').ApprovalRequest | null>;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function useBoardApproval({
  allTasks,
  statuses,
  setAllTasks,
  updateTaskInDb,
  getRuleForTransition,
  requestApproval,
  t,
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
      const { taskId, fromStatusId, toStatusId } = payload;
      setApprovalConfirm(null);
      const task = allTasks.find(t2 => t2.id === taskId);
      if (!task) return;
      const status = statuses.find(s => s.id === toStatusId);
      const oldStatus = statuses.find(s => s.id === fromStatusId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updates: Record<string, any> = { statusId: toStatusId };
      if (status?.autoStart && !task.startedAt) updates.startedAt = new Date().toISOString().split('T')[0];
      if (status?.isDone && !oldStatus?.isDone) updates.completedAt = new Date().toISOString();
      if (!status?.isDone && oldStatus?.isDone) updates.completedAt = undefined;
      setAllTasks(prev => prev.map(t2 => t2.id !== taskId ? t2 : { ...t2, ...updates }));
      await updateTaskInDb(taskId, updates);
    } catch (err) {
      console.error('[LIVO] advisory direct change error:', err);
      toast.error(t('error.updateFailed') + String(err));
    }
  }, [allTasks, statuses, setAllTasks, updateTaskInDb, t]);

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
