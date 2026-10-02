import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { QaClient } from '@/lib/qa/client';
import { validateQaWorkflow, type QaWorkflow } from '@/lib/qa/workflow';
import { QaFailure } from './QaIssueDetail';
import { QaField, qaButton, qaPrimary } from './QaFields';

export default function QaWorkflowSettings({ workflow, client, onSaved, onClose }: {
  workflow: QaWorkflow;
  client: QaClient;
  onSaved: (workflow: QaWorkflow) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<QaWorkflow>(() => ({ ...workflow, order: [...workflow.order], labels: { ...workflow.labels } }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const move = (index: number, direction: -1 | 1) => setDraft(current => {
    const order = [...current.order];
    [order[index], order[index + direction]] = [order[index + direction], order[index]];
    return { ...current, order };
  });
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const saved = await client.saveWorkflow(validateQaWorkflow(draft));
      onSaved(saved); onClose();
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  return <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="qa-workflow-title">
    <h2 id="qa-workflow-title" className="text-lg font-semibold">{t('qa.workflowTitle')}</h2>
    <p className="mt-2 text-sm text-muted-foreground">{t('qa.workflowHint')}</p>
    <p className="mt-1 text-xs text-muted-foreground">{t('qa.workflowLabelHint')}</p>
    <form className="mt-4 space-y-4" onSubmit={event => void save(event)}>
      {error !== null && <QaFailure error={error} />}
      <fieldset disabled={busy} className="space-y-3">
        {draft.order.map((state, index) => <div key={state} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
          <div className="min-w-[160px] flex-1"><QaField label={t('qa.workflowStage', { number: index + 1, name: t(`qa.state.${state}`) })}
            maxLength={40} placeholder={t(`qa.state.${state}`)} value={draft.labels[state]}
            onChange={event => setDraft(current => ({ ...current, labels: { ...current.labels, [state]: event.target.value } }))} />
          </div>
          <button type="button" className={qaButton} disabled={index === 0} aria-label={t('qa.workflowMoveUp', { name: draft.labels[state] || t(`qa.state.${state}`) })} onClick={() => move(index, -1)}>↑</button>
          <button type="button" className={qaButton} disabled={index === draft.order.length - 1} aria-label={t('qa.workflowMoveDown', { name: draft.labels[state] || t(`qa.state.${state}`) })} onClick={() => move(index, 1)}>↓</button>
        </div>)}
        <div className="flex gap-2"><button className={qaPrimary} type="submit">{t(busy ? 'qa.saving' : 'qa.save')}</button><button className={qaButton} type="button" onClick={onClose}>{t('qa.cancel')}</button></div>
      </fieldset>
    </form>
  </section>;
}
