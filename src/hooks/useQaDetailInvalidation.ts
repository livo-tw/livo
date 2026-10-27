import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, USING_MOCK_BACKEND } from '@/integrations/supabase/client';
import type { QaDetail } from '@/lib/qa/domain';

// Events only invalidate a read. Detail contents and permissions always come from get().
export function useQaDetailInvalidation({ issueId, scope, blocked, isBlocked, load, apply }: {
  issueId: string; scope: number; blocked: boolean; isBlocked: () => boolean;
  load: (signal: AbortSignal) => Promise<QaDetail>; apply: (detail: QaDetail) => void;
}) {
  const latest = useRef({ isBlocked, load, apply }); latest.current = { isBlocked, load, apply };
  const controls = useRef<{ resume: () => void; acknowledge: () => void }>();
  const [state, setState] = useState<{ scope: number; pending: boolean; error: unknown }>({ scope, pending: false, error: null });
  useEffect(() => {
    if (!issueId) return;
    let active = true, pending = false, running = false, sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
    const publish = (error: unknown = null) => { if (active) setState({ scope, pending, error }); };
    const visible = () => document.visibilityState !== 'hidden';
    const run = async () => {
      timer = undefined;
      if (!active || !pending || running || !visible() || latest.current.isBlocked()) return;
      pending = false; running = true;
      const readSequence = ++sequence;
      controller = new AbortController();
      try {
        const value = await latest.current.load(controller.signal);
        if (!active || readSequence !== sequence) return;
        if (latest.current.isBlocked()) pending = true;
        else latest.current.apply(value);
        publish();
      } catch (error) { if (active && readSequence === sequence) publish(error); }
      finally {
        if (active && readSequence === sequence) {
          running = false;
          if (pending && !latest.current.isBlocked() && visible()) schedule();
        }
      }
    };
    const schedule = () => { if (!timer && !running && visible() && !latest.current.isBlocked()) timer = setTimeout(() => void run(), 50); };
    const invalidate = () => { if (!active || !visible()) return; pending = true; publish(); schedule(); };
    const acknowledge = () => {
      ++sequence; controller?.abort(); running = false; pending = false;
      if (timer) clearTimeout(timer); timer = undefined; publish();
    };
    controls.current = { resume: schedule, acknowledge };
    publish();
    window.addEventListener('focus', invalidate);
    window.addEventListener('online', invalidate);
    window.addEventListener('livo:qa-changed', invalidate);
    document.addEventListener('visibilitychange', invalidate);
    // Self-hosted instances may have no QA realtime publication. Visible polling
    // also recovers a missed event while a browser or VPN was disconnected.
    const poll = setInterval(invalidate, 30_000);
    let subscribed = false;
    const channel = !USING_MOCK_BACKEND && typeof supabase.channel === 'function' ? supabase.channel(`qa-detail:${scope}:${issueId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'qa_issues', filter: `id=eq.${issueId}` }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'qa_comments', filter: `issue_id=eq.${issueId}` }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'qa_events', filter: `issue_id=eq.${issueId}` }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'qa_attachments', filter: `issue_id=eq.${issueId}` }, invalidate)
      .subscribe(status => { if (status === 'SUBSCRIBED') { if (subscribed) invalidate(); subscribed = true; } }) : null;
    return () => {
      active = false; ++sequence; controller?.abort(); controls.current = undefined;
      if (timer) clearTimeout(timer); clearInterval(poll);
      window.removeEventListener('focus', invalidate); window.removeEventListener('online', invalidate);
      window.removeEventListener('livo:qa-changed', invalidate); document.removeEventListener('visibilitychange', invalidate);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [issueId, scope]);
  useEffect(() => { if (!blocked) controls.current?.resume(); }, [blocked, scope]);
  const acknowledge = useCallback(() => controls.current?.acknowledge(), []);
  return { pending: state.scope === scope && state.pending, error: state.scope === scope ? state.error : null,
    acknowledge };
}
