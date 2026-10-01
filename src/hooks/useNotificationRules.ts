import { useState, useCallback } from 'react';
import { useUIContext } from '@/context/UIContext';
import { isEventEnabled } from '@/lib/featureToggles';
import { supabase } from '@/integrations/supabase/client';
import {
  ruleQueries,
  type NotificationRule,
  type EventType,
} from '@/lib/notificationQueries';

export interface NotificationEvent {
  eventType: EventType;
  fromStatus?: string;
  toStatus?: string;
  projectId?: string;
}

export function useNotificationRules() {
  const { approvalsEnabled } = useUIContext();
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRules = useCallback(async (projectId?: string) => {
    setLoading(true);
    setError(null);
    const query = projectId
      ? ruleQueries.fetchByProject(supabase, projectId)
      : ruleQueries.fetchAll(supabase);
    const { data, error: err } = await query;
    if (err) {
      setError((err as { message: string }).message);
    } else {
      setRules((data as NotificationRule[]) ?? []);
    }
    setLoading(false);
  }, []);

  const createRule = useCallback(async (
    data: Omit<NotificationRule, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<NotificationRule | null> => {
    const { data: created, error: err } = await ruleQueries.create(supabase, data);
    if (err) {
      console.error('[LIVO] Failed to create rule:', (err as { message: string }).message);
      return null;
    }
    const r = created as NotificationRule;
    setRules(prev => [...prev, r]);
    return r;
  }, []);

  const updateRule = useCallback(async (
    id: string,
    data: Partial<NotificationRule>,
  ): Promise<NotificationRule | null> => {
    const { data: updated, error: err } = await ruleQueries.update(supabase, id, data);
    if (err) {
      console.error('[LIVO] Failed to update rule:', (err as { message: string }).message);
      return null;
    }
    const r = updated as NotificationRule;
    setRules(prev => prev.map(x => (x.id === id ? r : x)));
    return r;
  }, []);

  const deleteRule = useCallback(async (id: string): Promise<boolean> => {
    const { error: err } = await ruleQueries.delete(supabase, id);
    if (err) {
      console.error('[LIVO] Failed to delete rule:', (err as { message: string }).message);
      return false;
    }
    setRules(prev => prev.filter(x => x.id !== id));
    return true;
  }, []);

  const toggleRule = useCallback(async (id: string, enabled: boolean): Promise<boolean> => {
    const { data: updated, error: err } = await ruleQueries.toggle(supabase, id, enabled);
    if (err) {
      console.error('[LIVO] Failed to toggle rule:', (err as { message: string }).message);
      return false;
    }
    const r = updated as NotificationRule;
    setRules(prev => prev.map(x => (x.id === id ? r : x)));
    return true;
  }, []);

  /** Return all enabled rules matching this event (for batch triggering) */
  const evaluateRules = useCallback((event: NotificationEvent): NotificationRule[] => {
    if (!isEventEnabled(event.eventType, approvalsEnabled)) return [];
    return rules.filter(r => {
      if (!r.is_enabled) return false;
      if (r.event_type !== event.eventType) return false;
      if (r.from_status && r.from_status !== event.fromStatus) return false;
      if (r.to_status && r.to_status !== event.toStatus) return false;
      return true;
    });
  }, [rules, approvalsEnabled]);

  /** Project-level rules take priority over global rules */
  const getEffectiveRule = useCallback((
    eventType: EventType,
    fromStatus?: string,
    toStatus?: string,
    projectId?: string,
  ): NotificationRule | null => {
    if (!isEventEnabled(eventType, approvalsEnabled)) return null;
    const candidates = rules.filter(r => {
      if (!r.is_enabled) return false;
      if (r.event_type !== eventType) return false;
      if (r.from_status && r.from_status !== fromStatus) return false;
      if (r.to_status && r.to_status !== toStatus) return false;
      return true;
    });
    if (projectId) {
      const projectRule = candidates.find(r => r.project_id === projectId);
      if (projectRule) return projectRule;
    }
    return candidates.find(r => r.project_id === null) ?? null;
  }, [rules, approvalsEnabled]);

  return {
    rules: rules.filter(rule => isEventEnabled(rule.event_type, approvalsEnabled)),
    loading,
    error,
    fetchRules,
    createRule,
    updateRule,
    deleteRule,
    toggleRule,
    evaluateRules,
    getEffectiveRule,
  };
}
