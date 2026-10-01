import { supabase } from '@/integrations/supabase/client';
import { fromTable } from './supabaseQuery';
import { resolveFeatureToggles, type FeatureKey } from './featureToggles';
import type { ApprovalRequest } from './approvalQueries';

export interface PendingFeatureApproval extends ApprovalRequest {
  task: { id: string; task_key: string; title: string };
}

export async function fetchPendingFeatureApprovals(): Promise<PendingFeatureApproval[]> {
  const pending: PendingFeatureApproval[] = [];
  const pageSize = 200;
  for (let offset = 0; ; offset += pageSize) {
    const result = await fromTable(supabase, 'approval_requests').select('*')
      .eq('status', 'pending').order('id').range(offset, offset + pageSize - 1);
    if (result.error) throw result.error;
    const requests = (result.data ?? []) as ApprovalRequest[];
    if (requests.length) {
      const tasks = await supabase.from('tasks').select('id, task_key, title')
        .in('id', [...new Set(requests.map(request => request.task_id))]);
      if (tasks.error) throw tasks.error;
      for (const request of requests) {
        const task = tasks.data?.find(task => task.id === request.task_id);
        if (!task) throw new Error('A pending approval task could not be loaded');
        pending.push({ ...request, task });
      }
    }
    if (requests.length < pageSize) return pending;
  }
}

export async function loadFeatureToggles() {
  const { data, error } = await fromTable(supabase, 'system_settings').select('value')
    .eq('key', 'feature_toggles').maybeSingle();
  if (error) throw error;
  const value = data?.value;
  // Query presence, not active rules: historical teams retain their behavior.
  let hasApprovalRules = false;
  let hasApprovalRequests = false;
  if (!value || typeof (value as Record<string, unknown>).approvals !== 'boolean') {
    const [rules, requests] = await Promise.all([
      fromTable(supabase, 'approval_rules').select('id').limit(1),
      fromTable(supabase, 'approval_requests').select('id').limit(1),
    ]);
    if (rules.error) throw rules.error;
    if (requests.error) throw requests.error;
    hasApprovalRules = !!rules.data?.length;
    hasApprovalRequests = !!requests.data?.length;
  }
  return resolveFeatureToggles(value, { hasApprovalRules, hasApprovalRequests });
}

export async function persistFeatureToggle(key: FeatureKey, enabled: boolean) {
  const { data, error } = await fromTable(supabase, 'system_settings').select('value')
    .eq('key', 'feature_toggles').maybeSingle();
  if (error) throw error;
  const previous = data?.value && typeof data.value === 'object' && !Array.isArray(data.value)
    ? data.value : {};
  const saved = await fromTable(supabase, 'system_settings').upsert({
    key: 'feature_toggles', value: { ...previous, [key]: enabled }, updated_at: new Date().toISOString(),
  }).select('value').single();
  if (saved.error) throw saved.error;
  if (!saved.data || (saved.data.value as Record<string, unknown>)[key] !== enabled) {
    throw new Error('Feature setting was not saved');
  }
}
