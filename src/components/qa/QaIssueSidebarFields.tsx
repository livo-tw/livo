import { qaPersonDisplay, qaScopedProfile } from '@/lib/qa/peopleDisplay';
import { qaRepairAssigneeOptions } from '@/lib/qa/assignmentPeople';
import { useQaDisplayConfiguration } from '@/context/QaDisplaySettingsContext';
import { getQaPriorityChoices } from '@/lib/qa/displaySettings';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import UserSelect from '@/components/UserSelect';
import type { User } from '@/types';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import { useMemberContext } from '@/context/MemberContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useTaskContext } from '@/context/TaskContext';
import { NO_QA_TASKS, useExternalQa } from '@/context/ExternalQaContext';
import { getDepartmentPreferenceIds, getProjectDeveloperPreferenceIds } from '@/lib/memberSelection';
import { groupProjectsByLine } from '@/lib/projectGroups';
import type { QaCommand, QaIssue, QaSeverity, QaPersonProfile } from '@/lib/qa/domain';
import { QaField, QaSelect } from './QaFields';
import { qaPriorities } from './QaBadges';
import { useQaDetailDraft } from './QaDetailDraftContext';

type Fields = Pick<QaIssue, 'projectId' | 'assigneeId' | 'qaOwnerId' | 'severity' | 'priority' | 'dueDate'>;

export default function QaIssueSidebarFields({ issue, disabled, onCommand, assignmentOptions, memberNames, memberProfiles }: {
  issue: QaIssue; disabled: boolean; assignmentOptions?: readonly User[]; memberNames?: Record<string, string>; memberProfiles?: Record<string, QaPersonProfile>; onCommand: (command: QaCommand) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const configuration = useQaDisplayConfiguration();
  const { users } = useMemberContext();
  const { allProjects, productLines } = useProjectContext();
  const externalQa = useExternalQa();
  const allTasks = useTaskContext(externalQa)?.allTasks ?? NO_QA_TASKS;
  const scopedMemberName = (id: string | null) => id && typeof memberNames?.[id] === 'string' ? memberNames[id].trim() : undefined;
  const [dueDate, setDueDate] = useState(issue.dueDate || '');
  useQaDetailDraft(dueDate !== (issue.dueDate || ''));
  const dateBaseline = useRef({ id: issue.id, value: issue.dueDate || '' });
  useEffect(() => {
    const prior = dateBaseline.current, next = issue.dueDate || '';
    setDueDate(draft => prior.id !== issue.id || draft === prior.value ? next : draft);
    dateBaseline.current = { id: issue.id, value: next };
  }, [issue.id, issue.version, issue.dueDate]);
  const update = (patch: Partial<Fields>) => {
    if (disabled || ('priority' in patch && !configuration)) return Promise.resolve(false);
    if (Object.entries(patch).every(([key, value]) => issue[key as keyof Fields] === value)) return Promise.resolve(true);
    return onCommand({ type: 'update_fields', projectId: issue.projectId, assigneeId: issue.assigneeId,
      qaOwnerId: issue.qaOwnerId, severity: issue.severity, priority: issue.priority, dueDate: issue.dueDate, ...patch });
  };
  const saveDueDate = async () => {
    if (!await update({ dueDate: dueDate || null })) setDueDate(issue.dueDate || '');
  };
  return <div className="space-y-4">
    <QaSelect label={t('qa.project')} value={issue.projectId} disabled={disabled} onChange={event => update({ projectId: event.target.value })}>
      <ProjectSelectOptions groups={groupProjectsByLine(productLines, allProjects, { keepIds: [issue.projectId] })} />
    </QaSelect>
    <QaSelect label={t('qa.priority')} value={issue.priority} disabled={disabled || !configuration} onChange={event => update({ priority: Number(event.target.value) })}>
      {configuration && getQaPriorityChoices(configuration, issue.priority).map(priority => <option key={priority} value={priority}>{t(`priority.${qaPriorities[priority - 1]}`)}</option>)}
    </QaSelect>
    {configuration?.showSeverity && <QaSelect label={t('qa.severity')} value={issue.severity} disabled={disabled} onChange={event => update({ severity: event.target.value as QaSeverity })}>
      {['untriaged', 'low', 'medium', 'high'].map(value => <option key={value} value={value}>{t(`qa.severityNames.${value}`)}</option>)}
    </QaSelect>}
    <UserSelect displayProfile={qaPersonDisplay} label={t('qa.assignee')} options={qaRepairAssigneeOptions(assignmentOptions)} activeOnly allowEmpty disabled={disabled} value={issue.assigneeId || ''}
      fallbackProfile={qaScopedProfile(memberProfiles, issue.assigneeId) ? qaPersonDisplay(qaScopedProfile(memberProfiles, issue.assigneeId)!) : undefined}
      fallbackLabel={scopedMemberName(issue.assigneeId) || t('qa.memberUnavailable')}
      onChange={value => update({ assigneeId: value || null })} emptyLabel={t('qa.unassigned')}
      preferredUserIds={getProjectDeveloperPreferenceIds(users, allTasks, issue.projectId, issue.assigneeId)} size="md" />
    <UserSelect displayProfile={qaPersonDisplay} label={t('qa.qaOwner')} options={assignmentOptions} activeOnly allowEmpty disabled={disabled} value={issue.qaOwnerId || ''}
      fallbackProfile={qaScopedProfile(memberProfiles, issue.qaOwnerId) ? qaPersonDisplay(qaScopedProfile(memberProfiles, issue.qaOwnerId)!) : undefined}
      fallbackLabel={scopedMemberName(issue.qaOwnerId) || t('qa.memberUnavailable')}
      onChange={value => update({ qaOwnerId: value || null })} emptyLabel={t('qa.unassigned')}
      preferredUserIds={getDepartmentPreferenceIds(users, ['QA'])} size="md" />
    <QaField label={t('qa.dueDate')} type="date" disabled={disabled} value={dueDate}
      onChange={event => setDueDate(event.target.value)} onBlur={() => void saveDueDate()} />
  </div>;
}
