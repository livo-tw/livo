import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { generateId } from '@/lib/generateId';
import { toast } from 'sonner';
import i18n from '@/i18n';
import type { StatusLog } from '@/types';

export interface StatusTransitionRule {
  id: string;
  targetStatusId: string;
  requiredStatusId: string;
  createdAt: string;
}

export interface TransitionCheckResult {
  allowed: boolean;
  missingStatusIds: string[];
}

export const useStatusTransitionRules = () => {
  const [rules, setRules] = useState<StatusTransitionRule[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRules = useCallback(async () => {
    const { data, error } = await supabase
      .from('status_transition_rules')
      .select('*');
    if (error) {
      console.error('[LIVO] Failed to load transition rules:', error.message);
    } else if (data) {
      setRules(data.map(r => ({
        id: r.id,
        targetStatusId: r.target_status_id,
        requiredStatusId: r.required_status_id,
        createdAt: r.created_at,
      })));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

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

  /**
   * Checks whether a task can transition to the target status based on its history.
   * Uses synchronous cached rules — no DB call needed.
   */
  const canTransitionTo = useCallback((
    taskId: string,
    targetStatusId: string,
    statusLogs: StatusLog[]
  ): TransitionCheckResult => {
    const targetRules = rules.filter(r => r.targetStatusId === targetStatusId);
    if (targetRules.length === 0) return { allowed: true, missingStatusIds: [] };

    const taskHistory = new Set(
      statusLogs
        .filter(l => l.taskId === taskId)
        .map(l => l.toStatusId)
    );

    const missingStatusIds = targetRules
      .filter(r => !taskHistory.has(r.requiredStatusId))
      .map(r => r.requiredStatusId);

    return {
      allowed: missingStatusIds.length === 0,
      missingStatusIds,
    };
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
