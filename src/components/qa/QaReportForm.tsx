import { useDeploymentEnvironments } from '@/context/DeploymentEnvironmentContext';
import { useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { QaCreateInput, QaIssue, QaSeverity } from '@/lib/qa/domain';
import type { Project, ProductLine } from '@/types';
import type { QaClient } from '@/lib/qa/client';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { useQaVersions } from '@/hooks/useQaVersions';
import { QaVersionField } from './QaVersionField';
import QaEnvironmentField from './QaEnvironmentField';
import { QaField, QaSelect, qaButton, qaPrimary } from './QaFields';

export default function QaReportForm({ initial, projectId, projects, productLines, client, busy, onSubmit, onCancel, children, submitLabel, cancelLabel, readOnly = false, cancelDisabled = false }: {
  initial?: QaIssue; projectId?: string; projects: Project[]; productLines: ProductLine[]; client: Pick<QaClient, 'versions'>; busy: boolean;
  onSubmit: (input: QaCreateInput) => void; onCancel: () => void;
  children?: ReactNode; submitLabel?: string; cancelLabel?: string; readOnly?: boolean; cancelDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const environments = useDeploymentEnvironments();
  const [form, setForm] = useState<QaCreateInput>(() => ({ projectId: initial?.projectId || projectId || '', title: initial?.title || '', actual: initial?.actual || '', steps: initial?.steps || '', expected: initial?.expected || '', observedEnvironment: initial?.observedEnvironment || '', observedVersion: initial?.observedVersion || '', component: initial?.component || '', severity: initial?.severity || 'untriaged' }));
  const versions = useQaVersions(client, form.projectId);
  const change = (key: keyof QaCreateInput, value: string) => setForm(previous => ({ ...previous, [key]: value,
    ...(key === 'projectId' && value !== previous.projectId && !initial ? { observedVersion: '' } : {}) }));
  return <form onSubmit={event => { event.preventDefault(); if (!busy && (readOnly || environments.ready)) onSubmit(form); }} className="min-w-0 space-y-5" aria-busy={busy}>
    <fieldset disabled={busy || readOnly} className="min-w-0 space-y-4">
      {!initial && <QaSelect label={t('qa.project')} required value={form.projectId} onChange={e => change('projectId', e.target.value)}><option value="">{t('qa.choose')}</option><ProjectSelectOptions groups={groupProjectsByLine(productLines, projects)} /></QaSelect>}
      <QaField label={t('qa.titleField')} required maxLength={200} value={form.title} onChange={e => change('title', e.target.value)} />
      <QaField label={t('qa.actual')} multiline required maxLength={20000} value={form.actual} onChange={e => change('actual', e.target.value)} />
      <div className="grid gap-4 sm:grid-cols-2">
        <QaEnvironmentField label={t('qa.environment')} required value={form.observedEnvironment} onChange={value => change('observedEnvironment', value)} />
        <QaVersionField label={t('qa.observedVersion')} value={form.observedVersion || ''} onChange={value => change('observedVersion', value)} suggestions={versions} />
      </div>
      <details open={!!initial?.steps || !!initial?.expected} className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">{t('qa.reportDetails')}</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <QaField label={t('qa.steps')} multiline maxLength={20000} value={form.steps} onChange={e => change('steps', e.target.value)} />
          <QaField label={t('qa.expected')} multiline maxLength={20000} value={form.expected} onChange={e => change('expected', e.target.value)} />
        </div>
      </details>
      <details open={!!initial?.component} className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">{t('qa.additionalDetails')}</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <QaField label={t('qa.problemArea')} hint={t('qa.problemAreaHint')} maxLength={100} value={form.component} onChange={e => change('component', e.target.value)} />
          {!initial && <QaSelect label={t('qa.severity')} value={form.severity} onChange={e => change('severity', e.target.value as QaSeverity)}>{['untriaged', 'low', 'medium', 'high'].map(s => <option key={s} value={s}>{t(`qa.severityNames.${s}`)}</option>)}</QaSelect>}
        </div>
      </details>
    </fieldset>
    {children && <div className="min-w-0 border-t border-border pt-5">{children}</div>}
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
      <button type="button" className={qaButton} disabled={busy || cancelDisabled} onClick={onCancel}>{cancelLabel || t('qa.cancel')}</button>
      <button type="submit" className={qaPrimary} disabled={busy || (!readOnly && !environments.ready)}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}{busy ? t('qa.saving') : submitLabel || t('qa.save')}</button>
    </div>
  </form>;
}
