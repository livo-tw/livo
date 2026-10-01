import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import i18n from '@/i18n';
import {
  ruleQueries,
  stepQueries,
  type ApprovalRule,
  type ApprovalRuleStep,
} from '@/lib/approvalQueries';
import { useAuthContext } from '@/context/AuthContext';
import { useUIContext } from '@/context/UIContext';

export const useApprovalRules = () => {
  const { currentMemberId } = useAuthContext();
  const { approvalsEnabled, featureTogglesReady } = useUIContext();
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [stepsMap, setStepsMap] = useState<Record<string, ApprovalRuleStep[]>>({});
  const [loading, setLoading] = useState(false);

  const fetchRules = useCallback(async (projectId: string) => {
    if (!approvalsEnabled || !featureTogglesReady) { setRules([]); setStepsMap({}); return; }
    setLoading(true);
    const { data, error } = await ruleQueries.fetchByProject(supabase, projectId);
    if (error) {
      toast.error(i18n.t('approvalRule.loadFailed') + (error as { message: string }).message);
    } else {
      const ruleList = (data as ApprovalRule[]) ?? [];
      setRules(ruleList);
      const entries = await Promise.all(
        ruleList.map(async r => {
          const { data: steps } = await stepQueries.fetchByRule(supabase, r.id);
          return [r.id, (steps as ApprovalRuleStep[]) ?? []] as [string, ApprovalRuleStep[]];
        })
      );
      setStepsMap(Object.fromEntries(entries));
    }
    setLoading(false);
  }, [approvalsEnabled, featureTogglesReady]);

  const fetchRulesForProjects = useCallback(async (projectIds: string[]) => {
    if (!approvalsEnabled || !featureTogglesReady || projectIds.length === 0) { setRules([]); setStepsMap({}); return; }
    setLoading(true);
    const allRules: ApprovalRule[] = [];
    const allSteps: [string, ApprovalRuleStep[]][] = [];
    for (const pid of projectIds) {
      const { data } = await ruleQueries.fetchByProject(supabase, pid);
      if (data) {
        const ruleList = data as ApprovalRule[];
        allRules.push(...ruleList);
        const entries = await Promise.all(
          ruleList.map(async r => {
            const { data: steps } = await stepQueries.fetchByRule(supabase, r.id);
            return [r.id, (steps as ApprovalRuleStep[]) ?? []] as [string, ApprovalRuleStep[]];
          })
        );
        allSteps.push(...entries);
      }
    }
    setRules(allRules);
    setStepsMap(Object.fromEntries(allSteps));
    setLoading(false);
  }, [approvalsEnabled, featureTogglesReady]);

  const createRule = useCallback(async (
    projectId: string,
    fromStatus: string,
    toStatus: string,
    steps: Omit<ApprovalRuleStep, 'id' | 'created_at' | 'rule_id'>[],
  ): Promise<ApprovalRule | null> => {
    const { data: rule, error } = await ruleQueries.create(supabase, {
      project_id: projectId,
      from_status: fromStatus,
      to_status: toStatus,
      is_active: true,
      created_by: currentMemberId,
    });
    if (error || !rule) {
      toast.error(i18n.t('approvalRule.createFailed') + (error as { message: string })?.message);
      return null;
    }
    const r = rule as ApprovalRule;
    if (steps.length > 0) {
      const stepsToInsert = steps.map((s, i) => ({ ...s, rule_id: r.id, step_order: i + 1 }));
      const { error: se } = await stepQueries.upsertSteps(supabase, stepsToInsert);
      if (se) {
        // Rollback: delete the rule we just created since steps failed
        await ruleQueries.delete(supabase, r.id);
        toast.error(i18n.t('approvalRule.stepCreateFailedRollback') + (se as { message: string }).message);
        return null;
      }
      const { data: fetchedSteps } = await stepQueries.fetchByRule(supabase, r.id);
      setStepsMap(prev => ({ ...prev, [r.id]: (fetchedSteps as ApprovalRuleStep[]) ?? [] }));
    }
    setRules(prev => [...prev, r]);
    toast.success(i18n.t('approvalRule.created'));
    return r;
  }, [currentMemberId]);

  const updateRule = useCallback(async (
    ruleId: string,
    data: Partial<ApprovalRule>,
  ): Promise<ApprovalRule | null> => {
    const { data: updated, error } = await ruleQueries.update(supabase, ruleId, data);
    if (error) {
      toast.error(i18n.t('approvalRule.updateFailed') + (error as { message: string }).message);
      return null;
    }
    const r = updated as ApprovalRule;
    setRules(prev => prev.map(rule => rule.id === ruleId ? r : rule));
    toast.success(i18n.t('approvalRule.updated'));
    return r;
  }, []);

  const updateRuleWithSteps = useCallback(async (
    ruleId: string,
    ruleData: Partial<ApprovalRule>,
    newSteps: Omit<ApprovalRuleStep, 'id' | 'created_at' | 'rule_id'>[],
  ): Promise<ApprovalRule | null> => {
    const { data: updated, error } = await ruleQueries.update(supabase, ruleId, ruleData);
    if (error) {
      toast.error(i18n.t('approvalRule.updateFailed') + (error as { message: string }).message);
      return null;
    }
    const r = updated as ApprovalRule;
    // Replace steps: delete old then insert new
    await stepQueries.deleteByRule(supabase, ruleId);
    if (newSteps.length > 0) {
      const stepsToInsert = newSteps.map((s, i) => ({ ...s, rule_id: ruleId, step_order: i + 1 }));
      const { error: se } = await stepQueries.upsertSteps(supabase, stepsToInsert);
      if (se) {
        toast.error(i18n.t('approvalRule.stepCreateFailedRollback') + (se as { message: string }).message);
        return null;
      }
    }
    const { data: fetchedSteps } = await stepQueries.fetchByRule(supabase, ruleId);
    setStepsMap(prev => ({ ...prev, [ruleId]: (fetchedSteps as ApprovalRuleStep[]) ?? [] }));
    setRules(prev => prev.map(rule => rule.id === ruleId ? r : rule));
    toast.success(i18n.t('approvalRule.updated'));
    return r;
  }, []);

  const deleteRule = useCallback(async (ruleId: string): Promise<boolean> => {
    const { error } = await ruleQueries.delete(supabase, ruleId);
    if (error) {
      toast.error(i18n.t('approvalRule.deleteFailed') + (error as { message: string }).message);
      return false;
    }
    setRules(prev => prev.filter(r => r.id !== ruleId));
    setStepsMap(prev => { const n = { ...prev }; delete n[ruleId]; return n; });
    toast.success(i18n.t('approvalRule.deleted'));
    return true;
  }, []);

  const checkTransitionNeedsApproval = useCallback(async (
    projectId: string,
    fromStatus: string,
    toStatus: string,
  ): Promise<boolean> => {
    if (!approvalsEnabled || !featureTogglesReady) return false;
    const { data, error } = await ruleQueries.fetchForTransition(supabase, projectId, fromStatus, toStatus);
    if (error) console.error('[LIVO] approval rule query error:', error);
    return !!data;
  }, [approvalsEnabled, featureTogglesReady]);

  const getRuleForTransition = useCallback(async (
    projectId: string,
    fromStatus: string,
    toStatus: string,
  ): Promise<{ rule: ApprovalRule; steps: ApprovalRuleStep[] } | null> => {
    if (!approvalsEnabled || !featureTogglesReady) return null;
    const { data: rule } = await ruleQueries.fetchForTransition(supabase, projectId, fromStatus, toStatus);
    if (!rule) return null;
    const r = rule as ApprovalRule;
    const { data: steps } = await stepQueries.fetchByRule(supabase, r.id);
    return { rule: r, steps: (steps as ApprovalRuleStep[]) ?? [] };
  }, [approvalsEnabled, featureTogglesReady]);

  return {
    rules,
    stepsMap,
    loading,
    fetchRules,
    fetchRulesForProjects,
    createRule,
    updateRule,
    updateRuleWithSteps,
    deleteRule,
    checkTransitionNeedsApproval,
    getRuleForTransition,
  };
};
