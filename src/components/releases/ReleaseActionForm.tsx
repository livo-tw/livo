import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { QaClient } from '@/lib/qa/client';
import type { ReleaseBatch, ReleaseCommand, ReleaseQaSource, ReleaseRecord } from '@/lib/releases/core';
import type { ReleaseIntent } from '@/lib/releases/client';
import { ReleaseField, ReleaseText, ReleaseSelect, ReleaseFailure, SubmitFooter, useReleaseSubmit, type ReleaseClient } from './ReleaseFields';
import ReleaseQaPicker, { type QaEvidenceChoice } from './ReleaseQaPicker';

export type ReleaseAction = Exclude<ReleaseCommand['operation'], 'create' | 'edit_manifest' | 'publish_thread'>;
export default function ReleaseActionForm({ batch, action, client, qaClient, qaEnabled, onSource, onSaved, onCancel }: {
  batch: ReleaseBatch; action: ReleaseAction; client: ReleaseClient; qaClient: QaClient; qaEnabled: boolean;
  onSource: (source: ReleaseQaSource) => void; onSaved: (batch: ReleaseBatch) => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  // Pin the form's original revision. A retry must never silently accept a newer batch.
  const [snapshot] = useState(() => structuredClone(batch));
  const closed = snapshot.status === 'completed' || snapshot.status === 'cancelled';
  const resultTypes: ReleaseRecord['type'][] = closed ? ['rollback', 'recovery'] : ['deployed', 'failed', 'rollback', 'recovery'];
  const [note, setNote] = useState(''), [url, setUrl] = useState(''), [scope, setScope] = useState(''), [impact, setImpact] = useState('');
  const [componentId, setComponentId] = useState(snapshot.components[0]?.id ?? ''), [environment, setEnvironment] = useState('');
  const [kind, setKind] = useState<'qa' | 'uat'>('uat'), [qaChoice, setQaChoice] = useState<QaEvidenceChoice | null>(null);
  const [componentIds, setComponentIds] = useState<string[]>([]), [exceptionId, setExceptionId] = useState(''), [decision, setDecision] = useState<'approved' | 'rejected'>('approved');
  const [attemptId, setAttemptId] = useState(''), [resultType, setResultType] = useState<ReleaseRecord['type']>(closed ? 'rollback' : 'deployed'), [maintenanceType, setMaintenanceType] = useState<'start' | 'end'>(snapshot.maintenance.at(-1)?.type === 'start' ? 'end' : 'start');
  const { busy, error, uncertain, submit } = useReleaseSubmit(client, onSaved);
  const component = snapshot.components.find(v => v.id === componentId);
  const environments = [...new Set((action === 'link_evidence' ? component?.targets ?? [] : snapshot.components.flatMap(v => v.targets)).map(v => v.environment))];
  const intent = (): ReleaseIntent | null => {
    if (closed && action !== 'record_maintenance' && !(action === 'record_result' && resultTypes.includes(resultType))) return null;
    const base = { batchId: snapshot.id, expectedVersion: snapshot.version };
    if (action === 'link_evidence') return kind === 'qa' && !qaChoice ? null : { ...base, operation: action, componentId, environment, kind, note, url: url || null, ...(kind === 'qa' ? qaChoice : {}) };
    if (action === 'request_exception') return { ...base, operation: action, scope, reason: note };
    if (action === 'decide_exception') return { ...base, operation: action, exceptionId, decision, note };
    if (action === 'start_attempt') return { ...base, operation: action, environment, componentIds, note };
    if (action === 'record_result') return { ...base, operation: action, attemptId, type: resultType, note, url: url || null };
    if (action === 'record_maintenance') return { ...base, operation: action, type: maintenanceType, impact, note };
    return { ...base, operation: action, note };
  };
  return <form className="space-y-4 rounded-xl border bg-card p-4" onSubmit={e => { e.preventDefault(); const command = intent(); if (command) void submit(command); }}>
    <h2 className="text-lg font-semibold">{t(`releaseWorkspace.operations.${action}`)}</h2>
    <p className="text-sm text-muted-foreground">{t('releaseWorkspace.originalRevision', { version: snapshot.version, revision: snapshot.manifestRevision })}</p>
    {closed && <p className="text-sm text-muted-foreground">{t(`releaseWorkspace.statuses.${snapshot.status}`)}</p>}
    {closed && snapshot.closureNote && <p className="whitespace-pre-wrap rounded border p-3 text-sm">{snapshot.closureNote}</p>}
    {['complete', 'cancel', 'decide_exception'].includes(action) && <section className="rounded border bg-muted/40 p-3 text-sm"><h3 className="font-medium">{snapshot.title}</h3><p>{t('releaseWorkspace.reviewScope')}</p><ul className="mt-2 space-y-1">{snapshot.components.flatMap(c => c.targets.map(target => <li key={`${c.id}-${target.environment}`}>{c.name} · {target.environment} · {target.build} / {target.config} / {target.data}</li>))}</ul></section>}
    {error !== null && <ReleaseFailure error={error} />}
    <fieldset disabled={busy || uncertain} className="space-y-3">
      {action === 'link_evidence' && <><ReleaseSelect label={t('releaseWorkspace.component')} value={componentId} required onChange={e => { setComponentId(e.target.value); setEnvironment(''); setQaChoice(null); }}>{snapshot.components.map(v => <option value={v.id} key={v.id}>{v.name}</option>)}</ReleaseSelect><ReleaseSelect label={t('releaseWorkspace.evidenceKind')} value={kind} onChange={e => { setKind(e.target.value as 'qa' | 'uat'); setQaChoice(null); }}><option value="uat">{t('releaseWorkspace.uat')}</option><option value="qa" disabled={!qaEnabled}>QA</option></ReleaseSelect>{!qaEnabled && <p className="text-sm">{t('releaseWorkspace.qaDisabled')}</p>}</>}
      {(action === 'link_evidence' || action === 'start_attempt') && <ReleaseSelect label={t('releaseWorkspace.environment')} value={environment} required onChange={e => { setEnvironment(e.target.value); setComponentIds([]); setQaChoice(null); }}><option value="">{t('releaseWorkspace.choose')}</option>{environments.map(env => <option value={env} key={env}>{env}</option>)}</ReleaseSelect>}
      {action === 'link_evidence' && kind === 'qa' && component && environment && qaEnabled && <ReleaseQaPicker key={`${componentId}-${environment}`} client={qaClient} component={component} environment={environment} onChange={setQaChoice} onSource={onSource} />}
      {action === 'request_exception' && <ReleaseText label={t('releaseWorkspace.exceptionScope')} value={scope} onChange={setScope} maxLength={500} />}
      {action === 'decide_exception' && <><ReleaseSelect label={t('releaseWorkspace.exception')} required value={exceptionId} onChange={e => setExceptionId(e.target.value)}><option value="">{t('releaseWorkspace.choose')}</option>{snapshot.exceptions.filter(v => v.revision === snapshot.manifestRevision && v.decision === 'pending').map(v => <option value={v.id} key={v.id}>{v.scope} · {v.reason}</option>)}</ReleaseSelect><ReleaseSelect label={t('releaseWorkspace.decision')} value={decision} onChange={e => setDecision(e.target.value as 'approved' | 'rejected')}>{(['approved', 'rejected'] as const).map(v => <option value={v} key={v}>{t(`releaseWorkspace.decisions.${v}`)}</option>)}</ReleaseSelect></>}
      {action === 'start_attempt' && <fieldset className="space-y-2 rounded border p-3"><legend>{t('releaseWorkspace.attemptComponents')}</legend>{snapshot.components.filter(v => v.targets.some(target => target.environment === environment)).map(c => <label className="flex gap-2 text-sm" key={c.id}><input type="checkbox" checked={componentIds.includes(c.id)} onChange={e => setComponentIds(e.target.checked ? [...componentIds, c.id] : componentIds.filter(id => id !== c.id))} />{c.name}</label>)}</fieldset>}
      {action === 'record_result' && <><ReleaseSelect label={t('releaseWorkspace.attempt')} required value={attemptId} onChange={e => setAttemptId(e.target.value)}><option value="">{t('releaseWorkspace.choose')}</option>{snapshot.attempts.map(v => <option value={v.id} key={v.id}>{v.environment} · {t('releaseWorkspace.revision', { n: v.revision })} · {v.createdAt}</option>)}</ReleaseSelect><ReleaseSelect label={t('releaseWorkspace.result')} value={resultType} onChange={e => setResultType(e.target.value as ReleaseRecord['type'])}>{resultTypes.map(v => <option value={v} key={v}>{t(`releaseWorkspace.results.${v}`)}</option>)}</ReleaseSelect></>}
      {action === 'record_maintenance' && <><ReleaseSelect label={t('releaseWorkspace.maintenanceType')} value={maintenanceType} onChange={e => setMaintenanceType(e.target.value as 'start' | 'end')}><option value="start">{t('releaseWorkspace.maintenanceStart')}</option><option value="end">{t('releaseWorkspace.maintenanceEnd')}</option></ReleaseSelect><ReleaseText label={t('releaseWorkspace.impact')} value={impact} onChange={setImpact} maxLength={1000} /></>}
      <ReleaseText label={t(action === 'request_exception' ? 'releaseWorkspace.reason' : 'releaseWorkspace.note')} value={note} onChange={setNote} />
      {(action === 'link_evidence' || action === 'record_result') && <ReleaseField label={t('releaseWorkspace.evidenceUrl')} type="url" maxLength={2000} value={url} onChange={e => setUrl(e.target.value)} />}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" required className="mt-1" />{t('releaseWorkspace.confirmRecord')}</label>
    </fieldset>
    <SubmitFooter busy={busy} submitDisabled={!uncertain && ((action === 'link_evidence' && kind === 'qa' && !qaChoice) || (action === 'start_attempt' && !componentIds.length))} uncertain={uncertain} onCancel={onCancel} />
  </form>;
}
