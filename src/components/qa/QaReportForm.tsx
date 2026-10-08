import { useDeploymentEnvironments } from '@/context/DeploymentEnvironmentContext';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
import { useQaFieldConfiguration } from '@/hooks/useQaFieldConfiguration';
import { useIsMobile } from '@/hooks/use-mobile';
import { QaCustomFieldInputs } from './QaCustomFieldInputs';
import UserSelect from '@/components/UserSelect';
import { qaPriorities } from './QaBadges';
import { useQaDisplaySettings } from '@/hooks/useQaDisplaySettings';
import { getQaPriorityChoices } from '@/lib/qa/displaySettings';
import QaDisplaySettingsNotice from './QaDisplaySettingsNotice';

export default function QaReportForm({ initial, projectId, defaultQaOwnerId, projects, productLines, client, busy, onSubmit, onCancel, children, submitLabel, cancelLabel, readOnly = false, cancelDisabled = false, fixedFooter = false }: {
  initial?: QaIssue; projectId?: string; defaultQaOwnerId?: string; projects: Project[]; productLines: ProductLine[]; client: Pick<QaClient, 'versions' | 'getFieldConfiguration' | 'getDisplaySettings'>; busy: boolean;
  onSubmit: (input: QaCreateInput) => void; onCancel: () => void;
  children?: ReactNode; submitLabel?: string; cancelLabel?: string; readOnly?: boolean; cancelDisabled?: boolean; fixedFooter?: boolean;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const formRef = useRef<HTMLFormElement>(null), focused = useRef(false);
  const environments = useDeploymentEnvironments();
  const [form, setForm] = useState<QaCreateInput>(() => ({ projectId: initial?.projectId || projectId || '', title: initial?.title || '', actual: initial?.actual || '', steps: initial?.steps || '', expected: initial?.expected || '', observedEnvironment: initial?.observedEnvironment || '', observedVersion: initial?.observedVersion || '', component: initial?.component || '', severity: initial?.severity || 'untriaged', customFields: { ...initial?.customFields },
    ...(!initial ? { assigneeId: null, qaOwnerId: defaultQaOwnerId || undefined, priority: 3, dueDate: null } : {}) }));
  const fields = useQaFieldConfiguration(client);
  const display = useQaDisplaySettings(client, defaultQaOwnerId || initial?.workspaceId || '');
  useEffect(() => { if (!initial && display.configuration) setForm(current => display.configuration!.hiddenPriorityChoices.includes(current.priority ?? 3)
    ? { ...current, priority: getQaPriorityChoices(display.configuration!)[0] } : current); }, [initial, display.configuration]);
  const versions = useQaVersions(client, form.projectId);
  useEffect(() => {
    if (focused.current || isMobile || busy || readOnly || !display.configuration) return;
    const title = formRef.current?.querySelector<HTMLInputElement>('input[data-qa-title]');
    if (title && !title.matches(':disabled')) { title.focus(); focused.current = true; }
  }, [isMobile, busy, readOnly, display.configuration]);
  const change = (key: keyof QaCreateInput, value: string) => setForm(previous => ({ ...previous, [key]: value,
    ...(key === 'projectId' && value !== previous.projectId && !initial ? { observedVersion: '' } : {}) }));
  return <form ref={formRef} onSubmit={event => { event.preventDefault(); if (!busy && (readOnly || (environments.ready && fields.configuration && display.configuration))) onSubmit(form); }} className={fixedFooter ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'min-w-0 space-y-5'} aria-busy={busy}>
    <div className={fixedFooter ? 'min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto overscroll-contain pb-5' : 'min-w-0 space-y-5'}>
    <QaDisplaySettingsNotice {...display} />
    {fields.error !== null && <div role="alert" className="flex flex-wrap items-center gap-3 rounded border border-destructive/30 p-3 text-sm text-destructive"><span>{t('qa.failed')}</span><button type="button" className={qaButton} onClick={fields.retry}>{t('qa.refresh')}</button></div>}
    <fieldset disabled={busy || readOnly || !display.configuration} className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0 space-y-5">
        <QaField label={t('qa.titleField')} data-qa-title required maxLength={200} value={form.title} onChange={e => change('title', e.target.value)} />
        <QaField label={t('qa.actual')} multiline rows={5} required maxLength={20000} value={form.actual} onChange={e => change('actual', e.target.value)} />
        <QaField label={t('qa.expected')} multiline maxLength={20000} value={form.expected} onChange={e => change('expected', e.target.value)} />
        <QaField label={t('qa.steps')} multiline maxLength={20000} value={form.steps} onChange={e => change('steps', e.target.value)} />
        {fields.configuration && <QaCustomFieldInputs fields={fields.configuration.fields} values={form.customFields || {}} onChange={customFields => setForm(previous => ({ ...previous, customFields }))} />}
      </div>
      <div className="min-w-0 space-y-4 lg:border-l lg:border-border lg:pl-5">
        {!initial && <QaSelect label={t('qa.project')} required value={form.projectId} onChange={e => change('projectId', e.target.value)}><option value="">{t('qa.choose')}</option><ProjectSelectOptions groups={groupProjectsByLine(productLines, projects)} /></QaSelect>}
        <QaEnvironmentField label={t('qa.environment')} required value={form.observedEnvironment} onChange={value => change('observedEnvironment', value)} />
        <QaVersionField label={t('qa.observedVersion')} value={form.observedVersion || ''} onChange={value => change('observedVersion', value)} suggestions={versions} />
        {!initial && display.configuration?.showSeverity && <QaSelect label={t('qa.severity')} value={form.severity} onChange={e => change('severity', e.target.value as QaSeverity)}>{['untriaged', 'low', 'medium', 'high'].map(s => <option key={s} value={s}>{t(`qa.severityNames.${s}`)}</option>)}</QaSelect>}
        {!initial && <>
          <UserSelect label={t('qa.assignee')} activeOnly allowEmpty disabled={busy || readOnly} value={form.assigneeId || ''} onChange={value => setForm(previous => ({ ...previous, assigneeId: value || null }))} />
          <UserSelect label={t('qa.qaOwner')} activeOnly allowEmpty disabled={busy || readOnly} value={form.qaOwnerId || ''} onChange={value => setForm(previous => ({ ...previous, qaOwnerId: value || null }))} />
          <p className="text-xs text-muted-foreground">{t('qa.qaOwnerReporterDefaultHint')}</p>
          <QaSelect label={t('qa.priority')} value={form.priority} onChange={event => setForm(previous => ({ ...previous, priority: Number(event.target.value) }))}>
            {display.configuration && getQaPriorityChoices(display.configuration, initial?.priority).map(priority => <option key={priority} value={priority}>{t(`priority.${qaPriorities[priority - 1]}`)}</option>)}
          </QaSelect>
          <QaField label={t('qa.dueDate')} type="date" value={form.dueDate || ''} onChange={event => setForm(previous => ({ ...previous, dueDate: event.target.value || null }))} />
        </>}
        {initial && <QaField label={t('qa.problemArea')} hint={t('qa.problemAreaHint')} maxLength={100} value={form.component} onChange={e => change('component', e.target.value)} />}
      </div>
    </fieldset>
    {children && <div className="min-w-0 border-t border-border pt-5">{children}</div>}
    </div>
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-card pt-4 pb-[env(safe-area-inset-bottom)]">
      <button type="button" className={qaButton} disabled={busy || cancelDisabled} onClick={onCancel}>{cancelLabel || t('qa.cancel')}</button>
      <button type="submit" className={qaPrimary} disabled={busy || (!readOnly && (!environments.ready || !fields.configuration || !display.configuration))}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}{busy ? t('qa.saving') : submitLabel || t('qa.save')}</button>
    </div>
  </form>;
}
