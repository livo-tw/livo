import { useState, useCallback } from 'react';
import { useApprovalRealtime } from './useApprovalRealtime';
import { supabase } from '@/integrations/supabase/client';
import { fromTable } from '@/lib/supabaseQuery';
import { toast } from 'sonner';
import {
  requestQueries,
  actionQueries,
  stepQueries,
  taskApprovalQueries,
  type ApprovalRequest,
  type ApprovalAction,
  type ApprovalRuleStep,
} from '@/lib/approvalQueries';
import { useAuthContext } from '@/context/AuthContext';
import { useMemberContext } from '@/context/MemberContext';
import { sendSlackApprovalRequest, sendSlackApprovalCompleted } from '@/lib/slackNotify';
import { createNotification } from '@/components/task-detail/utils';
import { logActivity } from '@/lib/activityLog';
import type { Task } from '@/types';
import { mapTask } from '@/context/mappers';
import i18n from '@/i18n';

export interface ApprovalProgress {
  requestedBy: string;
  requestStatus: ApprovalRequest['status'];
  currentStep: number;
  totalSteps: number;
  steps: Array<{
    stepOrder: number;
    approverType: 'role' | 'user';
    approverRole: string | null;
    approverUserId: string | null;
    status: 'approved' | 'rejected' | 'returned' | 'pending' | 'waiting';
    comment: string | null;
    actedAt: string | null;
    actionBy: string | null;
  }>;
}

export const useApprovalWorkflow = () => {
  const { currentMemberId, currentMember } = useAuthContext();
  const { users } = useMemberContext();
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(false);

  const requestApproval = useCallback(async (
    taskId: string,
    ruleId: string | null,
    fromStatus: string,
    toStatus: string,
    task?: Task,
  ): Promise<ApprovalRequest | null> => {
    const { data, error } = await requestQueries.create(supabase, {
      task_id: taskId,
      rule_id: ruleId,
      requested_by: currentMemberId,
      from_status: fromStatus,
      to_status: toStatus,
      current_step: 1,
      status: 'pending',
    });
    if (error) {
      toast.error(i18n.t('approval.requestFailed', { error: (error as { message: string }).message }));
      return null;
    }
    const req = data as ApprovalRequest;
    // Mark task as pending_approval
    await taskApprovalQueries.setPendingApproval(supabase, taskId, req.id);

    // Activity log
    logActivity(currentMemberId, 'approval_requested', i18n.t('activityLog.approvalRequested', { taskTitle: task?.title ?? taskId }), taskId, undefined, 'task');

    // Notify approvers (in-app + Slack)
    if (task) {
      const taskTitle = task.title;
      const notifContent = i18n.t('approval.notifyRequested', { taskTitle });

      if (ruleId) {
        const { data: stepsData } = await stepQueries.fetchByRule(supabase, ruleId);
        const steps = (stepsData as ApprovalRuleStep[]) ?? [];
        // Notify first step approver(s)
        const firstStep = steps.find(s => s.step_order === 1);
        if (firstStep) {
          if (firstStep.approver_type === 'user' && firstStep.approver_user_id) {
            createNotification(firstStep.approver_user_id, currentMemberId, 'approval_requested', taskId, notifContent);
          } else if (firstStep.approver_type === 'role' && firstStep.approver_role) {
            // Notify all users with the matching role
            const roleUsers = users.filter(u => u.isActive && u.role === firstStep.approver_role);
            roleUsers.forEach(u => createNotification(u.id, currentMemberId, 'approval_requested', taskId, notifContent));
          }
        }
        try {
          await sendSlackApprovalRequest(task, req, steps);
        } catch (e) {
          console.error('[LIVO] Slack 簽核請求通知失敗:', e);
        }
      } else {
        // No rule — notify all admins/super_admins
        const admins = users.filter(u => u.isActive && (u.role === 'admin' || u.role === 'super_admin'));
        admins.forEach(u => createNotification(u.id, currentMemberId, 'approval_requested', taskId, notifContent));
      }
    }

    return req;
  }, [currentMemberId, users]);

  const performAction = useCallback(async (
    requestId: string,
    action: 'approve' | 'reject' | 'return',
    comment?: string,
    task?: Task,
  ): Promise<{ ok: boolean; approvedToStatus?: string; taskId?: string }> => {
    // Fetch current request
    const { data: reqData } = await fromTable(supabase, 'approval_requests')
      .select('*')
      .eq('id', requestId)
      .single();
    if (!reqData) { toast.error(i18n.t('approval.noRule')); return { ok: false }; }
    const req = reqData as ApprovalRequest;

    // Resolve task for Slack notification
    let resolvedTask = task;
    if (!resolvedTask) {
      const { data: taskRow } = await supabase.from('tasks').select('*').eq('id', req.task_id).single();
      if (taskRow) resolvedTask = mapTask(taskRow);
    }

    // Frontend permission check: verify caller is the approver for the current step
    // When no rule exists (rule_id is null), allow super_admin or admin to approve
    if (!req.rule_id) {
      const isAdmin = currentMember?.role === 'super_admin' || currentMember?.role === 'admin';
      if (!isAdmin) {
        toast.error(i18n.t('approval.notAuthorized'));
        return { ok: false };
      }
    } else {
      const { data: stepData } = await stepQueries.fetchByRule(supabase, req.rule_id);
      const steps = (stepData as ApprovalRuleStep[]) ?? [];
      const currentStep = steps.find(s => s.step_order === req.current_step);
      if (!currentStep) { toast.error(i18n.t('approval.stepNotFound')); return { ok: false }; }

      const isAuthorized =
        (currentStep.approver_type === 'role' && currentMember?.role === currentStep.approver_role) ||
        (currentStep.approver_type === 'user' && currentStep.approver_user_id === currentMemberId);

      if (!isAuthorized) {
        toast.error(i18n.t('approval.notAuthorized'));
        return { ok: false };
      }
    }

    // Record the action
    const { error: actionErr } = await actionQueries.create(supabase, {
      request_id: requestId,
      step_order: req.current_step,
      action_by: currentMemberId,
      action,
      comment: comment || null,
    });
    if (actionErr) {
      toast.error(i18n.t('approval.actionFailed', { error: (actionErr as { message: string }).message }));
      return { ok: false };
    }

    if (action === 'reject' || action === 'return') {
      const finalStatus = action === 'reject' ? 'rejected' : 'returned';
      await requestQueries.updateStatus(supabase, requestId, finalStatus, new Date().toISOString());
      await taskApprovalQueries.clearApprovalStatus(supabase, req.task_id);
      toast.success(action === 'reject' ? i18n.t('approval.rejectedSuccess') : i18n.t('approval.returnedSuccess'));
      setPendingApprovals(prev => prev.filter(p => p.id !== requestId));

      // Activity log
      const actionType = action === 'reject' ? 'approval_rejected' : 'approval_returned';
      logActivity(currentMemberId, actionType, i18n.t(`activityLog.${actionType}`, { taskTitle: resolvedTask?.title ?? req.task_id }), req.task_id, undefined, 'task');

      // Notify requester (in-app)
      const actionLabel = action === 'reject' ? i18n.t('approval.statusRejected') : i18n.t('approval.statusReturned');
      const taskTitle = resolvedTask?.title ?? req.task_id;
      createNotification(req.requested_by, currentMemberId, 'approval_completed', req.task_id,
        i18n.t('approval.notifyCompleted', { taskTitle, result: actionLabel }));

      // Notify Slack on rejection/return
      if (resolvedTask) {
        const actorName = currentMember?.name ?? currentMemberId;
        try {
          await sendSlackApprovalCompleted(resolvedTask, action, { actorName, comment });
        } catch (e) {
          console.error('[LIVO] Slack 簽核完成通知失敗:', e);
        }
      }

      return { ok: true };
    }

    // approve: check if there are more steps
    const allSteps: ApprovalRuleStep[] = [];
    if (req.rule_id) {
      const { data: stepsData } = await stepQueries.fetchByRule(supabase, req.rule_id);
      allSteps.push(...((stepsData as ApprovalRuleStep[]) ?? []));
    }
    const nextStep = req.current_step + 1;

    if (nextStep > allSteps.length) {
      // All steps approved — apply the status change with side effects
      await requestQueries.updateStatus(supabase, requestId, 'approved', new Date().toISOString());
      // Compute startedAt / completedAt side effects
      const extra: { started_at?: string; completed_at?: string | null } = {};
      const { data: statusRow } = await supabase.from('statuses').select('auto_start, is_done').eq('id', req.to_status).single();
      if (statusRow) {
        if (statusRow.auto_start && resolvedTask && !resolvedTask.startedAt) {
          extra.started_at = new Date().toISOString().split('T')[0];
        }
        const { data: oldStatusRow } = await supabase.from('statuses').select('is_done').eq('id', req.from_status).single();
        if (statusRow.is_done && !oldStatusRow?.is_done) {
          extra.completed_at = new Date().toISOString();
        } else if (!statusRow.is_done && oldStatusRow?.is_done) {
          extra.completed_at = null;
        }
      }
      await taskApprovalQueries.applyStatusChange(supabase, req.task_id, req.to_status, Object.keys(extra).length > 0 ? extra : undefined);
      toast.success(i18n.t('approval.approvalCompleted'));

      // Activity log
      logActivity(currentMemberId, 'approval_approved', i18n.t('activityLog.approval_approved', { taskTitle: resolvedTask?.title ?? req.task_id }), req.task_id, undefined, 'task');

      // Notify requester (in-app) — approval completed
      const taskTitle = resolvedTask?.title ?? req.task_id;
      createNotification(req.requested_by, currentMemberId, 'approval_completed', req.task_id,
        i18n.t('approval.notifyCompleted', { taskTitle, result: i18n.t('approval.statusApproved') }));

      // Notify Slack on final approval
      if (resolvedTask) {
        const actorName = currentMember?.name ?? currentMemberId;
        try {
          await sendSlackApprovalCompleted(resolvedTask, 'approve', { actorName, comment });
        } catch (e) {
          console.error('[LIVO] Slack 簽核完成通知失敗:', e);
        }
      }

      setPendingApprovals(prev => prev.filter(p => p.id !== requestId));
      return { ok: true, approvedToStatus: req.to_status, taskId: req.task_id };
    } else {
      // Advance to next step — optimistic lock: only update if current_step hasn't changed
      const { data: updatedReq } = await fromTable(supabase, 'approval_requests')
        .update({ current_step: nextStep })
        .eq('id', requestId)
        .eq('current_step', req.current_step)  // optimistic lock
        .select()
        .single();

      if (!updatedReq) {
        toast.error(i18n.t('approval.approvalConflict'));
        return { ok: false };
      }
      toast.success(i18n.t('approval.stepApproved', { current: req.current_step, next: nextStep }));
    }

    setPendingApprovals(prev => prev.filter(p => p.id !== requestId));
    return { ok: true };
  }, [currentMemberId, currentMember]);

  const cancelApproval = useCallback(async (requestId: string): Promise<boolean> => {
    const { data: reqData } = await fromTable(supabase, 'approval_requests')
      .select('*')
      .eq('id', requestId)
      .single();
    if (!reqData) { toast.error(i18n.t('approval.requestNotFound')); return false; }
    const req = reqData as ApprovalRequest;

    if (req.requested_by !== currentMemberId) {
      toast.error(i18n.t('approval.cancelNotAllowed'));
      return false;
    }

    await fromTable(supabase, 'approval_requests')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', requestId)
      .eq('requested_by', currentMemberId); // DB-level guard: only cancel own requests
    await taskApprovalQueries.clearApprovalStatus(supabase, req.task_id);

    toast.success(i18n.t('approval.approvalCancelled'));
    setPendingApprovals(prev => prev.filter(p => p.id !== requestId));

    // Activity log
    logActivity(currentMemberId, 'approval_cancelled', i18n.t('activityLog.approval_cancelled', { taskId: req.task_id }), req.task_id, undefined, 'task');

    return true;
  }, [currentMemberId]);

  const fetchPendingApprovals = useCallback(async (): Promise<void> => {
    setLoading(true);
    const { data, error } = await requestQueries.fetchPending(supabase);
    if (!error) {
      const allPending = (data as ApprovalRequest[]) ?? [];

      if (allPending.length > 0) {
        // Batch-fetch all steps for all unique rule_ids in one query
        const uniqueRuleIds = [...new Set(allPending.map(req => req.rule_id).filter((id): id is string => id !== null))];
        let allSteps: ApprovalRuleStep[] = [];
        if (uniqueRuleIds.length > 0) {
          const { data: allStepsData } = await fromTable(supabase, 'approval_rule_steps')
            .select('*')
            .in('rule_id', uniqueRuleIds);
          allSteps = (allStepsData as ApprovalRuleStep[]) ?? [];
        }

        // Group steps by rule_id in memory
        const stepsByRuleId = new Map<string, ApprovalRuleStep[]>();
        for (const step of allSteps) {
          const existing = stepsByRuleId.get(step.rule_id);
          if (existing) {
            existing.push(step);
          } else {
            stepsByRuleId.set(step.rule_id, [step]);
          }
        }

        // Filter to only requests where currentMemberId is the approver for the current step
        // For requests without a rule (rule_id is null), allow super_admin/admin
        const myPending = allPending.filter(req => {
          if (!req.rule_id) {
            return currentMember?.role === 'super_admin' || currentMember?.role === 'admin';
          }
          const steps = stepsByRuleId.get(req.rule_id) ?? [];
          const stepInfo = steps.find(s => s.step_order === req.current_step);
          if (!stepInfo) return false;
          if (stepInfo.approver_type === 'user' && stepInfo.approver_user_id === currentMemberId) return true;
          if (stepInfo.approver_type === 'role' && currentMember?.role === stepInfo.approver_role) return true;
          return false;
        });

        setPendingApprovals(myPending);
      } else {
        setPendingApprovals([]);
      }
    }
    setLoading(false);
  }, [currentMemberId, currentMember]);

  // Realtime subscription: re-fetch pending approvals on any INSERT/UPDATE to approval_requests
  useApprovalRealtime(currentMemberId, fetchPendingApprovals);

  const fetchApprovalHistory = useCallback(async (taskId: string): Promise<ApprovalRequest[]> => {
    const { data } = await requestQueries.fetchByTask(supabase, taskId);
    return (data as ApprovalRequest[]) ?? [];
  }, []);

  const getApprovalProgress = useCallback(async (requestId: string): Promise<ApprovalProgress | null> => {
    const { data: reqData } = await fromTable(supabase, 'approval_requests')
      .select('*')
      .eq('id', requestId)
      .single();
    if (!reqData) return null;
    const req = reqData as ApprovalRequest;

    const [stepsResult, { data: actionsData }] = await Promise.all([
      req.rule_id ? stepQueries.fetchByRule(supabase, req.rule_id) : Promise.resolve({ data: null }),
      actionQueries.fetchByRequest(supabase, requestId),
    ]);

    const steps = (stepsResult.data as ApprovalRuleStep[]) ?? [];
    const actions = (actionsData as ApprovalAction[]) ?? [];

    return {
      requestedBy: req.requested_by,
      requestStatus: req.status,
      currentStep: req.current_step,
      totalSteps: steps.length,
      steps: steps.map(s => {
        const act = actions.find(a => a.step_order === s.step_order);
        let status: ApprovalProgress['steps'][0]['status'] = 'waiting';
        if (act) {
          if (act.action === 'approve') status = 'approved';
          else if (act.action === 'reject') status = 'rejected';
          else status = 'returned';
        } else if (s.step_order === req.current_step && req.status === 'pending') {
          status = 'pending';
        }
        return {
          stepOrder: s.step_order,
          approverType: s.approver_type,
          approverRole: s.approver_role,
          approverUserId: s.approver_user_id,
          status,
          comment: act?.comment ?? null,
          actedAt: act?.acted_at ?? null,
          actionBy: act?.action_by ?? null,
        };
      }),
    };
  }, []);

  return {
    pendingApprovals,
    loading,
    requestApproval,
    performAction,
    cancelApproval,
    fetchPendingApprovals,
    fetchApprovalHistory,
    getApprovalProgress,
  };
};