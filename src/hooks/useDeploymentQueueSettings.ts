import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { useAuthContext } from '@/context/AuthContext';
import { useUIContext } from '@/context/UIContext';
import { isDeploymentQueueOperator, parseDeploymentQueueSettings, type DeploymentQueueSettings } from '@/lib/deploymentQueue';

export type DeploymentQueueSettingsStatus = 'disabled' | 'loading' | 'ready' | 'missing' | 'error';
export function useDeploymentQueueSettings() {
  const { currentMember, realMemberId } = useAuthContext();
  const { featureToggles, featureTogglesReady } = useUIContext();
  const enabled = featureTogglesReady && featureToggles.deploymentQueue === true && currentMember?.isActive === true;
  const identity = `${realMemberId || ''}:${currentMember?.id || ''}:${enabled}`;
  const [snapshot, setSnapshot] = useState<{ identity: string; status: DeploymentQueueSettingsStatus; config: DeploymentQueueSettings | null; revision: string | null }>({ identity: '', status: 'loading', config: null, revision: null });
  const serial = useRef(0);
  const channelId = useId();
  const latest = useRef({ identity, enabled, member: currentMember });
  latest.current = { identity, enabled, member: currentMember };
  const refresh = useCallback(async () => {
    const request = ++serial.current, state = latest.current;
    if (!state.enabled) return;
    setSnapshot({ identity: state.identity, status: 'loading', config: null, revision: null });
    try {
      const { data, error } = await supabase.from('system_settings').select('value,updated_at').eq('key', 'deployment_queue').maybeSingle();
      if (error) throw error;
      const config = data ? parseDeploymentQueueSettings(data.value) : null;
      if (data && !config) throw new Error('invalid-deployment-queue-settings');
      if (request === serial.current && latest.current.identity === state.identity) setSnapshot({ identity: state.identity, status: data ? 'ready' : 'missing', config, revision: data?.updated_at ?? null });
    } catch { if (request === serial.current && latest.current.identity === state.identity) setSnapshot({ identity: state.identity, status: 'error', config: null, revision: null }); }
  }, []);
  useEffect(() => {
    void refresh();
    if (!enabled) return () => { serial.current++; };
    const changed = () => { void refresh(); };
    window.addEventListener('livo:deployment-queue-settings-changed', changed);
    const channel = supabase.channel(`deployment-queue-${identity}-${channelId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'system_settings', filter: 'key=eq.deployment_queue' }, changed).subscribe();
    return () => { serial.current++; window.removeEventListener('livo:deployment-queue-settings-changed', changed); void supabase.removeChannel(channel); };
  }, [identity, enabled, refresh, channelId]);
  const status = !featureTogglesReady ? 'loading' : !enabled ? 'disabled' : snapshot.identity === identity ? snapshot.status : 'loading';
  const config = status === 'ready' ? snapshot.config : null;
  const save = async (next: DeploymentQueueSettings, expectedRevision: string | null) => {
    const state = latest.current, parsed = parseDeploymentQueueSettings(next);
    if (!state.enabled || state.member?.role !== 'super_admin' || !parsed || !['ready', 'missing'].includes(status)) throw new Error('deployment-queue-settings-forbidden');
    const row = { key: 'deployment_queue', value: parsed as unknown as Json, updated_at: new Date().toISOString(), updated_by: state.member.id };
    const result = expectedRevision === null
      ? await supabase.from('system_settings').insert(row).select('updated_at').single()
      : await supabase.from('system_settings').update(row).eq('key', 'deployment_queue').eq('updated_at', expectedRevision).select('updated_at').maybeSingle();
    if (result.error?.code === '23505' || (!result.error && !result.data)) { void refresh(); throw new Error('deployment-queue-settings-conflict'); }
    if (result.error) throw result.error;
    if (latest.current.identity === state.identity) { await refresh(); window.dispatchEvent(new Event('livo:deployment-queue-settings-changed')); }
  };
  return { status, config, revision: status === 'ready' ? snapshot.revision : null, refresh, save,
    isOperator: currentMember?.isActive === true && isDeploymentQueueOperator(config, featureTogglesReady ? featureToggles : null, currentMember.id) };
}
