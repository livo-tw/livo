import { useState, useEffect } from 'react';
import { useUIContext } from '@/context/UIContext';
import { announceStatusChange } from '@/lib/taskAnnouncements';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { statusChangeUpdates } from '@/lib/taskStatusChange';
import type { Task, Status, StatusLog, User, Project } from '@/types';

export interface UseTaskStatusChangeParams {
  task: Task | null;
  project: Project | null;
  statuses: Status[];
  statusLogs: StatusLog[];
  users: User[];
  currentMemberId: string | undefined;
  currentMember: User | null | undefined;
  assignee: User | undefined;
  /** Resolves false when the save was refused or failed. */
  updateTask: (updates: Partial<Task>) => Promise<boolean> | void;
  setAllTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setSelectedTask: React.Dispatch<React.SetStateAction<Task | null>>;
  canTransitionTo: (taskId: string, newStatusId: string, statusLogs: StatusLog[]) => { allowed: boolean; missingStatusIds: string[] };
  triggerNotification: (task: Task, fromStatus: string, toStatus: string) => void;
  getRuleForTransition: (projectId: string, fromStatusId: string, toStatusId: string) => Promise<{ rule: { id: string } } | null>;
  requestApproval: (taskId: string, ruleId: string, fromStatusId: string, toStatusId: string, task: Task, enableRequirement?: boolean) => Promise<{ id: string } | null>;
}

export function useTaskStatusChange(params: UseTaskStatusChangeParams) {
  const { approvalsEnabled, featureTogglesReady } = useUIContext();
  const {
    task, project, statuses, statusLogs, users,
    currentMember,
    updateTask, setAllTasks, setSelectedTask,
    canTransitionTo, triggerNotification, getRuleForTransition, requestApproval,
  } = params;

  const [advisoryState, setAdvisoryState] = useState<{
    taskId: string; fromStatusId: string; toStatusId: string; toStatusName: string; ruleId: string;
  } | null>(null);

  const [approvalConfirmState, setApprovalConfirmState] = useState<{
    taskId: string; fromStatusId: string; toStatusId: string; toStatusName: string;
  } | null>(null);

  useEffect(() => {
    if (!approvalsEnabled) { setAdvisoryState(null); setApprovalConfirmState(null); }
  }, [approvalsEnabled]);

  // Others hear about the change only once it is saved (see lib/taskAnnouncements).
  const changeAndAnnounce = async (current: Task, newStatusId: string) => {
    const saved = await updateTask(statusChangeUpdates(current, statuses, newStatusId));
    if (saved === false) return;
    announceStatusChange(current, current.statusId, newStatusId, { actor: currentMember, users, projects: project ? [project] : [], statuses, showRules: triggerNotification });
  };

  const handleStatusChange = async (newStatusId: string) => {
    if (!featureTogglesReady) { toast.error(i18n.t('featureToggles.loadFailed')); return; }
    try {
      if (!task) return;
      // The server keeps the status while an approval is in progress.
      if (approvalsEnabled && (task.approvalStatus === 'pending_approval' || task.currentApprovalId)) {
        toast.error(i18n.t('error.approvalPending'));
        return;
      }
      const result = canTransitionTo(task.id, newStatusId, statusLogs);
      if (!result.allowed) {
        const missingNames = result.missingStatusIds
          .map(id => statuses.find(s => s.id === id)?.name || id);
        const targetName = statuses.find(s => s.id === newStatusId)?.name || '—';
        toast.error(i18n.t('taskDetail.statusTransitionBlocked', { missingNames: missingNames.join(i18n.t('common.listSeparator', { defaultValue: '、' })), targetName }));
        return;
      }

      // When requiresApproval is true, ALL status changes go through approval
      if (approvalsEnabled && task.requiresApproval) {
        const toStatusName = statuses.find(s => s.id === newStatusId)?.name || '—';
        setApprovalConfirmState({ taskId: task.id, fromStatusId: task.statusId, toStatusId: newStatusId, toStatusName });
        return;
      }

      // Advisory: if a matching approval rule exists but task doesn't require approval, show 3-button dialog
      if (approvalsEnabled && !task.requiresApproval && project) {
        try {
          const ruleInfo = await getRuleForTransition(project.id, task.statusId, newStatusId);
          if (ruleInfo) {
            const toStatusName = statuses.find(s => s.id === newStatusId)?.name || '—';
            setAdvisoryState({ taskId: task.id, fromStatusId: task.statusId, toStatusId: newStatusId, toStatusName, ruleId: ruleInfo.rule.id });
            return;
          }
        } catch (err) {
          console.error('[LIVO] advisory approval check error:', err);
        }
      }

      await changeAndAnnounce(task, newStatusId);
    } catch (err) {
      console.error('[LIVO] handleStatusChange error:', err);
      toast.error(i18n.t('error.updateFailed') + String(err));
    }
  };

  const handleAdvisoryDirectChange = async () => {
    if (!advisoryState || !task) return;
    const { toStatusId } = advisoryState;
    setAdvisoryState(null);
    await changeAndAnnounce(task, toStatusId);
  };

  const handleAdvisorySubmitApproval = async () => {
    if (!approvalsEnabled || !featureTogglesReady || !advisoryState || !task) return;
    const { fromStatusId, toStatusId, ruleId } = advisoryState;
    setAdvisoryState(null);
    const req = await requestApproval(task.id, ruleId, fromStatusId, toStatusId, task, true);
    if (req) {
      setAllTasks(prev => prev.map(t => t.id === task.id ? { ...t, requiresApproval: true, approvalStatus: 'pending_approval', currentApprovalId: req.id } : t));
      setSelectedTask({ ...task, requiresApproval: true, approvalStatus: 'pending_approval', currentApprovalId: req.id });
      toast.success(i18n.t('approval.requestSent'));
    }
  };

  const handleApprovalConfirm = async () => {
    if (!approvalsEnabled || !featureTogglesReady || !approvalConfirmState || !task) return;
    const { fromStatusId, toStatusId } = approvalConfirmState;
    setApprovalConfirmState(null);
    try {
      const ruleInfo = project ? await getRuleForTransition(project.id, fromStatusId, toStatusId) : null;
      const ruleId = ruleInfo?.rule?.id ?? null;
      const req = await requestApproval(task.id, ruleId as string, fromStatusId, toStatusId, task);
      if (req) {
        setAllTasks(prev => prev.map(t => t.id === task.id ? { ...t, approvalStatus: 'pending_approval', currentApprovalId: req.id } : t));
        setSelectedTask({ ...task, approvalStatus: 'pending_approval', currentApprovalId: req.id });
        toast.success(i18n.t('approval.requestSent'));
      }
    } catch (err) {
      console.error('[LIVO] approval submit error:', err);
      toast.error(i18n.t('error.updateFailed') + String(err));
    }
  };

  return {
    advisoryState, setAdvisoryState,
    approvalConfirmState, setApprovalConfirmState,
    handleStatusChange,
    handleAdvisoryDirectChange,
    handleAdvisorySubmitApproval,
    handleApprovalConfirm,
  };
}
