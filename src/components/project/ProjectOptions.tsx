import { useProjectColor } from '@/hooks/useProjectColor';
import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useProjectContext } from '@/context/ProjectContext';
import MultiSelectDropdown from '@/components/MultiSelectDropdown';
import { groupProjectsByLine, projectGroupLabel, type ProjectGroup, type ProjectGroupOptions, type ProjectOption } from '@/lib/projectGroups';

/** Keep sentinels (all/shared/choose) with the caller; these are project rows only. */
export function ProjectSelectOptions({ groups }: { groups: readonly ProjectGroup[] }) {
  const { t } = useTranslation();
  return <>{groups.map(group => <optgroup key={group.line?.id ?? '__unclassified'} label={projectGroupLabel(group.line, t('common.other'))}>
    {group.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
  </optgroup>)}</>;
}

/** Shared headings for checkbox lists and command/popover project choices. */
export function ProjectGroupedList<P extends ProjectOption>({ groups, children }: {
  groups: readonly ProjectGroup<P>[];
  children: (project: P) => ReactNode;
}) {
  const { t } = useTranslation();
  return <>{groups.map(group => <Fragment key={group.line?.id ?? '__unclassified'}>
    <div className="px-3 pt-2 pb-1 text-xs font-semibold text-muted-foreground" role="presentation">{projectGroupLabel(group.line, t('common.other'))}</div>
    {group.projects.map(project => <Fragment key={project.id}>{children(project)}</Fragment>)}
  </Fragment>)}</>;
}

export function ProjectCheckboxList({ groups, selected, onToggle }: {
  groups: readonly ProjectGroup[];
  selected: readonly string[];
  onToggle: (id: string) => void;
}) {
  const getProjectColor = useProjectColor();
  return <ProjectGroupedList groups={groups}>{project => <label className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent cursor-pointer">
    <input type="checkbox" checked={selected.includes(project.id)} onChange={() => onToggle(project.id)} className="rounded border-border accent-primary" />
    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: getProjectColor(project) }} />
    <span className="text-foreground truncate">{project.name}</span>
  </label>}</ProjectGroupedList>;
}

export function ProjectMultiSelect({ projects, label, selected, onToggle, options }: {
  projects: readonly ProjectOption[];
  label: string;
  selected: string[];
  onToggle: (id: string) => void;
  options?: ProjectGroupOptions;
}) {
  const { productLines } = useProjectContext();
  const getProjectColor = useProjectColor();
  const { t } = useTranslation();
  const groups = groupProjectsByLine(productLines, projects, options);
  return <MultiSelectDropdown label={label} selected={selected} onToggle={onToggle} options={groups.flatMap(group => group.projects.map(project => ({
    id: project.id, label: project.name, color: getProjectColor(project),
    group: { id: group.line?.id ?? '__unclassified', label: projectGroupLabel(group.line, t('common.other')) },
  })))} />;
}
