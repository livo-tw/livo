import { useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { AuthContext } from '@/context/AuthContext';
import { readSlackPreviewMode, withSlackPreviewMode, type SlackPreviewMode } from '@/lib/slackPreviewSettings';
import { Field, inputCls } from './shared';

type Props = { configured: boolean; isDemoMode: boolean };
const setting = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_slack_settings');
  return value as Record<string, unknown>;
};
/** Manual card sharing is independent of automatic task and QA delivery routes. */
export default function SlackLinkPreviews({ configured, isDemoMode }: Props) {
  const { t } = useTranslation();
  const auth = useContext(AuthContext);
  const isSuper = auth?.currentMember?.role === 'super_admin';
  const actor = auth?.currentMember?.id || '';
  const [mode, setMode] = useState<SlackPreviewMode>('project_routes');
  const [previewReady, setPreviewReady] = useState(false);
  const [loading, setLoading] = useState(true), [failed, setFailed] = useState(false), [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const currentActor = useRef(actor); currentActor.current = actor;

  useEffect(() => {
    const key = ++generation.current;
    setLoading(true); setFailed(false); setSaving(false);
    if (!configured || isDemoMode || !actor) { setLoading(false); return; }
    void (async () => {
      try {
        const { data, error } = await supabase.from('system_settings').select('value').eq('key', 'slack_delivery').maybeSingle();
        if (error) throw error;
        const current:Record<string,unknown> = data ? setting(data.value) : {};
        const next = readSlackPreviewMode(current.previewMode);
        if (generation.current === key) { setMode(next); setPreviewReady(current.enabled === true && typeof current.teamId === 'string' && /^T[A-Z0-9]+$/.test(current.teamId)); }
      } catch { if (generation.current === key) setFailed(true); }
      finally { if (generation.current === key) setLoading(false); }
    })();
    return () => { generation.current++; };
  }, [configured, isDemoMode, actor, isSuper, reload]);

  const save = async (selected: string) => {
    if (!isSuper || !configured || isDemoMode || loading || failed || saving) return;
    if (selected !== 'project_routes' && selected !== 'internal_channels') return;
    const key = generation.current, owner = actor;
    setSaving(true);
    try {
      const { data: row, error: readError } = await supabase.from('system_settings').select('value').eq('key', 'slack_delivery').maybeSingle();
      if (readError) throw readError;
      if (generation.current !== key || currentActor.current !== owner) return;
      const current:Record<string,unknown> = row ? setting(row.value) : {};
      // Invalid/unknown stored policy needs repair instead of silently being replaced.
      readSlackPreviewMode(current.previewMode);
      const next = withSlackPreviewMode(current, selected);
      const table = supabase.from('system_settings');
      const result = row
        ? await table.update({ value: next as Json }).eq('key', 'slack_delivery').eq('value', JSON.stringify(row.value)).select('value')
        : await table.insert({ key: 'slack_delivery', value: next as Json }).select('value');
      if (result.error) throw result.error;
      if (result.data?.length !== 1) throw new Error('settings_conflict');
      if (generation.current !== key || currentActor.current !== owner) return;
      const saved = setting(result.data[0].value);
      setMode(readSlackPreviewMode(saved.previewMode));
      setPreviewReady(saved.enabled === true && typeof saved.teamId === 'string' && /^T[A-Z0-9]+$/.test(saved.teamId));
      toast.success(t('integrations.slackPreviews.saved'));
    } catch (error) {
      if (generation.current === key) toast.error(t((error as Error).message === 'settings_conflict' ? 'integrations.slack.channelSettingsConflict' : 'integrations.saveFailed'));
    } finally { if (generation.current === key) setSaving(false); }
  };
  let hint = t(mode === 'internal_channels' ? 'integrations.slackPreviews.internalHint' : 'integrations.slackPreviews.projectHint');
  if (!configured) hint = t('integrations.slack.channelNotConfigured');
  else if (failed) hint = t('integrations.slackPreviews.loadFailed');
  else if (!isSuper) hint = t('integrations.slackPreviews.adminOnly');
  return <Field label={t('integrations.slackPreviews.title')}>
    <select className={inputCls} aria-label={t('integrations.slackPreviews.title')} value={mode}
      disabled={!isSuper || !configured || isDemoMode || loading || failed || saving} onChange={event => void save(event.target.value)}>
      <option value="project_routes">{t('integrations.slackPreviews.projectRoutes')}</option>
      <option value="internal_channels">{t('integrations.slackPreviews.internalChannels')}</option>
    </select>
    <p className="mt-1 text-xs text-muted-foreground" role={failed ? 'alert' : undefined}>{hint}</p>
    <p className="mt-1 text-xs text-muted-foreground">{t('integrations.slackPreviews.notificationsHint')}</p>
    {!loading && !failed && configured && !previewReady && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t('integrations.slackPreviews.requirementsHint')}</p>}
    {failed && <button type="button" className="mt-1 text-xs text-primary underline" onClick={() => setReload(value => value + 1)}>{t('qa.reload')}</button>}
  </Field>;
}
