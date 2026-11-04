import { lazy, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/integrations/supabase/client';
import { readWorkspaceProfile } from '@/lib/qa/externalProfile';

const ExternalQaShell = lazy(() => import('./ExternalQaShell'));

const ASSET_SESSION_PATH = '/storage/v1/livo-task-image-session';
const ASSET_RENEW_MS = 4 * 60 * 1000;

function renewLegacyTaskAssets(accessToken: string) {
  const abort = new AbortController();
  const timeout = window.setTimeout(() => abort.abort(), 2_000);
  return fetch(ASSET_SESSION_PATH, {
    method: 'POST', headers: { Authorization: `Bearer ${accessToken}` },
    credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
  }).catch((): undefined => undefined).finally(() => window.clearTimeout(timeout));
}

export default function ExternalQaAccessGate({ internal, accessToken }: { internal: ReactNode; accessToken?: string }) {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<Awaited<ReturnType<typeof readWorkspaceProfile>> | null>(null);
  const [failed, setFailed] = useState(false);
  const [assetsInitialized, setAssetsInitialized] = useState(!accessToken || import.meta.env.MODE !== 'customer');
  const pending = useRef<AbortController>();
  const reload = useCallback(async () => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setFailed(false);
    try {
      const value = await readWorkspaceProfile(request.signal);
      if (!request.signal.aborted) setProfile(value);
    } catch {
      if (!request.signal.aborted) { setProfile(null); setFailed(true); }
    } finally {
      if (pending.current === request) pending.current = undefined;
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => pending.current?.abort();
  }, [reload]);
  useEffect(() => {
    if (!accessToken || import.meta.env.MODE !== 'customer') return;
    let cancelled = false;
    const renew = () => { void renewLegacyTaskAssets(accessToken).then(() => {
      if (!cancelled) setAssetsInitialized(true);
    }); };
    renew();
    const timer = window.setInterval(renew, ASSET_RENEW_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [accessToken]);

  const external = profile?.external === true;
  useEffect(() => {
    if (!external) return;
    const recheck = () => {
      if (!pending.current && document.visibilityState !== 'hidden') void reload();
    };
    window.addEventListener('focus', recheck);
    window.addEventListener('online', recheck);
    document.addEventListener('visibilitychange', recheck);
    const timer = window.setInterval(recheck, 30_000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', recheck);
      window.removeEventListener('online', recheck);
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [external, reload]);

  if (assetsInitialized && profile?.external === false) return <>{internal}</>;
  if (assetsInitialized && profile?.external) {
    const scope = JSON.stringify([profile.id, ...profile.projects.map(project => project.id).sort()]);
    return <ExternalQaShell key={scope} profile={profile} reload={reload} />;
  }
  return <main className="grid min-h-dvh place-items-center px-4 text-foreground">
    <div className="space-y-4 text-center">
      <p role={failed ? 'alert' : 'status'}>{t(failed ? 'qa.externalProfileUnavailable' : 'common.loading')}</p>
      {failed && <div className="flex justify-center gap-3">
        <button type="button" className="rounded border border-border px-4 py-2" onClick={() => void reload()}>{t('common.retry')}</button>
        <button type="button" className="rounded border border-border px-4 py-2" onClick={() => void supabase.auth.signOut()}>{t('auth.logout')}</button>
      </div>}
    </div>
  </main>;
}
