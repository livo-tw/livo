import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { useMemberContext } from '@/context/MemberContext';
import { Field, inputCls } from './shared';
import { personalMessageSettings, withPersonalMessages, type SlackDeliverySetting as Delivery } from '@/lib/slackPersonalMessages';

type Props = { configured: boolean; isDemoMode: boolean };

/**
 * Self-host: whether personal Slack messages are sent, and to whom. Saved into
 * system_settings.slack_delivery (dmEnabled, dmMemberIds), the setting the
 * delivery worker and the database triggers read. Only members with a verified
 * Slack link who can read the task or bug in LIVO receive anything.
 */
export default function SlackPersonalMessages({ configured, isDemoMode }: Props) {
  const { t } = useTranslation();
  const { users } = useMemberContext();
  const [config, setConfig] = useState<Delivery | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [onlyListed, setOnlyListed] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');

  const apply = useCallback((value: Delivery | null) => {
    setConfig(value);
    const form = personalMessageSettings(value);
    setEnabled(form.enabled); setOnlyListed(form.onlyListed); setMemberIds(form.memberIds);
  }, []);

  useEffect(() => {
    let alive = true;
    if (!configured || isDemoMode) { setLoading(false); return () => { alive = false; }; }
    setLoading(true); setLoadFailed(false);
    void (async () => {
      try {
        const { data, error } = await supabase.from('system_settings').select('value').eq('key', 'slack_delivery').maybeSingle();
        if (error) throw error;
        if (alive) apply(data?.value && typeof data.value === 'object' && !Array.isArray(data.value) ? data.value as Delivery : null);
      } catch { if (alive) setLoadFailed(true); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [configured, isDemoMode, apply]);

  const active = useMemo(() => users.filter(u => u.isActive !== false)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name)), [users]);
  const activeIds = useMemo(() => new Set(active.map(u => u.id)), [active]);
  const chosen = memberIds.filter(id => activeIds.has(id));
  const q = query.trim().toLowerCase();
  const shown = q ? active.filter(u => u.name.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)) : active;
  const stored = personalMessageSettings(config);
  const dirty = !!config && (enabled !== stored.enabled || onlyListed !== stored.onlyListed
    || (onlyListed && chosen.join(',') !== stored.memberIds.filter(id => activeIds.has(id)).join(',')));
  const emptyList = enabled && onlyListed && chosen.length === 0;
  const disabled = !configured || isDemoMode || loading || loadFailed || !config || saving;

  const save = async () => {
    if (disabled || !dirty || emptyList) return;
    setSaving(true);
    try {
      // Re-read and compare the whole value in the update, like the channel
      // pickers: a concurrent change to routes or weekly settings is never lost.
      const { data: row, error: readError } = await supabase.from('system_settings').select('value').eq('key', 'slack_delivery').maybeSingle();
      if (readError) throw readError;
      if (!row?.value || typeof row.value !== 'object' || Array.isArray(row.value)) throw new Error('missing_settings');
      const next = withPersonalMessages(row.value as Delivery, enabled, onlyListed, chosen);
      const { data: saved, error: writeError } = await supabase.from('system_settings')
        .update({ value: next as Json }).eq('key', 'slack_delivery').eq('value', JSON.stringify(row.value)).select('value');
      if (writeError) throw writeError;
      if (saved?.length !== 1) throw new Error('settings_conflict');
      apply(saved[0].value as Delivery);
      toast.success(t('integrations.slack.dm.saved'));
    } catch (error) {
      const reason = (error as { message?: string }).message;
      toast.error(t(reason === 'settings_conflict' ? 'integrations.slack.channelSettingsConflict'
        : reason === 'missing_settings' ? 'integrations.slack.dm.missingSettings' : 'integrations.saveFailed'));
    } finally { setSaving(false); }
  };

  const toggle = (id: string) => setMemberIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  let help = t('integrations.slack.dm.hint');
  if (!configured) help = t('integrations.slack.channelNotConfigured');
  else if (loadFailed) help = t('integrations.slack.dm.loadError');
  else if (!loading && !config) help = t('integrations.slack.dm.missingSettings');
  else if (config?.enabled === false) help = t('integrations.slack.dm.deliveryDisabled');

  return (
    <Field label={t('integrations.slack.dm.title')}>
      <div className="space-y-2 rounded border border-border p-3">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={enabled} disabled={disabled} onChange={e => setEnabled(e.target.checked)} />
          {t('integrations.slack.dm.enable')}
        </label>
        <div role="radiogroup" aria-label={t('integrations.slack.dm.scope')} className="space-y-1 pl-6">
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="radio" name="slack-dm-scope" checked={!onlyListed} disabled={disabled || !enabled} onChange={() => setOnlyListed(false)} />
            {t('integrations.slack.dm.scopeAll')}
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="radio" name="slack-dm-scope" checked={onlyListed} disabled={disabled || !enabled} onChange={() => setOnlyListed(true)} />
            {t('integrations.slack.dm.scopeListed')}
          </label>
        </div>
        {enabled && onlyListed && (
          <div className="space-y-1.5 pl-6">
            <input className={inputCls} type="search" value={query} disabled={disabled}
              aria-label={t('integrations.slack.dm.search')} placeholder={t('integrations.slack.dm.search')}
              onChange={e => setQuery(e.target.value)} />
            <div className="max-h-48 overflow-y-auto rounded border border-border divide-y divide-border">
              {shown.map(u => (
                <label key={u.id} className="flex items-center gap-2 px-2 py-1.5 text-sm text-foreground">
                  <input type="checkbox" checked={chosen.includes(u.id)} disabled={disabled} onChange={() => toggle(u.id)} />
                  <span className="truncate">{u.name}</span>
                  {u.email && <span className="truncate text-xs text-muted-foreground">{u.email}</span>}
                </label>
              ))}
              {!shown.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('integrations.slack.dm.noMatch')}</p>}
            </div>
            <p className="text-xs text-muted-foreground">{t('integrations.slack.dm.selectedCount', { count: chosen.length })}</p>
            {emptyList && <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">{t('integrations.slack.dm.emptyList')}</p>}
          </div>
        )}
        <p className="text-xs text-muted-foreground" role={loadFailed ? 'alert' : undefined}>{help}</p>
        <button type="button" onClick={() => void save()} disabled={disabled || !dirty || emptyList}
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">
          {saving ? t('integrations.slack.dm.saving') : t('integrations.slack.dm.save')}
        </button>
      </div>
    </Field>
  );
}
