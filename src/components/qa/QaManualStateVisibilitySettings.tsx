import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { QaClient } from '@/lib/qa/client';
import type { QaActor, QaState } from '@/lib/qa/domain';
import { canManageQaConfiguration } from '@/lib/qa/fields';
import type { QaWorkflow } from '@/lib/qa/workflow';
import { validateQaManualStateVisibility, type QaManualStateVisibility } from '@/lib/qa/manualStateVisibility';
import { useQaManualStateVisibility } from '@/hooks/useQaManualStateVisibility';
import { QaFailure } from './QaIssueDetail';
import { qaButton, qaPrimary } from './QaFields';

export default function QaManualStateVisibilitySettings({ client, actor, workflow, onDirtyChange, onBusyChange, onClose }: {
  client: QaClient; actor: QaActor; workflow: QaWorkflow;
  onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  const loaded = useQaManualStateVisibility(client);
  const [draft, setDraft] = useState<QaManualStateVisibility | null>(null);
  const [baseline, setBaseline] = useState<QaManualStateVisibility | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canManage = canManageQaConfiguration(actor);
  useEffect(() => { if (loaded.configuration) { setDraft(loaded.configuration); setBaseline(loaded.configuration); } }, [loaded.configuration]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(JSON.stringify(draft) !== JSON.stringify(baseline)); }, [draft, baseline, onDirtyChange]);
  const toggle = (state: QaState, visible: boolean) => setDraft(current => current && validateQaManualStateVisibility({ version: 1,
    hiddenStates: visible ? current.hiddenStates.filter(value => value !== state) : [...current.hiddenStates, state] }));
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || !canManage || !draft) return;
    setBusy(true); setError(null);
    try { const saved = await client.saveManualStateVisibility(validateQaManualStateVisibility(draft)); setDraft(saved); setBaseline(saved); toast.success(t('qa.manualStates.saved')); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  if (!canManage) return <p className="text-sm text-muted-foreground">{t('qa.customFields.forbidden')}</p>;
  return <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="qa-manual-state-title">
    <h2 id="qa-manual-state-title" className="text-lg font-semibold">{t('qa.manualStates.title')}</h2>
    <p className="mt-2 text-sm text-muted-foreground">{t('qa.manualStates.hint')}</p>
    {loaded.error !== null ? <div role="alert" className="mt-3"><p>{t('qa.manualStates.loadFailed')}</p><button type="button" className={qaButton} onClick={loaded.retry}>{t('qa.retry')}</button></div>
      : !draft ? <p role="status" className="mt-3 text-sm">{t('qa.manualStates.loading')}</p> : null}
    <form className="mt-4 space-y-4" onSubmit={event => void save(event)}>
      {error !== null && <QaFailure error={error} />}
      <fieldset disabled={busy || !draft} className="space-y-3">
        <button type="button" className={qaButton} onClick={() => setDraft({ version: 1, hiddenStates: [] })}>{t('qa.manualStates.restoreAll')}</button>
        {workflow.order.map(state => <label key={state} className="flex items-center gap-3 rounded-lg border border-border p-3">
          <input type="checkbox" checked={!!draft && !draft.hiddenStates.includes(state)} onChange={event => toggle(state, event.target.checked)} />
          <span>{workflow.labels[state] || t(`qa.state.${state}`)}</span>
        </label>)}
        {draft?.hiddenStates.length === workflow.order.length && <p className="text-sm text-muted-foreground">{t('qa.manualStates.empty')}</p>}
        <div className="flex gap-2"><button className={qaPrimary} type="submit">{t(busy ? 'qa.saving' : 'qa.save')}</button><button className={qaButton} type="button" onClick={onClose}>{t('qa.cancel')}</button></div>
      </fieldset>
    </form>
  </section>;
}
