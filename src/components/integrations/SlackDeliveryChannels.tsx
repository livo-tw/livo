import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Field, inputCls } from './shared';

type Route = { channelId?: string; enabled?: boolean; projectId?: string; lineId?: string; [key: string]: unknown };
type Delivery = { routes?: Route[]; qaRoutes?: Route[]; enabled?: boolean; [key: string]: unknown };
type Kind = 'routes' | 'qaRoutes';
type Channel = { id: string; name: string; is_member?: boolean };
type Props = { configured: boolean; isDemoMode: boolean; channels: Channel[] | null; channelsError: string | null };
const CHANNEL_ID = /^[CG][A-Z0-9]+$/;
const MIXED = '__multiple_channels__';

/** Self-host pickers use the same routes as the durable task/QA delivery workers. */
export default function SlackDeliveryChannels({ configured, isDemoMode, channels, channelsError }: Props) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<Delivery | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState<Kind | null>(null);

  useEffect(() => {
    let alive = true;
    if (!configured || isDemoMode) { setLoading(false); return () => { alive = false; }; }
    setLoading(true); setLoadFailed(false);
    void (async () => {
      try {
        const { data, error } = await supabase.from('system_settings').select('value').eq('key', 'slack_delivery').maybeSingle();
        if (error) throw error;
        if (alive) setConfig(data?.value && typeof data.value === 'object' && !Array.isArray(data.value) ? data.value as Delivery : null);
      } catch { if (alive) setLoadFailed(true); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [configured, isDemoMode]);

  const save = async (kind: Kind, value: string) => {
    if (saving || isDemoMode || !configured || (value !== '' && !CHANNEL_ID.test(value))) return;
    setSaving(kind);
    try {
      // Re-read, then compare the entire JSON value in the update: a concurrent
      // settings writer must not lose its routes, opt-outs, or weekly settings.
      const { data: row, error: readError } = await supabase.from('system_settings').select('value').eq('key', 'slack_delivery').maybeSingle();
      if (readError) throw readError;
      if (!row?.value || typeof row.value !== 'object' || Array.isArray(row.value)) throw new Error('missing_routes');
      const current = row.value as Delivery;
      setConfig(current);
      const own = Array.isArray(current[kind]) ? current[kind]! : [];
      const other = current[kind === 'routes' ? 'qaRoutes' : 'routes'];
      // Adding the first QA channel inherits the already configured project
      // scopes; choosing a channel never expands them to other projects.
      const source = own.length ? own : Array.isArray(other) ? other : [];
      if (!source.length) throw new Error('missing_routes');
      const next = { ...current, [kind]: source.map(route => ({ ...route, channelId: value })) };
      const { data: saved, error: writeError } = await supabase.from('system_settings')
        .update({ value: next as Json }).eq('key', 'slack_delivery').eq('value', JSON.stringify(row.value)).select('value');
      if (writeError) throw writeError;
      if (saved?.length !== 1) throw new Error('settings_conflict');
      setConfig(saved[0].value as Delivery);
      toast.success(t('integrations.slack.channelSaved'));
    } catch (error) {
      const reason = (error as { message?: string }).message;
      toast.error(t(reason === 'settings_conflict' ? 'integrations.slack.channelSettingsConflict'
        : reason === 'missing_routes' ? 'integrations.slack.channelRoutesMissing' : 'integrations.saveFailed'));
    } finally { setSaving(null); }
  };

  const hasScopes = ['routes', 'qaRoutes'].some(key => Array.isArray(config?.[key]) && (config[key] as Route[]).length > 0);
  const disabled = !configured || isDemoMode || loading || loadFailed || !hasScopes || saving !== null || channels === null;
  const picker = (kind: Kind, label: string, hint: string) => {
    const routes = Array.isArray(config?.[kind]) ? config[kind]! : [];
    const ids = [...new Set(routes.filter(r => r.enabled !== false && CHANNEL_ID.test(r.channelId || '')).map(r => r.channelId!))];
    const value = ids.length > 1 ? MIXED : ids[0] || '';
    const known = (channels ?? []).some(c => c.id === value);
    let help = t(hint);
    if (!configured) help = t('integrations.slack.channelNotConfigured');
    else if (loadFailed) help = t('integrations.slack.channelRoutesLoadError');
    else if (channelsError) help = t('integrations.slack.channelLoadError');
    else if (!loading && !hasScopes) help = t('integrations.slack.channelRoutesMissing');
    else if (config?.enabled === false) help = t('integrations.slack.channelDeliveryDisabled');
    return <Field key={kind} label={t(label)}>
      <SearchableSelect aria-label={t(label)} className={inputCls} value={value}
        onChange={event => void save(kind, event.target.value)} disabled={disabled}>
        <option value="">{t('integrations.slack.channelNone')}</option>
        {value === MIXED && <option value={MIXED} disabled>{t('integrations.slack.channelMultiple')}</option>}
        {value && value !== MIXED && !known && <option value={value}>#{value}</option>}
        {(channels ?? []).map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
      </SearchableSelect>
      <p className="text-xs text-muted-foreground mt-1" role={loadFailed ? 'alert' : undefined}>{help}</p>
      {(channels ?? []).some(c => c.id === value && c.is_member === false) &&
        <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">{t('integrations.slack.channelNeedInvite')}</p>}
    </Field>;
  };
  return <>
    {picker('routes', 'integrations.slack.channelPickerLabel', 'integrations.slack.channelPickerHint')}
    {picker('qaRoutes', 'integrations.slack.qaChannelPickerLabel', 'integrations.slack.qaChannelPickerHint')}
  </>;
}
