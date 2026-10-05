import { useCallback, useSyncExternalStore } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { generateId } from '@/lib/generateId';
import { missingRequiredStatuses, type StatusTransitionRule } from '@/lib/taskStatusChange';
import { toast } from 'sonner';
import i18n from '@/i18n';
import type { StatusLog } from '@/types';

export type { StatusTransitionRule } from '@/lib/taskStatusChange';

export interface TransitionCheckResult {
  allowed: boolean;
  missingStatusIds: string[];
}

// One copy for the whole app: every card's quick status menu checks the same
// rules, so they are loaded once, shared, and reloaded after an edit.
let store: { rules: StatusTransitionRule[]; loading: boolean } = { rules: [], loading: true };
const listeners = new Set<() => void>();
let request = 0;
async function loadRules() {
  const current = ++request;
  const { data, error } = await supabase.from('status_transition_rules').select('*');
  if (current !== request) return;
  if (error) console.error('[LIVO] Failed to load transition rules:', error.message);
  store = { rules: error || !data ? store.rules : data.map(r => ({
    id: r.id, targetStatusId: r.target_status_id, requiredStatusId: r.required_status_id, createdAt: r.created_at,
  })), loading: false };
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  // The first screen to need the rules after none did (a new sign-in included) loads them again.
  if (!listeners.size) void loadRules();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const snapshot = () => store;

export const useStatusTransitionRules = () => {
  const { rules, loading } = useSyncExternalStore(subscribe, snapshot, snapshot);
  const fetchRules = useCallback(() => loadRules(), []);
  const getRulesForStatus = useCallback((statusId: string): StatusTransitionRule[] => {
    return rules.filter(r => r.targetStatusId === statusId);
  }, [rules]);

  const addRule = useCallback(async (targetStatusId: string, requiredStatusId: string): Promise<boolean> => {
    const { error } = await supabase
      .from('status_transition_rules')
      .insert({ id: generateId('strule'), target_status_id: targetStatusId, required_status_id: requiredStatusId });
    if (error) {
      toast.error(i18n.t('transitionRule.addFailed') + error.message);
      return false;
    }
    await fetchRules();
    return true;
  }, [fetchRules]);

  const removeRule = useCallback(async (id: string): Promise<boolean> => {
    const { error } = await supabase
      .from('status_transition_rules')
      .delete()
      .eq('id', id);
    if (error) {
      toast.error(i18n.t('transitionRule.deleteFailed') + error.message);
      return false;
    }
    await fetchRules();
    return true;
  }, [fetchRules]);

  /** Whether a task's history allows the target status (cached rules, no database call). */
  const canTransitionTo = useCallback((taskId: string, targetStatusId: string, statusLogs: StatusLog[]): TransitionCheckResult => {
    const missingStatusIds = missingRequiredStatuses(rules, taskId, targetStatusId, statusLogs);
    return { allowed: missingStatusIds.length === 0, missingStatusIds };
  }, [rules]);

  return {
    rules,
    loading,
    getRulesForStatus,
    addRule,
    removeRule,
    canTransitionTo,
    refreshRules: fetchRules,
  };
};
