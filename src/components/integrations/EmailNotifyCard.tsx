// Email (Resend) self-bind card (系統管理 → 整合).
//
// Lets a LIVO admin connect their OWN Resend account: paste an API key +
// from-address → verified + stored server-side (email_config, never returned).
// Backend contract (fn 'email-config'):
//   GET  /api/functions/email-config → { configured, source: 'app'|'env'|null, fromAddress }
//   POST /api/functions/email-config { apiKey, fromAddress } → { ok, error?, message? }
//   (empty apiKey disconnects; POST is admin-JWT gated + demo-blocked)
//
// Structure mirrors SlackCard. Not license-gated: the whole IntegrationsView
// is already admin-only, and the backend enforces admin/demo itself.

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Mail, Loader2, CheckCircle2, ChevronDown, ChevronRight,
  Unlink, ExternalLink, AlertCircle, Link2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useLicense } from '@/context/LicenseContext';
import { authGetJson, authPostJson } from './fnFetch';
import { Field, inputCls } from './shared';

interface EmailStatus {
  configured: boolean;
  source: 'app' | 'env' | null;
  fromAddress: string | null;
}

const EmailNotifyCard = () => {
  const { t } = useTranslation();
  const { isDemoMode } = useLicense();

  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [reconfiguring, setReconfiguring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const fetchStatus = useCallback(async () => {
    let s: EmailStatus = { configured: false, source: null, fromAddress: null };
    try {
      const { resp, body } = await authGetJson<Partial<EmailStatus>>('email-config');
      if (resp.ok) {
        s = {
          configured: !!body.configured,
          source: body.source ?? null,
          fromAddress: body.fromAddress ?? null,
        };
      }
    } catch {
      /* keep default not-configured */
    }
    setStatus(s);
  }, []);

  useEffect(() => {
    if (isDemoMode) {
      setLoadingStatus(false);
      return;
    }
    let alive = true;
    void (async () => {
      await fetchStatus();
      if (alive) setLoadingStatus(false);
    })();
    return () => { alive = false; };
  }, [isDemoMode, fetchStatus]);

  const connect = async () => {
    const key = apiKey.trim();
    const from = fromAddress.trim();
    if (!key || !from) return;
    setError(null);
    setConnecting(true);
    try {
      const { resp, body } = await authPostJson<{ ok?: boolean; error?: string; message?: string }>(
        'email-config', { apiKey: key, fromAddress: from },
      );
      if (resp.ok && body.ok) {
        setStatus({ configured: true, source: 'app', fromAddress: from });
        setApiKey('');
        setReconfiguring(false);
        toast.success(t('integrations.emailNotify.connected'));
      } else {
        setError(body.message || body.error || t('integrations.emailNotify.connectFailedGeneric'));
      }
    } catch {
      setError(t('integrations.emailNotify.connectFailedGeneric'));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    setError(null);
    setDisconnecting(true);
    try {
      const { resp, body } = await authPostJson<{ ok?: boolean; error?: string; message?: string }>(
        'email-config', { apiKey: '', fromAddress: '' },
      );
      if (resp.ok && body.ok) {
        setStatus({ configured: false, source: null, fromAddress: null });
        setReconfiguring(false);
        toast.success(t('integrations.emailNotify.disconnected'));
      } else {
        setError(body.message || body.error || t('integrations.emailNotify.connectFailedGeneric'));
      }
    } catch {
      setError(t('integrations.emailNotify.connectFailedGeneric'));
    } finally {
      setDisconnecting(false);
    }
  };

  const configured = !!status?.configured;
  const envSource = status?.source === 'env';
  const showConnected = configured && !reconfiguring;

  return (
    <div className={`border rounded-lg overflow-hidden ${configured ? 'border-green-500/30 bg-green-500/5' : 'border-border bg-card'}`}>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className={`flex-shrink-0 ${configured ? 'text-green-500' : 'text-muted-foreground'}`}>
          <Mail size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-foreground">{t('integrations.emailNotify.title')}</span>
            {configured && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 font-medium">
                {t('integrations.emailNotify.connectedBadge')}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{t('integrations.emailNotify.desc')}</p>
        </div>
      </div>

      {/* Body */}
      <div className="px-4 pb-4 border-t border-border">
        <div className="pt-4 space-y-4">
          {loadingStatus ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 size={14} className="animate-spin" />
              {t('common.loading')}
            </div>
          ) : (
            <>
              {showConnected ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <CheckCircle2 size={16} className="text-green-500 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {envSource
                          ? t('integrations.emailNotify.connectedViaEnv')
                          : t('integrations.emailNotify.connectedBadge')}
                      </div>
                      {status?.fromAddress && (
                        <div className="text-xs text-muted-foreground truncate">
                          {t('integrations.emailNotify.connectedFrom', { from: status.fromAddress })}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => { setReconfiguring(true); setApiKey(''); setFromAddress(status?.fromAddress || ''); setError(null); }}
                      className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    >
                      {t('integrations.emailNotify.reconfigure')}
                    </button>
                    {!envSource && (
                      <button
                        type="button"
                        onClick={disconnect}
                        disabled={disconnecting}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-border text-destructive hover:bg-destructive/10 disabled:opacity-40 transition-colors"
                      >
                        {disconnecting ? <Loader2 size={12} className="animate-spin" /> : <Unlink size={12} />}
                        {t('integrations.emailNotify.disconnect')}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <Field label={t('integrations.emailNotify.apiKeyLabel')}>
                    <input
                      type="password"
                      className={inputCls}
                      placeholder={t('integrations.emailNotify.apiKeyPlaceholder')}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      disabled={isDemoMode || connecting}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </Field>
                  <Field label={t('integrations.emailNotify.fromLabel')}>
                    <input
                      type="email"
                      className={inputCls}
                      placeholder={t('integrations.emailNotify.fromPlaceholder')}
                      value={fromAddress}
                      onChange={(e) => setFromAddress(e.target.value)}
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
                    <p className="text-xs text-amber-600 dark:text-amber-400">{t('integrations.emailNotify.demoDisabled')}</p>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={connect}
                      disabled={isDemoMode || connecting || !apiKey.trim() || !fromAddress.trim()}
                      className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                    >
                      {connecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                      {t('integrations.emailNotify.connectVerify')}
                    </button>
                    {reconfiguring && (
                      <button
                        type="button"
                        onClick={() => { setReconfiguring(false); setApiKey(''); setError(null); }}
                        className="px-3 py-1.5 text-xs rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      >
                        {t('integrations.emailNotify.cancel')}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Setup guide */}
              <div>
                <button
                  type="button"
                  onClick={() => setGuideOpen((o) => !o)}
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  {guideOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {t('integrations.emailNotify.guideToggle')}
                </button>
                {guideOpen && (
                  <div className="mt-2 rounded-md bg-muted/40 border border-border px-3 py-3 space-y-3">
                    <ol className="space-y-2.5 text-xs text-muted-foreground leading-relaxed list-decimal list-inside">
                      <li>{t('integrations.emailNotify.guideStep1')}</li>
                      <li>{t('integrations.emailNotify.guideStep2')}</li>
                      <li>{t('integrations.emailNotify.guideStep3')}</li>
                    </ol>
                    <p className="text-xs text-muted-foreground">{t('integrations.emailNotify.guideFreeTier')}</p>
                    <a
                      href="https://resend.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <ExternalLink size={12} />
                      {t('integrations.emailNotify.guideOpenResend')}
                    </a>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default EmailNotifyCard;
