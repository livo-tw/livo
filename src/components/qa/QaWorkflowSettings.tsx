import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { QaClient } from '@/lib/qa/client';
import type { QaActor } from '@/lib/qa/domain';
import { canManageQaConfiguration } from '@/lib/qa/fields';
import { useQaNavigationGuard } from '@/hooks/useQaNavigationGuard';
import { DEFAULT_QA_WORKFLOW, getQaWorkflowColumns, parseQaWorkflow, validateQaWorkflow, type QaWorkflow } from '@/lib/qa/workflow';
import { QaFailure } from './QaIssueDetail';
import { QaField, qaButton, qaPrimary } from './QaFields';

export default function QaWorkflowSettings({ workflow, client, actor, onSaved, onClose, onDirtyChange, onBusyChange }: {
  workflow: QaWorkflow;
  client: QaClient;
  actor: QaActor;
  onSaved: (workflow: QaWorkflow) => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<QaWorkflow>(() => parseQaWorkflow(workflow));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canManage = canManageQaConfiguration(actor);
  useQaNavigationGuard(busy);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(JSON.stringify(draft) !== JSON.stringify(parseQaWorkflow(workflow))); }, [draft, workflow, onDirtyChange]);
  const move = (index: number, direction: -1 | 1) => setDraft(current => {
    const columns = getQaWorkflowColumns(current);
    [columns[index], columns[index + direction]] = [columns[index + direction], columns[index]];
    return { ...current, order: columns.flatMap(column => column.states) };
  });
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !canManage) return;
    setBusy(true); setError(null);
    try {
      const saved = await client.saveWorkflow(validateQaWorkflow(draft));
      onSaved(saved); onClose();
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  if (!canManage) return <p className="text-sm text-muted-foreground">{t('qa.customFields.forbidden')}</p>;
  return <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="qa-workflow-title">
    <h2 id="qa-workflow-title" className="text-lg font-semibold">{t('qa.workflowTitle')}</h2>
    <p className="mt-2 text-sm text-muted-foreground">{t('qa.workflowHint')}</p>
    <p className="mt-1 text-xs text-muted-foreground">{t('qa.workflowLabelHint')}</p>
    <form className="mt-4 space-y-4" onSubmit={event => void save(event)}>
      {error !== null && <QaFailure error={error} />}
      <fieldset disabled={busy} className="space-y-3">
        <button type="button" className={qaButton} onClick={() => setDraft(parseQaWorkflow(DEFAULT_QA_WORKFLOW))}>{t('qa.workflowFullPreset')}</button>
        {getQaWorkflowColumns(draft, state => t(`qa.state.${state}`)).map((column, index, columns) => <div key={column.id} className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
          <div className="min-w-[160px] flex-1"><QaField label={t('qa.workflowStage', { number: index + 1, name: column.states.map(state => t(`qa.state.${state}`)).join(' / ') })}
            maxLength={40} placeholder={t(`qa.state.${column.id}`)} value={draft.groups.find(group => group.id === column.id)?.label ?? draft.labels[column.id]}
            onChange={event => setDraft(current => current.groups.some(group => group.id === column.id)
              ? { ...current, groups: current.groups.map(group => group.id === column.id ? { ...group, label: event.target.value } : group) }
              : { ...current, labels: { ...current.labels, [column.id]: event.target.value } })} />
          </div>
          <button type="button" className={qaButton} disabled={index === 0} aria-label={t('qa.workflowMoveUp', { name: column.label })} onClick={() => move(index, -1)}>↑</button>
          <button type="button" className={qaButton} disabled={index === columns.length - 1} aria-label={t('qa.workflowMoveDown', { name: column.label })} onClick={() => move(index, 1)}>↓</button>
        </div>)}
        <div className="flex gap-2"><button className={qaPrimary} type="submit">{t(busy ? 'qa.saving' : 'qa.save')}</button><button className={qaButton} type="button" onClick={onClose}>{t('qa.cancel')}</button></div>
      </fieldset>
    </form>
  </section>;
}
