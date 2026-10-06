import { useConfirmDialog } from '@/components/ConfirmDialog';
import { SearchableSelect } from '@/components/ui/searchable-select';
// Slack self-bind card (系統管理 → 整合).
//
// Replaces the old incoming-webhook card. Lets a LIVO admin connect their OWN
// Slack workspace from the app: paste a bot token → verified + stored server-side
// (slack_config, never returned), pick a task-notify channel, and read a setup
// guide. Backend contract (worker/src/functions/slack.ts):
//   GET  /api/functions/slack-config   → { configured, source, team, configuredAt? }
//   POST /api/functions/slack-config   {token}  → set / (empty) disconnect
//   POST /api/functions/slack-channels {}       → { channels } | { error }
// slack-config POST is admin-JWT gated + demo-blocked (403 「展示帳號無法執行此操作」).
//
// Gated behind the `slack-notify` professional feature, exactly like
// AdminNotifySection. Cloud uses backup_settings.task_notify_channel; self-host
// task and QA pickers read and save the actual system_settings.slack_delivery routes.

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Slack, Loader2, CheckCircle2, ChevronDown, ChevronRight,
  Unlink, ExternalLink, AlertCircle, Link2,
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useLicense } from '@/context/LicenseContext';
import { fnUrl, USE_CF_BACKEND } from '@/lib/apiBase';
import UpgradePrompt from '@/components/UpgradePrompt';
import { Field, inputCls } from './shared';
import SlackActionsSection from './SlackActionsSection';
import SlackDeliveryChannels from './SlackDeliveryChannels';
import SlackPersonalMessages from './SlackPersonalMessages';

// The 7 Bot Token Scopes needed for channel posts, DMs and user lookup.
// These are literal Slack scope identifiers — not translated.
const BOT_SCOPES = [
  'chat:write',
  'chat:write.customize',
  'channels:read',
  'groups:read',
  'im:write',
  'users:read',
  'users:read.email',
];

interface SlackStatus {
  configured: boolean;
  source: 'app' | 'env' | null;
  team: string | null;
  configuredAt?: string;
}

interface SlackChannel {
  id: string;
  name: string;
  // Contract field: false → bot hasn't joined, must be /invite'd first.
  // (Deployed worker may instead send is_private; absence → no invite warning.)
  is_member?: boolean;
  is_private?: boolean;
}

/** Authenticated fetch to a backend function — works for both CF + legacy backends. */
async function authFetch(fnName: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token ?? '';
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(fnUrl(fnName), { ...init, headers });
}

const SlackCard = () => {
  const { t } = useTranslation();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const { hasFeature, isDemoMode } = useLicense();
  const gated = !hasFeature('slack-notify');

  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [reconfiguring, setReconfiguring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [channelValue, setChannelValue] = useState('');
  const [channelRowId, setChannelRowId] = useState<string | null>(null);
  const [savingChannel, setSavingChannel] = useState(false);

  const loadChannels = useCallback(async () => {
    setChannelsError(null);
    try {
      const resp = await authFetch('slack-channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await resp.json().catch(() => ({}))) as { channels?: SlackChannel[]; error?: string };
      if (body.error) {
        setChannels(null);
        setChannelsError(body.error);
        return;
      }
      setChannels(Array.isArray(body.channels) ? body.channels : []);
    } catch {
      setChannels(null);
      setChannelsError('load_failed');
    }
  }, []);

  const fetchStatus = useCallback(async (): Promise<SlackStatus> => {
    let s: SlackStatus = { configured: false, source: null, team: null };
    try {
      const resp = await authFetch('slack-config', { method: 'GET' });
      const body = (await resp.json().catch(() => ({}))) as Partial<SlackStatus>;
      if (resp.ok) {
        s = {
          configured: !!body.configured,
          source: body.source ?? null,
          team: body.team ?? null,
          configuredAt: body.configuredAt,
        };
      }
    } catch {
      /* keep default not-configured */
    }
    setStatus(s);
    return s;
  }, []);

  useEffect(() => {
    if (gated || isDemoMode) {
      setLoadingStatus(false);
      return;
    }
    let alive = true;
    void (async () => {
      const s = await fetchStatus();
      if (!alive) return;
      if (s.configured) void loadChannels();
      if (!USE_CF_BACKEND) { setLoadingStatus(false); return; }
      const { data } = await supabase
        .from('backup_settings')
        .select('id, task_notify_channel')
        .limit(1)
        .maybeSingle();
      if (alive && data) {
        setChannelRowId(data.id);
        setChannelValue(((data.task_notify_channel as string) || '').replace(/^#/, ''));
      }
      if (alive) setLoadingStatus(false);
    })();
    return () => { alive = false; };
  }, [gated, isDemoMode, fetchStatus, loadChannels]);

  const connect = async () => {
    const tk = token.trim();
    if (!tk) return;
    setError(null);
    setConnecting(true);
    try {
      const resp = await authFetch('slack-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tk }),
      });
      const body = (await resp.json().catch(() => ({}))) as {
        ok?: boolean; configured?: boolean; team?: string; error?: string; message?: string;
      };
      if (resp.ok && body.ok && body.configured) {
        setStatus({ configured: true, source: 'app', team: body.team ?? null });
        setToken('');
        setReconfiguring(false);
        toast.success(t('integrations.slack.connectedTo', { team: body.team || 'Slack' }));
        void loadChannels();
      } else {
        setError(body.message || body.error || t('integrations.slack.connectFailedGeneric'));
      }
    } catch {
      setError(t('integrations.slack.connectFailedGeneric'));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    // Disconnecting stops every Slack notice, digest and Slack action for the workspace.
    if (!(await confirm({ title: t('integrations.slack.disconnectTitle'), description: t('integrations.slack.disconnectConfirm'), destructive: true }))) return;
    setError(null);
    setDisconnecting(true);
    try {
      const resp = await authFetch('slack-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '' }),
      });
      const body = (await resp.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (resp.ok && body.ok) {
        setStatus({ configured: false, source: null, team: null });
        setChannels(null);
        setChannelsError(null);
        setReconfiguring(false);
        toast.success(t('integrations.slack.disconnected'));
      } else {
        setError(body.message || body.error || t('integrations.slack.connectFailedGeneric'));
      }
    } catch {
      setError(t('integrations.slack.connectFailedGeneric'));
    } finally {
      setDisconnecting(false);
    }
  };

  const saveChannel = async (value: string) => {
    setChannelValue(value);
    if (!channelRowId) return;
    setSavingChannel(true);
    const { error: saveErr } = await supabase
      .from('backup_settings')
      .update({ task_notify_channel: value })
      .eq('id', channelRowId);
    setSavingChannel(false);
    if (saveErr) toast.error(t('integrations.saveFailed') + saveErr.message);
    else toast.success(t('integrations.slack.channelSaved'));
  };

  const configured = !!status?.configured;
  const envSource = status?.source === 'env';
  const showConnected = configured && !reconfiguring;

  const channelNames = new Set((channels ?? []).map((c) => c.name));
  const showRawOption = !!channelValue && !channelNames.has(channelValue);
  const selectedNeedsInvite = (channels ?? []).some((c) => c.name === channelValue && c.is_member === false);
  const pickerDisabled = isDemoMode || !configured || channelsError === 'slack_not_configured' || savingChannel;

  let pickerHint = t('integrations.slack.channelPickerHint');
  if (!configured || channelsError === 'slack_not_configured') pickerHint = t('integrations.slack.channelNotConfigured');
  else if (channelsError) pickerHint = t('integrations.slack.channelLoadError');

  return (
    <div className={`border rounded-lg overflow-hidden ${configured ? 'border-green-500/30 bg-green-500/5' : 'border-border bg-card'}`}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className={`flex-shrink-0 ${configured ? 'text-green-500' : 'text-muted-foreground'}`}>
          <Slack size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-foreground">{t('integrations.slack.title')}</span>
            {configured && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 font-medium">
                {t('integrations.slack.connectedBadge')}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{t('integrations.slack.desc')}</p>
        </div>
      </div>

      {/* Body */}
      <div className="px-4 pb-4 border-t border-border">
        <div className="pt-4 space-y-4">
          {gated ? (
            <UpgradePrompt feature="slack-notify" inline />
          ) : loadingStatus ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 size={14} className="animate-spin" />
              {t('common.loading')}
            </div>
          ) : (
            <>
              {/* Connect / connected state */}
              {showConnected ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <CheckCircle2 size={16} className="text-green-500 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {envSource
                          ? t('integrations.slack.connectedViaEnv')
                          : t('integrations.slack.connectedTo', { team: status?.team || 'Slack' })}
                      </div>
                      {status?.configuredAt && !envSource && (
                        <div className="text-xs text-muted-foreground">
                          {t('integrations.slack.configuredAt', { date: new Date(status.configuredAt).toLocaleString() })}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => { setReconfiguring(true); setToken(''); setError(null); }}
                      className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    >
                      {t('integrations.slack.reconfigure')}
                    </button>
                    {!envSource && (
                      <button
                        type="button"
                        onClick={disconnect}
                        disabled={disconnecting}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-border text-destructive hover:bg-destructive/10 disabled:opacity-40 transition-colors"
                      >
                        {disconnecting ? <Loader2 size={12} className="animate-spin" /> : <Unlink size={12} />}
                        {t('integrations.slack.disconnect')}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <Field label={t('integrations.slack.tokenLabel')}>
                    <input
                      type="password"
                      className={inputCls}
                      placeholder={t('integrations.slack.tokenPlaceholder')}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      disabled={isDemoMode || connecting}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  {error && (
                    <p className="text-xs text-destructive flex items-start gap-1">
                      <AlertCircle size={12} className="mt-0.5 shrink-0" />
                      <span>{error}</span>
                    </p>
                  )}
                  {isDemoMode && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">{t('integrations.slack.demoDisabled')}</p>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={connect}
                      disabled={isDemoMode || connecting || !token.trim()}
                      className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                    >
                      {connecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                      {t('integrations.slack.connectVerify')}
                    </button>
                    {reconfiguring && (
                      <button
                        type="button"
                        onClick={() => { setReconfiguring(false); setToken(''); setError(null); }}
                        className="px-3 py-1.5 text-xs rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      >
                        {t('integrations.slack.cancel')}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Each backend uses its real notification settings. */}
              {!USE_CF_BACKEND ? <>
                <SlackDeliveryChannels configured={configured} isDemoMode={isDemoMode}
                  channels={channels} channelsError={channelsError} />
                <SlackPersonalMessages configured={configured} isDemoMode={isDemoMode} />
              </> : <Field label={t('integrations.slack.channelPickerLabel')}>
                <SearchableSelect
                  className={inputCls}
                  value={channelValue}
                  onChange={(e) => saveChannel(e.target.value)}
                  disabled={pickerDisabled}
                >
                  <option value="">{t('integrations.slack.channelNone')}</option>
                  {showRawOption && <option value={channelValue}>#{channelValue}</option>}
                  {(channels ?? []).map((ch) => (
                    <option key={ch.id} value={ch.name}>
                      #{ch.name}
                    </option>
                  ))}
                </SearchableSelect>
                <p className="text-xs text-muted-foreground mt-1">{pickerHint}</p>
                {selectedNeedsInvite && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    {t('integrations.slack.channelNeedInvite')}
                  </p>
                )}
              </Field>}

              {/* Setup guide */}
              <div>
                <button
                  type="button"
                  onClick={() => setGuideOpen((o) => !o)}
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  {guideOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {t('integrations.slack.guideToggle')}
                </button>
                {guideOpen && (
                  <div className="mt-2 rounded-md bg-muted/40 border border-border px-3 py-3 space-y-3">
                    <ol className="space-y-2.5 text-xs text-muted-foreground leading-relaxed list-decimal list-inside">
                      <li>{t('integrations.slack.guideStep1')}</li>
                      <li>
                        {t('integrations.slack.guideStep2')}
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {BOT_SCOPES.map((s) => (
                            <code key={s} className="bg-muted rounded px-1.5 py-0.5 text-[11px] text-foreground">
                              {s}
                            </code>
                          ))}
                        </div>
                      </li>
                      <li>{t('integrations.slack.guideStep3')}</li>
                      <li>{t('integrations.slack.guideStep4')}</li>
                    </ol>
                    <a
                      href="https://api.slack.com/apps"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <ExternalLink size={12} />
                      {t('integrations.slack.guideOpenApps')}
                    </a>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <SlackActionsSection />
      {ConfirmDialog}
    </div>
  );
};

export default SlackCard;
