// API tokens admin card (系統管理 → 整合) — both backends.
//
// Backend fn 'api-tokens': worker/src/functions/apiTokens.ts (Cloudflare) and
// docker/volumes/functions/api-tokens (self-host). Contract:
//   GET  → { tokens: [{ id, name, memberId, createdAt, lastUsedAt, revokedAt }] }
//          (older builds sent snake_case — normalizeToken accepts both)
//   POST { action:'create', name, memberId? } → { ok, token }  (token shown ONCE)
//   POST { action:'revoke', id }              → { ok }
// A token acts as the bound member (default: the caller). Binding to another
// admin / super_admin needs super_admin — the server enforces the same rule.
// Self-host scripts trade the token for a short-lived JWT first
// (POST /functions/v1/api-tokens/exchange); the hint below says so.
//
// Structure mirrors SlackCard; admin-only via IntegrationsView + server checks.

import { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { KeyRound, Loader2, Plus, Copy, AlertTriangle, Ban } from 'lucide-react';
import { toast } from 'sonner';
import { useLicense } from '@/context/LicenseContext';
import { useAuthContext } from '@/context/AuthContext';
import { useMemberContext } from '@/context/MemberContext';
import { USE_CF_BACKEND } from '@/lib/apiBase';
import { authGetJson, authPostJson } from './fnFetch';
import { Field, inputCls } from './shared';
import { type ApiToken, bindableMembers, normalizeToken } from './apiTokenUtils';

const ApiTokensCard = () => {
  const { t } = useTranslation();
  const { isDemoMode } = useLicense();
  const { realMember } = useAuthContext();
  const { users } = useMemberContext();
  const bindable = bindableMembers(users, realMember);

  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // Create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMemberId, setNewMemberId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Token reveal (shown ONCE right after create)
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const { resp, body } = await authGetJson<{ tokens?: Record<string, unknown>[]; error?: string }>('api-tokens');
      if (resp.ok && Array.isArray(body.tokens)) setTokens(body.tokens.map(normalizeToken));
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

  const create = async () => {
    const name = newName.trim();
    if (!name) {
      setCreateError(t('integrations.apiTokens.nameRequired'));
      return;
    }
    setCreateError(null);
    setCreating(true);
    try {
      const memberId = newMemberId && newMemberId !== realMember?.id ? newMemberId : undefined;
      const { resp, body } = await authPostJson<{ ok?: boolean; token?: string; error?: string; message?: string }>(
        'api-tokens', { action: 'create', name, ...(memberId ? { memberId } : {}) },
      );
      if (resp.ok && body.ok && body.token) {
        setShowCreate(false);
        setNewName('');
        setCreatedToken(body.token);
        void load();
      } else {
        setCreateError(body.message || body.error || t('integrations.apiTokens.createFailed'));
      }
    } catch {
      setCreateError(t('integrations.apiTokens.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    setBusyId(id);
    try {
      const { resp, body } = await authPostJson<{ ok?: boolean; error?: string }>('api-tokens', { action: 'revoke', id });
      if (resp.ok && body.ok) {
        toast.success(t('integrations.apiTokens.revoked'));
        void load();
      } else {
        toast.error(t('integrations.apiTokens.revokeFailed'));
      }
    } catch {
      toast.error(t('integrations.apiTokens.revokeFailed'));
    } finally {
      setBusyId(null);
      setConfirmRevokeId(null);
    }
  };

  const copyToken = async () => {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      toast.success(t('integrations.apiTokens.copied'));
    } catch {
      /* clipboard unavailable — user can select the text manually */
    }
  };

  return (
    <div className="border border-border bg-card rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex-shrink-0 text-muted-foreground">
          <KeyRound size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <span className="font-semibold text-sm text-foreground">{t('integrations.apiTokens.title')}</span>
          <p className="text-xs text-muted-foreground mt-0.5">{t('integrations.apiTokens.desc')}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {t(USE_CF_BACKEND ? 'apiTokenAccess.usageCloud' : 'apiTokenAccess.usageSelfHost')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setNewName(''); setNewMemberId(realMember?.id ?? ''); setCreateError(null); setShowCreate(true); }}
          disabled={isDemoMode}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors flex-shrink-0"
        >
          <Plus size={13} />
          {t('integrations.apiTokens.addButton')}
        </button>
      </div>

      {/* Body */}
      <div className="px-4 pb-4 border-t border-border">
        <div className="pt-4 space-y-3">
          {isDemoMode ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t('integrations.apiTokens.demoDisabled')}</p>
          ) : loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 size={14} className="animate-spin" />
              {t('common.loading')}
            </div>
          ) : loadError ? (
            <p className="text-xs text-destructive">{t('integrations.apiTokens.loadFailed')}</p>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground py-1">{t('integrations.apiTokens.empty')}</p>
          ) : (
            <div className="space-y-2">
              {tokens.map(tok => {
                const revoked = !!tok.revokedAt;
                const bound = users.find(u => u.id === tok.memberId);
                return (
                  <div key={tok.id} className={`rounded-md border border-border px-3 py-2.5 ${revoked ? 'opacity-60' : ''}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground truncate">{tok.name}</span>
                          {revoked && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/10 text-destructive font-medium flex-shrink-0">
                              {t('integrations.apiTokens.revokedBadge')}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {t('apiTokenAccess.boundTo', { name: bound ? bound.name : t('apiTokenAccess.unknownMember') })}
                          {tok.createdAt && (
                            <>
                              {' · '}
                              {t('integrations.apiTokens.createdAt', { date: new Date(tok.createdAt).toLocaleDateString() })}
                            </>
                          )}
                          {' · '}
                          {tok.lastUsedAt
                            ? t('integrations.apiTokens.lastUsedAt', { date: new Date(tok.lastUsedAt).toLocaleString() })
                            : t('integrations.apiTokens.neverUsed')}
                        </div>
                      </div>
                      {!revoked && (
                        confirmRevokeId === tok.id ? (
                          <div className="flex items-center gap-1 text-xs flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => void revoke(tok.id)}
                              disabled={busyId === tok.id}
                              className="px-2 py-1 rounded bg-destructive text-destructive-foreground text-xs font-medium disabled:opacity-50"
                            >
                              {busyId === tok.id ? <Loader2 size={12} className="animate-spin" /> : t('integrations.apiTokens.revokeButton')}
                            </button>
                            <button type="button" onClick={() => setConfirmRevokeId(null)} className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-accent">
                              {t('integrations.apiTokens.cancel')}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmRevokeId(tok.id)}
                            className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors flex-shrink-0"
                          >
                            <Ban size={12} />
                            {t('integrations.apiTokens.revokeButton')}
                          </button>
                        )
                      )}
                    </div>
                    {confirmRevokeId === tok.id && (
                      <p className="text-xs text-destructive mt-1">{t('integrations.apiTokens.revokeConfirm')}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Create dialog ── */}
      {showCreate && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={() => { if (!creating) setShowCreate(false); }}>
          <div role="dialog" aria-modal="true" className="bg-card rounded-xl shadow-xl border border-border p-5 w-full max-w-sm mx-4 animate-in fade-in zoom-in-95 duration-150" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-foreground mb-3">{t('integrations.apiTokens.addButton')}</h3>
            <Field label={t('integrations.apiTokens.nameLabel')}>
              <input
                type="text"
                className={inputCls}
                placeholder={t('integrations.apiTokens.namePlaceholder')}
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void create(); }}
                autoFocus
                spellCheck={false}
              />
            </Field>
            {bindable.length > 0 && <div className="mt-3">
              <Field label={t('apiTokenAccess.memberLabel')}>
                <select
                  className={inputCls}
                  value={newMemberId}
                  onChange={e => setNewMemberId(e.target.value)}
                  disabled={creating}
                >
                  {bindable.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.id === realMember?.id ? t('apiTokenAccess.memberSelf', { name: u.name }) : u.name}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="text-xs text-muted-foreground mt-1">{t('apiTokenAccess.memberHint')}</p>
            </div>}
            {createError && <p className="text-xs text-destructive mt-2">{createError}</p>}
            <div className="flex gap-2 justify-end mt-4">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                disabled={creating}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('integrations.apiTokens.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void create()}
                disabled={creating || !newName.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {creating && <Loader2 size={13} className="animate-spin" />}
                {creating ? t('integrations.apiTokens.creating') : t('integrations.apiTokens.createButton')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ── Token reveal (shown ONCE) ── */}
      {createdToken && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
          <div role="dialog" aria-modal="true" className="bg-card rounded-xl shadow-xl border border-border p-5 w-full max-w-md mx-4 animate-in fade-in zoom-in-95 duration-150">
            <h3 className="text-base font-bold text-foreground mb-2">{t('integrations.apiTokens.tokenTitle')}</h3>
            <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5 mb-3">
              <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
              {t('integrations.apiTokens.tokenWarning')}
            </p>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
              <code className="text-xs text-foreground break-all flex-1 select-all">{createdToken}</code>
              <button
                type="button"
                onClick={() => void copyToken()}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
              >
                <Copy size={12} />
                {t('integrations.apiTokens.copy')}
              </button>
            </div>
            <div className="flex justify-end mt-4">
              <button
                type="button"
                onClick={() => setCreatedToken(null)}
                className="px-4 py-1.5 text-sm font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                {t('integrations.apiTokens.done')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default ApiTokensCard;
