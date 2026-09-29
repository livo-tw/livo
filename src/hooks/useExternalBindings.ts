import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import i18n from '@/i18n';
import {
  bindingQueries,
  actionLogQueries,
  type ExternalAccountBinding,
  type ExternalActionLog,
  type Platform,
} from '@/lib/integrationQueries';
import { useAuthContext } from '@/context/AuthContext';

export const useExternalBindings = () => {
  const { currentMemberId } = useAuthContext();
  const [bindings, setBindings] = useState<ExternalAccountBinding[]>([]);
  const [actionLogs, setActionLogs] = useState<ExternalActionLog[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchBindings = useCallback(async (): Promise<void> => {
    setLoading(true);
    const { data, error } = await bindingQueries.fetchByMember(supabase, currentMemberId);
    if (error) {
      toast.error(i18n.t('integration.loadBindingsFailed') + (error as { message: string }).message);
    } else {
      setBindings((data as ExternalAccountBinding[]) ?? []);
    }
    setLoading(false);
  }, [currentMemberId]);

  const bindAccount = useCallback(async (
    platform: Platform,
    platformUserId: string,
    displayName: string,
    platformTeamId?: string,
  ): Promise<boolean> => {
    // Check for duplicate
    const { data: existing } = await bindingQueries.fetchByPlatformUser(
      supabase, platform, platformUserId, platformTeamId,
    );
    if (existing) {
      toast.error(i18n.t('integration.alreadyBound'));
      return false;
    }

    const { data, error } = await bindingQueries.create(supabase, {
      member_id: currentMemberId,
      platform,
      platform_user_id: platformUserId,
      platform_team_id: platformTeamId ?? null,
      display_name: displayName,
      is_verified: false,
    });

    if (error) {
      toast.error(i18n.t('integration.bindFailed') + (error as { message: string }).message);
      return false;
    }

    setBindings(prev => [data as ExternalAccountBinding, ...prev]);
    toast.success(i18n.t('integration.bound', { platform, name: displayName }));
    return true;
  }, [currentMemberId]);

  const unbindAccount = useCallback(async (bindingId: string): Promise<boolean> => {
    const { error } = await bindingQueries.delete(supabase, bindingId);
    if (error) {
      toast.error(i18n.t('integration.unbindFailed') + (error as { message: string }).message);
      return false;
    }
    setBindings(prev => prev.filter(b => b.id !== bindingId));
    toast.success(i18n.t('integration.unbound'));
    return true;
  }, []);

  const fetchActionLogs = useCallback(async (limit = 50): Promise<void> => {
    const { data, error } = await actionLogQueries.fetchByMember(supabase, currentMemberId, limit);
    if (!error) {
      setActionLogs((data as ExternalActionLog[]) ?? []);
    }
  }, [currentMemberId]);

  const getBindingForPlatform = useCallback(
    (platform: Platform): ExternalAccountBinding | undefined =>
      bindings.find(b => b.platform === platform),
    [bindings],
  );

  return {
    bindings,
    actionLogs,
    loading,
    fetchBindings,
    bindAccount,
    unbindAccount,
    fetchActionLogs,
    getBindingForPlatform,
  };
};
