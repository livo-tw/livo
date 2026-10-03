import { SearchableSelect } from '@/components/ui/searchable-select';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIContext } from '@/context/UIContext';
import { useAuthContext } from '@/context/AuthContext';
import { useMemberContext } from '@/context/MemberContext';
import { supabase } from '@/integrations/supabase/client';
import { fnUrl, USE_CF_BACKEND } from '@/lib/apiBase';
import { IS_DEMO_PRO } from '@/lib/demoMode';
import { Button } from '@/components/ui/button';
import { canManageFeatureToggles } from '@/lib/featureToggles';

type Binding = { id: string; display_name: string; memberName: string; active: boolean; verifiedBy?: 'email' | 'admin'; verifiedByOwner?: boolean };
type SlackUser = { id: string; name: string; email: string };
type Status = { connected: boolean; lastSeen: string | null; bindings: Binding[] };
export default function SlackActionsSection() {
  const { t } = useTranslation();
  const { featureToggles, featureTogglesReady } = useUIContext();
  const { currentMember } = useAuthContext();
  const { users } = useMemberContext();
  const visible = featureTogglesReady && featureToggles.slackActions && canManageFeatureToggles(currentMember?.role);
  const canBind = currentMember?.role === 'super_admin';
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slackUsers, setSlackUsers] = useState<SlackUser[] | null>(null);
  const [memberId, setMemberId] = useState('');
  const [slackUserId, setSlackUserId] = useState('');
  const [bindError, setBindError] = useState('');
  const request = useCallback(async (body?: Record<string, unknown>, query = '') => {
    if (IS_DEMO_PRO || USE_CF_BACKEND) return;
    const { data } = await supabase.auth.getSession();
    const response = await fetch(fnUrl('slack-actions-config') + query, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${data.session?.access_token || ''}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'request_failed');
    return response.json();
  }, []);
  const refresh = useCallback(async () => {
    setFailed(false);
    try { setStatus(await request()); } catch { setFailed(true); }
  }, [request]);
  useEffect(() => {
    if (!visible || IS_DEMO_PRO || USE_CF_BACKEND) return;
    void refresh(); const timer = setInterval(() => void refresh(), 30000);
    return () => clearInterval(timer);
  }, [visible, refresh]);
  if (!visible) return null;
  if (USE_CF_BACKEND) return <section className="mx-4 mb-4 space-y-3 rounded-lg border border-border bg-background p-4" aria-labelledby="slack-actions-title">
    <h3 id="slack-actions-title" className="text-sm font-semibold">{t('slackActions.title')}</h3>
    <p className="text-sm text-muted-foreground">{t('qa.slackCloud')}</p>
    <p className="text-sm text-muted-foreground">{t('qa.slackGate')}</p>
    <p className="text-sm text-muted-foreground">{t('qa.slackUsage')}</p>
    {IS_DEMO_PRO && <p className="text-sm text-muted-foreground">{t('slackActions.demo')}</p>}
  </section>;
  const unbind = async (id: string) => {
    setBusy(true); setFailed(false);
    try { await request({ action: 'unbind', id }); await refresh(); } catch { setFailed(true); }
    finally { setBusy(false); }
  };
  const assignable = canBind ? users.filter(u => u.isActive) : [];
  const loadSlackUsers = async () => {
    setBusy(true); setBindError('');
    try { setSlackUsers((await request(undefined, '?slackUsers=1')).users); } catch { setBindError(t('slackActions.manual.loadFailed')); }
    finally { setBusy(false); }
  };
  const bind = async () => {
    if (!memberId || !slackUserId) return;
    setBusy(true); setBindError('');
    try {
      await request({ action: 'bind', memberId, slackUserId });
      setMemberId(''); setSlackUserId(''); await refresh();
    } catch (error) {
      const code = (error as Error).message;
      setBindError(t(code === 'member_not_assignable' ? 'slackActions.manual.notAssignable'
        : code === 'slack_user_belongs_to_other' ? 'slackActions.manual.otherOwner' : 'slackActions.manual.failed'));
    } finally { setBusy(false); }
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
        <span>{binding.display_name} → {binding.memberName}{!binding.active && ` (${t('slackActions.inactive')})`}
          <span className="ml-2 text-xs text-muted-foreground">{t(binding.verifiedBy === 'admin' ? 'slackActions.manual.byAdmin' : 'slackActions.manual.byEmail')}</span></span>
        {binding.verifiedBy === 'admin' && !binding.verifiedByOwner && <span className="text-xs text-amber-700">{t('slackActions.manual.reconfirm')}</span>}
        <Button size="sm" variant="outline" disabled={busy || !canBind} onClick={() => void unbind(binding.id)}>{t('slackActions.unbind')}</Button>
      </div>)}
    </div>}
    {!IS_DEMO_PRO && !canBind && <p className="text-xs text-muted-foreground">{t('slackActions.manual.ownerOnly')}</p>}
    {!IS_DEMO_PRO && canBind && <div className="space-y-2 border-t border-border pt-3">
      <h4 className="text-sm font-medium">{t('slackActions.manual.title')}</h4>
      <p className="text-xs text-muted-foreground">{t('slackActions.manual.hint')}</p>
      {slackUsers === null
        ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void loadSlackUsers()}>{t('slackActions.manual.load')}</Button>
        : <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <SearchableSelect aria-label={t('slackActions.manual.member')} value={memberId} onChange={e => setMemberId(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1.5 text-sm">
            <option value="">{t('slackActions.manual.member')}</option>
            {assignable.map(u => <option key={u.id} value={u.id}>{u.name}{u.email ? ` · ${u.email}` : ''}</option>)}
          </SearchableSelect>
          <SearchableSelect aria-label={t('slackActions.manual.slackUser')} value={slackUserId} onChange={e => setSlackUserId(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1.5 text-sm">
            <option value="">{t('slackActions.manual.slackUser')}</option>
            {slackUsers.map(u => <option key={u.id} value={u.id}>{u.name}{u.email ? ` · ${u.email}` : ''}</option>)}
          </SearchableSelect>
          <Button size="sm" disabled={busy || !memberId || !slackUserId} onClick={() => void bind()}>{t('slackActions.manual.bind')}</Button>
        </div>}
      {bindError && <p role="alert" className="text-sm text-destructive">{bindError}</p>}
    </div>}
  </section>;
}
