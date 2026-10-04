import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAuthContext } from '@/context/AuthContext';
import { useTaskContext } from '@/context/TaskContext';
import { useUIContext } from '@/context/UIContext';
import { useQa } from '@/hooks/useQa';
import { supabase } from '@/integrations/supabase/client';
import { buildMyAssignments, loadMyQaAssignments } from '@/lib/myAssignments';
import type { QaIssue } from '@/lib/qa/domain';

type QaSnapshot = { identity: string; issues: QaIssue[]; phase: 'disabled' | 'loading' | 'ready' | 'error' };
const Context = createContext<{ identity: string; snapshot: QaSnapshot; refresh: () => void } | null>(null);

export function MyAssignmentsProvider({ children }: { children: React.ReactNode }) {
  const { client, enabled, actor } = useQa();
  const { featureTogglesReady, featureTogglesError, refreshFeatureToggles } = useUIContext();
  const identity = `${actor.id}:${actor.role}:${actor.qaAdmin === true}:${enabled}:${featureTogglesReady}:${!!featureTogglesError}`;
  const initialPhase = !featureTogglesReady ? featureTogglesError ? 'error' : 'loading' : enabled ? 'loading' : 'disabled';
  const [snapshot, setSnapshot] = useState<QaSnapshot>({ identity, issues: [], phase: initialPhase });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!actor.id) { setSnapshot({ identity, issues: [], phase: 'disabled' }); return; }
    if (!featureTogglesReady) { setSnapshot({ identity, issues: [], phase: featureTogglesError ? 'error' : 'loading' }); return; }
    if (!enabled) { setSnapshot({ identity, issues: [], phase: 'disabled' }); return; }
    const controller = new AbortController();
    let active = true, inFlight = false, pending = false;
    const refresh = async () => {
      if (!active) return;
      if (inFlight) { pending = true; return; }
      inFlight = true;
      setSnapshot({ identity, issues: [], phase: 'loading' });
      try {
        const issues = await loadMyQaAssignments(client.list, controller.signal);
        if (active) setSnapshot({ identity, issues, phase: 'ready' });
      } catch {
        if (active && !controller.signal.aborted) setSnapshot({ identity, issues: [], phase: 'error' });
      } finally {
        inFlight = false;
        if (pending && active) { pending = false; void refresh(); }
      }
    };
    const onFocus = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    void refresh();
    window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onFocus);
    const interval = window.setInterval(onFocus, 30000);
    const channel = supabase.channel(`my-assigned-qa:${actor.id}`).on('postgres_changes', { event: '*', schema: 'public', table: 'qa_issues' }, onFocus).subscribe();
    return () => { active = false; controller.abort(); clearInterval(interval); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); void supabase.removeChannel(channel); };
  }, [client, enabled, identity, featureTogglesReady, featureTogglesError, revision]);
  const value = useMemo(() => ({ identity, snapshot, refresh: () => {
    if (!featureTogglesReady) void refreshFeatureToggles();
    setRevision(previous => previous + 1);
  } }), [identity, snapshot, featureTogglesReady, refreshFeatureToggles]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useMyAssignments() {
  const context = useContext(Context);
  const { currentMemberId, currentMember } = useAuthContext();
  const { allTasks, statuses, refreshTasks } = useTaskContext();
  const identityMatches = !!context && context.snapshot.identity === context.identity && context.identity.startsWith(`${currentMemberId}:${currentMember?.role}:`);
  const issues = identityMatches ? context!.snapshot.issues : [];
  const phase = identityMatches ? context!.snapshot.phase : context ? 'loading' : 'disabled';
  const items = useMemo(() => buildMyAssignments(allTasks, statuses, issues, currentMemberId || ''), [allTasks, statuses, issues, currentMemberId]);
  return { items, phase, refresh: () => { void refreshTasks?.(); context?.refresh(); } };
}
