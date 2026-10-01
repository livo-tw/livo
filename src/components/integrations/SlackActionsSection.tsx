import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIContext } from '@/context/UIContext';
import { useAuthContext } from '@/context/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { fnUrl, USE_CF_BACKEND } from '@/lib/apiBase';
import { IS_DEMO_PRO } from '@/lib/demoMode';
import { Button } from '@/components/ui/button';
import { canManageFeatureToggles } from '@/lib/featureToggles';

type Binding = { id: string; display_name: string; memberName: string; active: boolean };
type Status = { connected: boolean; lastSeen: string | null; bindings: Binding[] };
export default function SlackActionsSection() {
  const { t } = useTranslation();
  const { featureToggles, featureTogglesReady } = useUIContext();
  const { currentMember } = useAuthContext();
  const visible = featureTogglesReady && featureToggles.slackActions && !USE_CF_BACKEND && canManageFeatureToggles(currentMember?.role);
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const request = useCallback(async (body?: { action: string; id: string }) => {
    if (IS_DEMO_PRO) return;
    const { data } = await supabase.auth.getSession();
    const response = await fetch(fnUrl('slack-actions-config'), { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${data.session?.access_token || ''}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error('request_failed');
    return response.json();
  }, []);
  const refresh = useCallback(async () => {
    setFailed(false);
    try { setStatus(await request()); } catch { setFailed(true); }
  }, [request]);
  useEffect(() => {
    if (!visible || IS_DEMO_PRO) return;
    void refresh(); const timer = setInterval(() => void refresh(), 30000);
    return () => clearInterval(timer);
  }, [visible, refresh]);
  if (!visible) return null;
  const unbind = async (id: string) => {
    setBusy(true); setFailed(false);
    try { await request({ action: 'unbind', id }); await refresh(); } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  return <section className="mx-4 mb-4 space-y-3 rounded-lg border border-border bg-background p-4" aria-labelledby="slack-actions-title">
    <h3 id="slack-actions-title" className="text-sm font-semibold">{t('slackActions.title')}</h3>
    {IS_DEMO_PRO ? <p className="text-sm text-muted-foreground">{t('slackActions.demo')}</p> : <>
      <p role="status" className="text-sm">{t(status?.connected ? 'slackActions.connected' : 'slackActions.disconnected')}</p>
      {status?.lastSeen && <p className="text-xs text-muted-foreground">{t('slackActions.lastSeen', { date: new Date(status.lastSeen).toLocaleString() })}</p>}
      <Button size="sm" variant="outline" onClick={() => void refresh()}>{t('slackActions.refresh')}</Button>
    </>}
    <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
      {['bot', 'socket', 'commands', 'env', 'accounts'].map(key => <li key={key}>{t(`slackActions.setup.${key}`)}</li>)}
    </ol>
    <p className="text-xs text-muted-foreground">{t('slackActions.usage')}</p>
    {failed && <p role="alert" className="text-sm text-destructive">{t('slackActions.failed')}</p>}
    {!IS_DEMO_PRO && <div className="space-y-2"><h4 className="text-sm font-medium">{t('slackActions.accounts')}</h4>
      {status && !status.bindings.length && <p className="text-sm text-muted-foreground">{t('slackActions.empty')}</p>}
      {status?.bindings.map(binding => <div key={binding.id} className="flex items-center justify-between gap-3 rounded border border-border p-2 text-sm">
        <span>{binding.display_name} → {binding.memberName}{!binding.active && ` (${t('slackActions.inactive')})`}</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void unbind(binding.id)}>{t('slackActions.unbind')}</Button>
      </div>)}
    </div>}
  </section>;
}
