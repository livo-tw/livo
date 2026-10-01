import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import {
  defaultTeamIntroTemplate, parseTeamIntroTemplate, TEAM_INTRO_TEMPLATE_KEY,
  type TeamIntroTemplate,
} from '@/lib/teamIntroTemplate';

export function useTeamIntroTemplate() {
  const [template, setTemplate] = useState(defaultTeamIntroTemplate);
  const [revision, setRevision] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const requestId = useRef(0);

  const reload = useCallback(async () => {
    const request = ++requestId.current;
    try {
      const { data, error } = await supabase.from('system_settings')
        .select('value,updated_at').eq('key', TEAM_INTRO_TEMPLATE_KEY).maybeSingle();
      if (error) throw error;
      const next = data ? parseTeamIntroTemplate(data.value) : defaultTeamIntroTemplate();
      if (!next) throw new Error('Invalid team introduction template');
      if (request !== requestId.current) return;
      setTemplate(next);
      setRevision(data?.updated_at ?? null);
      setLoadError(false);
      setReady(true);
    } catch {
      if (request !== requestId.current) return;
      setLoadError(true);
      setReady(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const channel = supabase.channel('team-intro-template')
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'system_settings', filter: `key=eq.${TEAM_INTRO_TEMPLATE_KEY}`,
      }, () => { void reload(); })
      .subscribe();
    return () => { requestId.current++; void supabase.removeChannel(channel); };
  }, [reload]);

  const save = async (next: TeamIntroTemplate, expectedRevision: string | null, memberId: string) => {
    const parsed = parseTeamIntroTemplate(next);
    if (!ready || !parsed) throw new Error('Invalid team introduction template');
    const row = {
      key: TEAM_INTRO_TEMPLATE_KEY, value: parsed as unknown as Json,
      updated_at: new Date().toISOString(), updated_by: memberId,
    };
    // A stale editor must not overwrite fields added by another administrator.
    const result = expectedRevision === null
      ? await supabase.from('system_settings').insert(row).select('updated_at').single()
      : await supabase.from('system_settings').update(row).eq('key', TEAM_INTRO_TEMPLATE_KEY)
        .eq('updated_at', expectedRevision).select('updated_at').maybeSingle();
    if (result.error?.code === '23505' || (!result.error && !result.data)) {
      void reload();
      throw new Error('template-conflict');
    }
    if (result.error) throw result.error;
    requestId.current++;
    setTemplate(parsed);
    setRevision(result.data!.updated_at);
  };

  return { template, revision, ready, loadError, reload, save };
}
