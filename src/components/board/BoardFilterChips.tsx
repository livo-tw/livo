import { useCallback, useMemo, type ComponentProps, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project, User } from '@/types';
import DepartmentFilter from '@/components/DepartmentFilter';
import MultiSelectDropdown from '@/components/MultiSelectDropdown';
import { ProjectMultiSelect } from '@/components/project/ProjectOptions';
import { priorityConfig } from '@/components/ui/badges';
import { sortUsersByDept } from '@/lib/department';
import { useIsMobile } from '@/hooks/use-mobile';
import type { BoardFilterState } from '@/hooks/useBoardFilters';

type Options = ComponentProps<typeof MultiSelectDropdown>['options'];

/**
 * The filter row of the task board and the QA board: department, assignee,
 * status, priority, reviewer and (without a selected project) project. A board
 * adds its own chips through `extra` and its controls through `trailing`.
 */
export default function BoardFilterChips({ users, statusOptions, allProjects, showProjects, filters, assigneeLabel, reviewerLabel, extra, extraActive = false, onClear, trailing }: {
  users: User[]; statusOptions: Options; allProjects: Project[]; showProjects: boolean; filters: BoardFilterState;
  assigneeLabel?: string; reviewerLabel?: string;
  extra?: ReactNode; extraActive?: boolean; onClear?: () => void; trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const toggle = useCallback((setter: React.Dispatch<React.SetStateAction<string[]>>) => (id: string) =>
    setter(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]), []);
  const memberOptions = useMemo(() => sortUsersByDept(users.filter(user => user.isActive)).map(user => ({ id: user.id, label: user.name, avatar: user.avatar, avatarColor: user.color, subtitle: user.jobTitle })), [users]);
  const priorityOptions = useMemo(() => Object.entries(priorityConfig).map(([id, priority]) => ({ id, label: t(`priority.${id}`, { defaultValue: priority.label }), icon: priority.icon as React.ReactElement })), [t]);
  return <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mr-1 hidden md:inline">{t('filter.label')}</span>
    <DepartmentFilter value={filters.filterDept} onChange={filters.setFilterDept} />
    <MultiSelectDropdown label={assigneeLabel || (isMobile ? t('filter.assigneeMobile') : t('filter.assignee'))} options={memberOptions} selected={filters.filterAssignees} onToggle={toggle(filters.setFilterAssignees)} />
    <MultiSelectDropdown label={t('filter.status')} options={statusOptions} selected={filters.filterStatuses} onToggle={toggle(filters.setFilterStatuses)} />
    <MultiSelectDropdown label={isMobile ? t('filter.priorityMobile') : t('filter.priority')} options={priorityOptions} selected={filters.filterPriorities} onToggle={toggle(filters.setFilterPriorities)} />
    <MultiSelectDropdown label={reviewerLabel || (isMobile ? t('filter.reviewerMobile') : t('filter.reviewer'))} options={memberOptions} selected={filters.filterReviewers} onToggle={toggle(filters.setFilterReviewers)} />
    {showProjects && <ProjectMultiSelect label={t('filter.project')} projects={allProjects} selected={filters.filterProjects} onToggle={toggle(filters.setFilterProjects)} />}
    {extra}
    {(filters.hasFilters || extraActive) && <button type="button" onClick={onClear || filters.clearFilters} className="text-[13px] text-primary hover:text-primary/80 font-medium">{t('button.clearFilters')}</button>}
    {trailing && <div className="ml-auto flex items-center gap-1.5">{trailing}</div>}
  </div>;
}
