// Server-side outbound webhooks admin card (系統管理 → 整合).
//
// Unlike the legacy WebhookCard (single team_settings URL fired from the
// browser), these webhooks are stored server-side and dispatched by the
// worker with an HMAC signature. Backend contract (fn 'webhooks'):
//   GET  → { webhooks: [{ id, url, events, enabled, last_status, last_sent_at }] }
//   POST { action:'create', url, events:[...] } → { ok, id, secret }  (secret shown ONCE)
//   POST { action:'toggle'|'delete', id }       → { ok }
//
// Structure mirrors SlackCard; admin-only via IntegrationsView + server checks.

import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Webhook, Loader2, Plus, Trash2, Copy, AlertTriangle, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useLicense } from '@/context/LicenseContext';
import { authGetJson, authPostJson } from './fnFetch';
import { Field, Toggle, inputCls } from './shared';

export interface ServerWebhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  last_status: number | string | null;
  last_sent_at: string | null;
}

const EVENT_OPTIONS = [
  { value: 'task_created',  labelKey: 'integrations.webhooks.events.taskCreated' },
  { value: 'task_updated',  labelKey: 'integrations.webhooks.events.taskUpdated' },
  { value: 'task_deleted',  labelKey: 'integrations.webhooks.events.taskDeleted' },
  { value: 'comment_added', labelKey: 'integrations.webhooks.events.commentAdded' },
];

const WebhooksCard = () => {
  const { t } = useTranslation();
  const { isDemoMode } = useLicense();

  const [webhooks, setWebhooks] = useState<ServerWebhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // Create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newEvents, setNewEvents] = useState<string[]>(EVENT_OPTIONS.map(e => e.value));
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Secret reveal (shown ONCE right after create)
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const { resp, body } = await authGetJson<{ webhooks?: ServerWebhook[]; error?: string }>('webhooks');
      if (resp.ok && Array.isArray(body.webhooks)) setWebhooks(body.webhooks);
      else setLoadError(true);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    if (isDemoMode) {
      setLoading(false);
      return;
    }
    let alive = true;
    void (async () => {
      await load();
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [isDemoMode, load]);

  const openCreate = () => {
    setNewUrl('');
    setNewEvents(EVENT_OPTIONS.map(e => e.value));
    setCreateError(null);
    setShowCreate(true);
  };

  const create = async () => {
    const url = newUrl.trim();
    if (!/^https?:\/\/.+/.test(url)) {
      setCreateError(t('integrations.webhooks.invalidUrl'));
      return;
    }
    if (newEvents.length === 0) {
      setCreateError(t('integrations.webhooks.noEvents'));
      return;
    }
    setCreateError(null);
    setCreating(true);
    try {
      const { resp, body } = await authPostJson<{ ok?: boolean; id?: string; secret?: string; error?: string; message?: string }>(
        'webhooks', { action: 'create', url, events: newEvents },
      );
      if (resp.ok && body.ok && body.secret) {
        setShowCreate(false);
        setCreatedSecret(body.secret);
        void load();
      } else {
        setCreateError(body.message || body.error || t('integrations.webhooks.createFailed'));
      }
    } catch {
      setCreateError(t('integrations.webhooks.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (wh: ServerWebhook) => {
    setBusyId(wh.id);
    // Optimistic flip; revert on failure
    setWebhooks(prev => prev.map(w => w.id === wh.id ? { ...w, enabled: !w.enabled } : w));
    try {
      const { resp, body } = await authPostJson<{ ok?: boolean; error?: string }>('webhooks', { action: 'toggle', id: wh.id });
      if (!resp.ok || !body.ok) throw new Error(body.error || 'toggle failed');
    } catch {
      setWebhooks(prev => prev.map(w => w.id === wh.id ? { ...w, enabled: wh.enabled } : w));
      toast.error(t('integrations.webhooks.toggleFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      const { resp, body } = await authPostJson<{ ok?: boolean; error?: string }>('webhooks', { action: 'delete', id });
      if (resp.ok && body.ok) {
        setWebhooks(prev => prev.filter(w => w.id !== id));
        toast.success(t('integrations.webhooks.deleted'));
      } else {
        toast.error(t('integrations.webhooks.deleteFailed'));
      }
    } catch {
      toast.error(t('integrations.webhooks.deleteFailed'));
    } finally {
      setBusyId(null);
      setConfirmDeleteId(null);
    }
  };

  const copySecret = async () => {
    if (!createdSecret) return;
    try {
      await navigator.clipboard.writeText(createdSecret);
      toast.success(t('integrations.webhooks.copied'));
    } catch {
      /* clipboard unavailable — user can select the text manually */
    }
  };

  const renderLastStatus = (wh: ServerWebhook) => {
    if (wh.last_status == null) return <span className="text-muted-foreground">{t('integrations.webhooks.neverSent')}</span>;
    // Self-host dispatches via pg_net (async fire-and-forget) — it can only
    // record 'queued', never the real HTTP status. Neutral, not a failure.
    if (wh.last_status === 'queued') {
      return (
        <span className="text-muted-foreground">
          {t('integrations.webhooks.statusQueued')}
          {wh.last_sent_at && (
            <span> · {t('integrations.webhooks.lastSentAt', { date: new Date(wh.last_sent_at).toLocaleString() })}</span>
          )}
        </span>
      );
    }
    const code = Number(wh.last_status);
    const ok = code >= 200 && code < 300;
    return (
      <span className={ok ? 'text-green-600 dark:text-green-400' : 'text-destructive'}>
        {ok
          ? t('integrations.webhooks.statusOk', { status: wh.last_status })
          : t('integrations.webhooks.statusFail', { status: wh.last_status })}
        {wh.last_sent_at && (
          <span className="text-muted-foreground"> · {t('integrations.webhooks.lastSentAt', { date: new Date(wh.last_sent_at).toLocaleString() })}</span>
        )}
      </span>
    );
  };

  const eventLabel = (value: string) => {
    const opt = EVENT_OPTIONS.find(o => o.value === value);
    return opt ? t(opt.labelKey) : value;
  };

  return (
    <div className="border border-border bg-card rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-shrink-0 text-muted-foreground">
          <Webhook size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-sm text-foreground">{t('integrations.webhooks.title')}</span>
          <p className="text-xs text-muted-foreground mt-0.5">{t('integrations.webhooks.desc')}</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          disabled={isDemoMode}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors flex-shrink-0"
        >
          <Plus size={13} />
          {t('integrations.webhooks.addButton')}
        </button>
      </div>

      {/* Body */}
      <div className="px-4 pb-4 border-t border-border">
        <div className="pt-4 space-y-3">
          {isDemoMode ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t('integrations.webhooks.demoDisabled')}</p>
          ) : loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 size={14} className="animate-spin" />
              {t('common.loading')}
            </div>
          ) : loadError ? (
            <p className="text-xs text-destructive">{t('integrations.webhooks.loadFailed')}</p>
          ) : webhooks.length === 0 ? (
            <p className="text-sm text-muted-foreground py-1">{t('integrations.webhooks.empty')}</p>
          ) : (
            <div className="space-y-2">
              {webhooks.map(wh => (
                <div key={wh.id} className="rounded-md border border-border px-3 py-2.5 space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-foreground truncate" title={wh.url}>{wh.url}</span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <Toggle value={wh.enabled} onChange={() => { if (busyId !== wh.id) void toggle(wh); }} />
                      {confirmDeleteId === wh.id ? (
                        <div className="flex items-center gap-1 text-xs">
                          <button
                            type="button"
                            onClick={() => void remove(wh.id)}
                            disabled={busyId === wh.id}
                            className="px-2 py-1 rounded bg-destructive text-destructive-foreground text-xs font-medium disabled:opacity-50"
                          >
                            {busyId === wh.id ? <Loader2 size={12} className="animate-spin" /> : t('integrations.webhooks.deleteButton')}
                          </button>
                          <button type="button" onClick={() => setConfirmDeleteId(null)} className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-accent">
                            {t('integrations.webhooks.cancel')}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(wh.id)}
                          className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          title={t('integrations.webhooks.deleteButton')}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                  {confirmDeleteId === wh.id && (
                    <p className="text-xs text-destructive">{t('integrations.webhooks.deleteConfirm')}</p>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {(wh.events || []).map(ev => (
                      <span key={ev} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                        {eventLabel(ev)}
                      </span>
                    ))}
                  </div>
                  <div className="text-xs">
                    <span className="text-muted-foreground">{t('integrations.webhooks.lastStatus')}：</span>
                    {renderLastStatus(wh)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Signature verification note */}
          <div className="flex items-start gap-1.5 text-xs text-muted-foreground rounded-md bg-muted/40 border border-border px-3 py-2">
            <ShieldCheck size={13} className="mt-0.5 flex-shrink-0" />
            <span>{t('integrations.webhooks.signatureNote')}</span>
          </div>
        </div>
      </div>

      {/* ── Create dialog ── */}
      {showCreate && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={() => { if (!creating) setShowCreate(false); }}>
          <div role="dialog" aria-modal="true" className="bg-card rounded-xl shadow-xl border border-border p-5 w-full max-w-md mx-4 animate-in fade-in zoom-in-95 duration-150" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-foreground mb-3">{t('integrations.webhooks.addButton')}</h3>
            <div className="space-y-3">
              <Field label={t('integrations.webhooks.urlLabel')}>
                <input
                  type="url"
                  className={inputCls}
                  placeholder={t('integrations.webhooks.urlPlaceholder')}
                  value={newUrl}
                  onChange={e => setNewUrl(e.target.value)}
                  autoFocus
                  spellCheck={false}
                />
              </Field>
              <Field label={t('integrations.webhooks.eventsLabel')}>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {EVENT_OPTIONS.map(opt => (
                    <label key={opt.value} className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={newEvents.includes(opt.value)}
                        onChange={e => {
                          if (e.target.checked) setNewEvents(prev => [...prev, opt.value]);
                          else setNewEvents(prev => prev.filter(v => v !== opt.value));
                        }}
                        className="rounded"
                      />
                      <span className="text-sm text-foreground">{t(opt.labelKey)}</span>
                    </label>
                  ))}
                </div>
              </Field>
              {createError && <p className="text-xs text-destructive">{createError}</p>}
            </div>
            <div className="flex gap-2 justify-end mt-4">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                disabled={creating}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('integrations.webhooks.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void create()}
                disabled={creating || !newUrl.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {creating && <Loader2 size={13} className="animate-spin" />}
                {creating ? t('integrations.webhooks.creating') : t('integrations.webhooks.createButton')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ── Secret reveal (shown ONCE) ── */}
      {createdSecret && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
          <div role="dialog" aria-modal="true" className="bg-card rounded-xl shadow-xl border border-border p-5 w-full max-w-md mx-4 animate-in fade-in zoom-in-95 duration-150">
            <h3 className="text-base font-bold text-foreground mb-2">{t('integrations.webhooks.secretTitle')}</h3>
            <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5 mb-3">
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
              {t('integrations.webhooks.secretWarning')}
            </p>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
              <code className="text-xs text-foreground break-all flex-1 select-all">{createdSecret}</code>
              <button
                type="button"
                onClick={() => void copySecret()}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
              >
                <Copy size={12} />
                {t('integrations.webhooks.copy')}
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-3">{t('integrations.webhooks.signatureNote')}</p>
            <div className="flex justify-end mt-4">
              <button
                type="button"
                onClick={() => setCreatedSecret(null)}
                className="px-4 py-1.5 text-sm font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                {t('integrations.webhooks.done')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default WebhooksCard;
