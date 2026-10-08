import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { QaClient } from '@/lib/qa/client';
import type { QaActor, QaState } from '@/lib/qa/domain';
import type { QaWorkflow } from '@/lib/qa/workflow';
import { defaultQaDisplaySettings, validateQaDisplaySettings, type QaDisplaySettings as QaDisplayConfiguration } from '@/lib/qa/displaySettings';
import { useQaDisplaySettings } from '@/hooks/useQaDisplaySettings';
import QaDisplaySettingsNotice from './QaDisplaySettingsNotice';
import { QaFailure } from './QaIssueDetail';
import { qaPriorities } from './QaBadges';
import { qaButton, qaPrimary } from './QaFields';

export default function QaDisplaySettings({ client, actor, workflow, onDirtyChange, onBusyChange, onClose }: {
  client: QaClient; actor: QaActor; workflow: QaWorkflow;
  onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const loaded = useQaDisplaySettings(client, actor.id);
  const [draft, setDraft] = useState<QaDisplayConfiguration | null>(null);
  const [baseline, setBaseline] = useState<QaDisplayConfiguration | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  useEffect(() => { setDraft(loaded.configuration); setBaseline(loaded.configuration); }, [loaded.configuration]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(JSON.stringify(draft) !== JSON.stringify(baseline)); }, [draft, baseline, onDirtyChange]);
  const choosePriority = (priority: number, visible: boolean) => setDraft(current => current && { ...current,
    hiddenPriorityChoices: visible ? current.hiddenPriorityChoices.filter(value => value !== priority) : [...current.hiddenPriorityChoices, priority] });
  const chooseState = (state: QaState, visible: boolean) => setDraft(current => current && { ...current,
    hiddenBoardStates: visible ? current.hiddenBoardStates.filter(value => value !== state) : [...current.hiddenBoardStates, state] });
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || actor.role !== 'super_admin' || !draft || !loaded.configuration) return;
    setBusy(true); setError(null);
    try {
      const configuration = validateQaDisplaySettings(draft);
      const saved = validateQaDisplaySettings(await client.saveDisplaySettings(configuration));
      const readback = validateQaDisplaySettings(await client.getDisplaySettings());
      if (JSON.stringify(saved) !== JSON.stringify(configuration) || JSON.stringify(readback) !== JSON.stringify(configuration)) throw new Error('qa_display_settings_readback_mismatch');
      setDraft(readback); setBaseline(readback); toast.success(t('qa.displaySettings.saved'));
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  if (actor.role !== 'super_admin') return <p className="text-sm text-muted-foreground">{t('qa.displaySettings.forbidden')}</p>;
  return <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="qa-display-settings-title">
    <h2 id="qa-display-settings-title" className="text-lg font-semibold">{t('qa.displaySettings.title')}</h2>
    <p className="mt-2 text-sm text-muted-foreground">{t('qa.displaySettings.hint')}</p>
    <QaDisplaySettingsNotice {...loaded} />
    <form className="mt-4 space-y-4" onSubmit={event => void save(event)}>
      {error !== null && <QaFailure error={error} />}
      <fieldset disabled={busy || !draft || !loaded.configuration} className="space-y-4">
        <button type="button" className={qaButton} onClick={() => setDraft(defaultQaDisplaySettings())}>{t('qa.displaySettings.restore')}</button>
        <label className="flex items-center gap-3"><input type="checkbox" checked={draft?.showSeverity ?? false} onChange={event => setDraft(current => current && { ...current, showSeverity: event.target.checked })} />{t('qa.displaySettings.showSeverity')}</label>
        <fieldset className="space-y-2"><legend className="mb-2 font-medium">{t('qa.displaySettings.priorityChoices')}</legend>
          {qaPriorities.map((value, index) => <label key={value} className="flex items-center gap-3"><input type="checkbox" checked={!!draft && !draft.hiddenPriorityChoices.includes(index + 1)} onChange={event => choosePriority(index + 1, event.target.checked)} />{t(`priority.${value}`)}</label>)}
        </fieldset>
        <fieldset className="space-y-2"><legend className="mb-2 font-medium">{t('qa.displaySettings.boardStates')}</legend>
          {workflow.order.map(state => <label key={state} className="flex items-center gap-3"><input type="checkbox" checked={!!draft && !draft.hiddenBoardStates.includes(state)} onChange={event => chooseState(state, event.target.checked)} />{workflow.labels[state] || t(`qa.state.${state}`)}</label>)}
        </fieldset>
        <div className="flex gap-2"><button className={qaPrimary} type="submit">{t(busy ? 'qa.saving' : 'qa.save')}</button><button className={qaButton} type="button" onClick={onClose}>{t('qa.cancel')}</button></div>
      </fieldset>
    </form>
  </section>;
}
