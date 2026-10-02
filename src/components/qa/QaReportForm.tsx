import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { QaCreateInput, QaIssue, QaSeverity } from '@/lib/qa/domain';
import type { Project, ProductLine } from '@/types';
import type { QaClient } from '@/lib/qa/client';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { useQaVersions } from '@/hooks/useQaVersions';
import { QaVersionField } from './QaVersionField';
import { QaField, QaSelect, qaButton, qaPrimary } from './QaFields';

export default function QaReportForm({ initial, projectId, projects, productLines, client, busy, onSubmit, onCancel }: {
  initial?: QaIssue; projectId?: string; projects: Project[]; productLines: ProductLine[]; client: Pick<QaClient, 'versions'>; busy: boolean;
  onSubmit: (input: QaCreateInput) => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<QaCreateInput>(() => ({ projectId: initial?.projectId || projectId || '', title: initial?.title || '', actual: initial?.actual || '', steps: initial?.steps || '', expected: initial?.expected || '', observedEnvironment: initial?.observedEnvironment || '', observedVersion: initial?.observedVersion || '', component: initial?.component || '', severity: initial?.severity || 'untriaged' }));
  const versions = useQaVersions(client, form.projectId);
  const change = (key: keyof QaCreateInput, value: string) => setForm(previous => ({ ...previous, [key]: value,
    ...(key === 'projectId' && value !== previous.projectId && !initial ? { observedVersion: '' } : {}) }));
  return <form onSubmit={event => { event.preventDefault(); if (!busy) onSubmit(form); }} className="space-y-4">
    <fieldset disabled={busy} className="space-y-4">
      {!initial && <QaSelect label={t('qa.project')} required value={form.projectId} onChange={e => change('projectId', e.target.value)}><option value="">{t('qa.choose')}</option><ProjectSelectOptions groups={groupProjectsByLine(productLines, projects)} /></QaSelect>}
      <QaField label={t('qa.titleField')} required maxLength={200} value={form.title} onChange={e => change('title', e.target.value)} />
      <div className="grid gap-3 sm:grid-cols-2">
        <QaField label={t('qa.environment')} required maxLength={100} value={form.observedEnvironment} onChange={e => change('observedEnvironment', e.target.value)} />
        <QaVersionField label={t('qa.observedVersion')} value={form.observedVersion || ''} onChange={value => change('observedVersion', value)} suggestions={versions} />
        <QaField label={t('qa.problemArea')} hint={t('qa.problemAreaHint')} maxLength={100} value={form.component} onChange={e => change('component', e.target.value)} />
        {!initial && <QaSelect label={t('qa.severity')} value={form.severity} onChange={e => change('severity', e.target.value as QaSeverity)}>{['untriaged', 'low', 'medium', 'high'].map(s => <option key={s} value={s}>{t(`qa.severityNames.${s}`)}</option>)}</QaSelect>}
      </div>
      <QaField label={t('qa.steps')} multiline maxLength={20000} value={form.steps} onChange={e => change('steps', e.target.value)} />
      <QaField label={t('qa.expected')} multiline maxLength={20000} value={form.expected} onChange={e => change('expected', e.target.value)} />
      <QaField label={t('qa.actual')} multiline required maxLength={20000} value={form.actual} onChange={e => change('actual', e.target.value)} />
      <div className="flex flex-wrap gap-2"><button type="submit" className={qaPrimary}>{t(busy ? 'qa.saving' : 'qa.save')}</button><button type="button" className={qaButton} onClick={onCancel}>{t('qa.cancel')}</button></div>
    </fieldset>
  </form>;
}
