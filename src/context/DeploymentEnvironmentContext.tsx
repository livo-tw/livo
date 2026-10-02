import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { useAuthContext } from './AuthContext';
import { defaultDeploymentEnvironments, DEPLOYMENT_ENVIRONMENTS_KEY, parseDeploymentEnvironments } from '@/lib/deploymentEnvironments';

interface EnvironmentState {
  values: string[]; revision: string | null; ready: boolean; loadError: boolean;
  reload: () => Promise<void>;
  save: (values: string[], expectedRevision: string | null) => Promise<void>;
}
const fallback: EnvironmentState = {
  values: defaultDeploymentEnvironments().values, revision: null, ready: true, loadError: false,
  reload: async (): Promise<void> => {}, save: async (): Promise<void> => { throw new Error('environment-provider-required'); },
};
const EnvironmentContext = createContext<EnvironmentState>(fallback);
export const useDeploymentEnvironments = () => useContext(EnvironmentContext);

export function DeploymentEnvironmentProvider({ children }: { children: ReactNode }) {
  const { realMemberId, currentMemberId } = useAuthContext();
  const [values, setValues] = useState(defaultDeploymentEnvironments().values);
  const [revision, setRevision] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const serial = useRef(0);
  const reload = useCallback(async () => {
    const request = ++serial.current;
    try {
      const { data, error } = await supabase.from('system_settings').select('value,updated_at').eq('key', DEPLOYMENT_ENVIRONMENTS_KEY).maybeSingle();
      if (error) throw error;
      const parsed = parseDeploymentEnvironments(data?.value);
      if (!parsed) throw new Error('invalid-environments');
      if (request !== serial.current) return;
      setValues(parsed.values); setRevision(data?.updated_at ?? null); setReady(true); setLoadError(false);
    } catch { if (request === serial.current) { setReady(false); setLoadError(true); } }
  }, []);
  useEffect(() => {
    setReady(false); setValues(defaultDeploymentEnvironments().values); setRevision(null);
    void reload();
    const channel = supabase.channel(`deployment-environments-${realMemberId || 'session'}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'system_settings', filter: `key=eq.${DEPLOYMENT_ENVIRONMENTS_KEY}` }, () => { void reload(); }).subscribe();
    return () => { serial.current++; void supabase.removeChannel(channel); };
  }, [realMemberId, reload]);
  const save = async (next: string[], expectedRevision: string | null) => {
    const parsed = parseDeploymentEnvironments({ version: 1, values: next });
    if (!ready || !parsed) throw new Error('invalid-environments');
    const row = { key: DEPLOYMENT_ENVIRONMENTS_KEY, value: parsed as unknown as Json, updated_at: new Date().toISOString(), updated_by: currentMemberId };
    const result = expectedRevision === null
      ? await supabase.from('system_settings').insert(row).select('updated_at').single()
      : await supabase.from('system_settings').update(row).eq('key', DEPLOYMENT_ENVIRONMENTS_KEY).eq('updated_at', expectedRevision).select('updated_at').maybeSingle();
    if (result.error?.code === '23505' || (!result.error && !result.data)) { void reload(); throw new Error('environment-conflict'); }
    if (result.error) throw result.error;
    serial.current++; setValues(parsed.values); setRevision(result.data!.updated_at);
  };
  return <EnvironmentContext.Provider value={{ values, revision, ready, loadError, reload, save }}>{children}</EnvironmentContext.Provider>;
}
