import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { sendSlackNotify } from '@/lib/slackNotify';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { createNotification } from '../utils';
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
  updateTask: (updates: Partial<Task>) => void;
  setAllTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setSelectedTask: React.Dispatch<React.SetStateAction<Task | null>>;
  canTransitionTo: (taskId: string, newStatusId: string, statusLogs: StatusLog[]) => { allowed: boolean; missingStatusIds: string[] };
  triggerNotification: (task: Task, fromStatus: string, toStatus: string) => void;
  getRuleForTransition: (projectId: string, fromStatusId: string, toStatusId: string) => Promise<{ rule: { id: string } } | null>;
  requestApproval: (taskId: string, ruleId: string, fromStatusId: string, toStatusId: string, task: Task) => Promise<{ id: string } | null>;
}

export function useTaskStatusChange(params: UseTaskStatusChangeParams) {
  const {
    task, project, statuses, statusLogs, users,
    currentMemberId, currentMember, assignee,
    updateTask, setAllTasks, setSelectedTask,
    canTransitionTo, triggerNotification, getRuleForTransition, requestApproval,
  } = params;

  const [advisoryState, setAdvisoryState] = useState<{
    taskId: string; fromStatusId: string; toStatusId: string; toStatusName: string; ruleId: string;
  } | null>(null);

  const [approvalConfirmState, setApprovalConfirmState] = useState<{
    taskId: string; fromStatusId: string; toStatusId: string; toStatusName: string;
  } | null>(null);

  const handleStatusChange = async (newStatusId: string) => {
    try {
      if (!task) return;
      const result = canTransitionTo(task.id, newStatusId, statusLogs);
      if (!result.allowed) {
        const missingNames = result.missingStatusIds
          .map(id => statuses.find(s => s.id === id)?.name || id);
        const targetName = statuses.find(s => s.id === newStatusId)?.name || '—';
        toast.error(i18n.t('taskDetail.statusTransitionBlocked', { missingNames: missingNames.join(i18n.t('common.listSeparator', { defaultValue: '、' })), targetName }));
        return;
      }

      // When requiresApproval is true, ALL status changes go through approval
      if (task.requiresApproval) {
        const toStatusName = statuses.find(s => s.id === newStatusId)?.name || '—';
        setApprovalConfirmState({ taskId: task.id, fromStatusId: task.statusId, toStatusId: newStatusId, toStatusName });
        return;
      }

      // Advisory: if a matching approval rule exists but task doesn't require approval, show 3-button dialog
      if (!task.requiresApproval && project) {
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

      const s = statuses.find(st => st.id === newStatusId);
      const oldStatus = statuses.find(st => st.id === task.statusId);
      const updates: Partial<Task> = { statusId: newStatusId };
      if (s?.autoStart && !task.startedAt) updates.startedAt = new Date().toISOString().split('T')[0];
      if (s?.isDone && !oldStatus?.isDone) {
        updates.completedAt = new Date().toISOString();
      }
      if (!s?.isDone && oldStatus?.isDone) updates.completedAt = undefined;
      updateTask(updates);
      const statusMsg = i18n.t('taskDetail.statusChanged', { statusName: s?.name || '—' });
      if (task.assigneeId) createNotification(task.assigneeId, currentMemberId, 'status_changed', task.id, statusMsg);
      if (task.reviewerId) createNotification(task.reviewerId, currentMemberId, 'status_changed', task.id, statusMsg);
      sendSlackNotify({
        type: 'status_changed', taskKey: task.taskKey, taskTitle: task.title, taskId: task.id,
        projectName: project?.name, actorName: currentMember?.name || i18n.t('common.unknown'),
        fromStatus: oldStatus?.name || '—', toStatus: s?.name || '—',
        assigneeName: assignee?.name, priority: task.priority,
      }).catch(err => console.error('[LIVO] sendSlackNotify error:', err));
      try {
        triggerNotification(task, oldStatus?.name || '—', s?.name || '—');
      } catch (err) {
        console.error('[LIVO] triggerNotification error:', err);
      }
    } catch (err) {
      console.error('[LIVO] handleStatusChange error:', err);
      toast.error(i18n.t('error.updateFailed') + String(err));
    }
  };

  const handleAdvisoryDirectChange = async () => {
    if (!advisoryState || !task) return;
    const { toStatusId } = advisoryState;
    setAdvisoryState(null);
    const s = statuses.find(st => st.id === toStatusId);
    const oldStatus = statuses.find(st => st.id === task.statusId);
    const updates: Partial<Task> = { statusId: toStatusId };
    if (s?.autoStart && !task.startedAt) updates.startedAt = new Date().toISOString().split('T')[0];
    if (s?.isDone && !oldStatus?.isDone) updates.completedAt = new Date().toISOString();
    if (!s?.isDone && oldStatus?.isDone) updates.completedAt = undefined;
    updateTask(updates);
  };

  const handleAdvisorySubmitApproval = async () => {
    if (!advisoryState || !task) return;
    const { fromStatusId, toStatusId, ruleId } = advisoryState;
    setAdvisoryState(null);
    await supabase.from('tasks').update({ requires_approval: true }).eq('id', task.id);
    setAllTasks(prev => prev.map(t => t.id === task.id ? { ...t, requiresApproval: true } : t));
    const req = await requestApproval(task.id, ruleId, fromStatusId, toStatusId, task);
    if (req) {
      setAllTasks(prev => prev.map(t => t.id === task.id ? { ...t, requiresApproval: true, approvalStatus: 'pending_approval', currentApprovalId: req.id } : t));
      setSelectedTask({ ...task, requiresApproval: true, approvalStatus: 'pending_approval', currentApprovalId: req.id });
      toast.success(i18n.t('approval.requestSent'));
    }
  };

  const handleApprovalConfirm = async () => {
    if (!approvalConfirmState || !task) return;
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
