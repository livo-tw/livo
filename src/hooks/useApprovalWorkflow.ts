import { approvalErrorText } from '@/lib/approval/feedback';
import { useState, useCallback, useMemo, useRef } from 'react';
import { useApprovalRealtime } from './useApprovalRealtime';
import { supabase } from '@/integrations/supabase/client';
import { fromTable } from '@/lib/supabaseQuery';
import { toast } from 'sonner';
import { requestQueries, actionQueries, type ApprovalRequest, type ApprovalAction } from '@/lib/approvalQueries';
import { useAuthContext } from '@/context/AuthContext';
import { useUIContext } from '@/context/UIContext';
import { withdrawApproval } from '@/lib/withdrawApproval';
import { createApprovalCommandRunner } from '@/lib/approvalCommands';
import { approvalSnapshotSteps, canActOnApproval, ApprovalCommandError } from '@/lib/approval/core';
import type { ApprovalTaskState } from '@/lib/approval/core';
import type { Task } from '@/types';
import i18n from '@/i18n';
export interface ApprovalProgress {
  requestedBy:string;requestStatus:ApprovalRequest['status'];currentStep:number;totalSteps:number;
  version:number;legacy:boolean;ruleId:string|null;
  steps:Array<{stepOrder:number;approverType:'role'|'user';approverRole:string|null;approverUserId:string|null;
    status:'approved'|'rejected'|'returned'|'pending'|'waiting';comment:string|null;actedAt:string|null;actionBy:string|null;}>;
}
export interface ApprovalActionResult {ok:boolean;approvedToStatus?:string;taskId?:string;task?:ApprovalTaskState;}
export const useApprovalWorkflow = () => {
  const {currentMemberId,currentMember} = useAuthContext();
  const {approvalsEnabled,featureTogglesReady} = useUIContext();
  const [pendingApprovals,setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [loading,setLoading] = useState(false);
  const run = useMemo(() => createApprovalCommandRunner(supabase), [currentMemberId]);
  const observed = useRef(new Map<string, ApprovalRequest>());
  const requestApproval = useCallback(async (
    taskId:string,ruleId:string|null,fromStatus:string,toStatus:string,task?:Task,enableRequirement=false,
  ):Promise<ApprovalRequest|null> => {
    if (!featureTogglesReady || !approvalsEnabled) return null;
    try {
      let expected = task ? {statusId:fromStatus,requiresApproval:!!task.requiresApproval,
        currentApprovalId:task.currentApprovalId ?? null,approvalStatus:task.approvalStatus ?? null} : undefined;
      if (!expected) {
        const {data,error} = await fromTable(supabase,'tasks').select('status_id,requires_approval,current_approval_id,approval_status').eq('id',taskId).single();
        if (error || !data) throw new ApprovalCommandError('approval_unavailable',404);
        expected = {statusId:fromStatus,requiresApproval:!!data.requires_approval,
          currentApprovalId:data.current_approval_id,approvalStatus:data.approval_status};
      }
      return (await run({operation:'submit',taskId,expected,toStatusId:toStatus,expectedRuleId:ruleId,enableRequirement})).request;
    } catch (error) {toast.error(approvalErrorText(error));return null;}
  },[approvalsEnabled,featureTogglesReady,run]);
  const performAction = useCallback(async (
    requestId:string,action:'approve'|'reject'|'return',comment?:string,_task?:Task,expected?:{version:number;current_step:number},
  ):Promise<ApprovalActionResult> => {
    if (!featureTogglesReady || !approvalsEnabled) return {ok:false};
    try {
      const view = expected ?? observed.current.get(requestId);
      if (!view || !Number.isSafeInteger(view.version)) throw new ApprovalCommandError('approval_conflict',409);
      const result = await run({operation:action,requestId,expectedVersion:view.version,expectedStep:view.current_step,comment:comment ?? null});
      const req = result.request!;
      setPendingApprovals(prev => prev.filter(p => p.id !== requestId));
      observed.current.set(requestId,req);
      toast.success(i18n.t(action === 'reject' ? 'approval.rejectedSuccess' : action === 'return' ? 'approval.returnedSuccess'
        : req.status === 'approved' ? 'approval.approvalCompleted' : 'approval.stepApproved',{current:view.current_step,next:req.current_step}));
      return {ok:true,taskId:result.task.id,task:result.task,...(req.status === 'approved' ? {approvedToStatus:req.to_status} : {})};
    } catch (error) {toast.error(approvalErrorText(error));return {ok:false};}
  },[approvalsEnabled,featureTogglesReady,run]);
  const cancelApproval = useCallback(async (requestId:string,options?:{silent?:boolean;onResult?:(result:ApprovalActionResult)=>void}):Promise<boolean> => {
    try {
      const saved = await withdrawApproval(supabase,requestId,run);
      try {options?.onResult?.({ok:true,taskId:saved.task.id,task:saved.task});} catch {/* A rendering callback cannot undo a committed command. */}
      if (!options?.silent) toast.success(i18n.t('approval.approvalCancelled'));
      setPendingApprovals(prev => prev.filter(p => p.id !== requestId));return true;
    } catch (error) {if (!options?.silent) toast.error(approvalErrorText(error));return false;}
  },[run]);
  const fetchPendingApprovals = useCallback(async ():Promise<void> => {
    if (!approvalsEnabled || !featureTogglesReady) {setPendingApprovals([]);return;}
    setLoading(true);
    try {
      const {data,error} = await requestQueries.fetchPending(supabase);if (error) throw error;
      const pending = (data as ApprovalRequest[]) ?? [];
      pending.forEach(req => observed.current.set(req.id,req));
      const admin = ['admin','super_admin'].includes(currentMember?.role ?? '');
      setPendingApprovals(pending.filter(req => canActOnApproval(req,{id:currentMemberId,role:currentMember?.role ?? '',active:currentMember?.isActive})
        || (!approvalSnapshotSteps(req) && (req.requested_by === currentMemberId || admin))));
    } catch {toast.error(i18n.t('approvalCommand.unavailable'));} finally {setLoading(false);}
  },[approvalsEnabled,featureTogglesReady,currentMemberId,currentMember]);
  useApprovalRealtime(currentMemberId,fetchPendingApprovals,approvalsEnabled && featureTogglesReady);
  const fetchApprovalHistory = useCallback(async (taskId:string):Promise<ApprovalRequest[]> => {
    const {data,error} = await requestQueries.fetchByTask(supabase,taskId);if (error) throw error;
    return (data as ApprovalRequest[]) ?? [];
  },[]);
  const getApprovalProgress = useCallback(async (requestId:string):Promise<ApprovalProgress|null> => {
    const {data,error} = await fromTable(supabase,'approval_requests').select('*').eq('id',requestId).single();
    if (error) throw error;if (!data) return null;
    const req = data as ApprovalRequest;observed.current.set(req.id,req);
    const steps = approvalSnapshotSteps(req);
    const {data:actionsData,error:actionsError} = await actionQueries.fetchByRequest(supabase,requestId);if (actionsError) throw actionsError;
    const actions = (actionsData as ApprovalAction[]) ?? [];
    return {requestedBy:req.requested_by,requestStatus:req.status,currentStep:req.current_step,totalSteps:steps?.length ?? 0,
      version:req.version,legacy:!steps,ruleId:req.rule_id,steps:(steps ?? []).map(s => {
        const act = actions.find(a => a.step_order === s.step_order);
        const status:ApprovalProgress['steps'][0]['status'] = act ? act.action === 'approve' ? 'approved' : act.action === 'reject' ? 'rejected' : 'returned'
          : s.step_order === req.current_step && req.status === 'pending' ? 'pending' : 'waiting';
        return {stepOrder:s.step_order,approverType:s.approver_type,approverRole:s.approver_role,approverUserId:s.approver_user_id,
          status,comment:act?.comment ?? null,actedAt:act?.acted_at ?? null,actionBy:act?.action_by ?? null};
      })};
  },[]);
  return {pendingApprovals:approvalsEnabled ? pendingApprovals : [],loading,requestApproval,performAction,cancelApproval,fetchPendingApprovals,fetchApprovalHistory,getApprovalProgress};
};
