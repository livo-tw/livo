import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { fromTable } from './supabaseQuery';

type DB = SupabaseClient<Database>;
const q = fromTable;

export interface ApprovalRule {
  id: string;
  project_id: string;
  from_status: string;
  to_status: string;
  is_active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRuleStep {
  id: string;
  rule_id: string;
  step_order: number;
  approver_type: 'role' | 'user';
  approver_role: string | null;
  approver_user_id: string | null;
  allow_delegate: boolean;
  timeout_hours: number | null;
  timeout_action: 'remind' | 'auto_approve' | 'escalate' | null;
  created_at: string;
}

export interface ApprovalRequest {
  id: string;
  task_id: string;
  rule_id: string | null;
  requested_by: string;
  from_status: string;
  to_status: string;
  current_step: number;
  status: 'pending' | 'approved' | 'rejected' | 'returned' | 'cancelled';
  created_at: string;
  completed_at: string | null;
}

export interface ApprovalAction {
  id: string;
  request_id: string;
  step_order: number;
  action_by: string;
  action: 'approve' | 'reject' | 'return';
  comment: string | null;
  acted_at: string;
}

export const ruleQueries = {
  fetchByProject: (db: DB, projectId: string) =>
    q(db, 'approval_rules')
      .select('*')
      .eq('project_id', projectId)
      .eq('is_active', true)
      .order('created_at'),

  create: (db: DB, data: Omit<ApprovalRule, 'id' | 'created_at' | 'updated_at'>) =>
    q(db, 'approval_rules').insert(data).select().single(),

  update: (db: DB, id: string, data: Partial<ApprovalRule>) =>
    q(db, 'approval_rules')
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single(),

  delete: (db: DB, id: string) =>
    q(db, 'approval_rules').delete().eq('id', id),

  fetchForTransition: (db: DB, projectId: string, fromStatus: string, toStatus: string) =>
    q(db, 'approval_rules')
      .select('*')
      .eq('project_id', projectId)
      .eq('from_status', fromStatus)
      .eq('to_status', toStatus)
      .eq('is_active', true)
      .maybeSingle(),
};

export const stepQueries = {
  fetchByRule: (db: DB, ruleId: string) =>
    q(db, 'approval_rule_steps')
      .select('*')
      .eq('rule_id', ruleId)
      .order('step_order'),

  upsertSteps: (db: DB, steps: Omit<ApprovalRuleStep, 'id' | 'created_at'>[]) =>
    q(db, 'approval_rule_steps')
      .upsert(steps, { onConflict: 'rule_id,step_order' })
      .select(),

  deleteByRule: (db: DB, ruleId: string) =>
    q(db, 'approval_rule_steps').delete().eq('rule_id', ruleId),
};

export const requestQueries = {
  create: (db: DB, data: Omit<ApprovalRequest, 'id' | 'created_at' | 'completed_at'>) =>
    q(db, 'approval_requests').insert(data).select().single(),

  fetchByTask: (db: DB, taskId: string) =>
    q(db, 'approval_requests')
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: false }),

  fetchPending: (db: DB) =>
    q(db, 'approval_requests')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),

  /**
   * Fetch all pending requests. The hook is responsible for filtering
   * to only the ones where userId is the current-step approver, because
   * PostgREST cannot do a column-to-column join filter on current_step.
   * The userId param is kept so this is no longer dead code and for
   * future RPC migration.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fetchMyPending: (db: DB, userId: string) =>
    q(db, 'approval_requests')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),

  updateStatus: (db: DB, id: string, status: ApprovalRequest['status'], completedAt?: string) =>
    q(db, 'approval_requests')
      .update({ status, completed_at: completedAt ?? null })
      .eq('id', id)
      .eq('status', 'pending')
      .select()
      .single(),
};

export const actionQueries = {
  create: (db: DB, data: Omit<ApprovalAction, 'id' | 'acted_at'>) =>
    q(db, 'approval_actions').insert(data).select().single(),

  fetchByRequest: (db: DB, requestId: string) =>
    q(db, 'approval_actions')
      .select('*')
      .eq('request_id', requestId)
      .order('acted_at'),
};

/** Task-side approval status helpers — centralises all writes to tasks.approval_status */
export const taskApprovalQueries = {
  /** Mark a task as awaiting approval */
  setPendingApproval: (db: DB, taskId: string, requestId: string) =>
    q(db, 'tasks')
      .update({ approval_status: 'pending_approval', current_approval_id: requestId })
      .eq('id', taskId),

  /** Clear approval fields when a request is cancelled, rejected, or returned */
  clearApprovalStatus: (db: DB, taskId: string) =>
    q(db, 'tasks')
      .update({ approval_status: null, current_approval_id: null })
      .eq('id', taskId),

  /** Apply the approved status transition and clear approval fields */
  applyStatusChange: (db: DB, taskId: string, newStatusId: string, extra?: { started_at?: string; completed_at?: string | null }) =>
    q(db, 'tasks')
      .update({ status_id: newStatusId, approval_status: null, current_approval_id: null, ...extra })
      .eq('id', taskId),
};
