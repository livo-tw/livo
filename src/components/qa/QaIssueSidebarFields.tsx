import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import UserSelect from '@/components/UserSelect';
import { ProjectSelectOptions } from '@/components/project/ProjectOptions';
import { useMemberContext } from '@/context/MemberContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useTaskContext } from '@/context/TaskContext';
import { getDepartmentPreferenceIds, getProjectDeveloperPreferenceIds } from '@/lib/memberSelection';
import { groupProjectsByLine } from '@/lib/projectGroups';
import type { QaCommand, QaIssue, QaSeverity } from '@/lib/qa/domain';
import { QaField, QaSelect } from './QaFields';
import { qaPriorities } from './QaBadges';

type Fields = Pick<QaIssue, 'projectId' | 'assigneeId' | 'qaOwnerId' | 'severity' | 'priority' | 'dueDate'>;

export default function QaIssueSidebarFields({ issue, disabled, onCommand }: {
  issue: QaIssue; disabled: boolean; onCommand: (command: QaCommand) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { users } = useMemberContext();
  const { allProjects, productLines } = useProjectContext();
  const { allTasks } = useTaskContext();
  const [dueDate, setDueDate] = useState(issue.dueDate || '');
  useEffect(() => setDueDate(issue.dueDate || ''), [issue.id, issue.version, issue.dueDate]);
  const update = (patch: Partial<Fields>) => {
    if (disabled) return Promise.resolve(false);
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
    <QaSelect label={t('qa.priority')} value={issue.priority} disabled={disabled} onChange={event => update({ priority: Number(event.target.value) })}>
      {qaPriorities.map((value, index) => <option key={value} value={index + 1}>{t(`priority.${value}`)}</option>)}
    </QaSelect>
    <QaSelect label={t('qa.severity')} value={issue.severity} disabled={disabled} onChange={event => update({ severity: event.target.value as QaSeverity })}>
      {['untriaged', 'low', 'medium', 'high'].map(value => <option key={value} value={value}>{t(`qa.severityNames.${value}`)}</option>)}
    </QaSelect>
    <UserSelect label={t('qa.assignee')} activeOnly allowEmpty disabled={disabled} value={issue.assigneeId || ''}
      onChange={value => update({ assigneeId: value || null })} emptyLabel={t('qa.unassigned')}
      preferredUserIds={getProjectDeveloperPreferenceIds(users, allTasks, issue.projectId, issue.assigneeId)} size="md" />
    <UserSelect label={t('qa.qaOwner')} activeOnly allowEmpty disabled={disabled} value={issue.qaOwnerId || ''}
      onChange={value => update({ qaOwnerId: value || null })} emptyLabel={t('qa.unassigned')}
      preferredUserIds={getDepartmentPreferenceIds(users, ['QA'])} size="md" />
    <QaField label={t('qa.dueDate')} type="date" disabled={disabled} value={dueDate}
      onChange={event => setDueDate(event.target.value)} onBlur={() => void saveDueDate()} />
  </div>;
}
