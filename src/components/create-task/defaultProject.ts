import type { ProjectGroup } from '@/lib/projectGroups';

/**
 * The project a new task starts in: the project in view, else the first open
 * project of the selected product line, else the first open project in the
 * list. The groups already leave out archived projects.
 */
export function defaultTaskProject(groups: readonly ProjectGroup[], selectedProjectId: string | null | undefined, selectedLineId: string | null | undefined): string {
  const open = groups.flatMap(group => group.projects);
  return open.find(project => project.id === selectedProjectId)?.id
    || open.find(project => !!selectedLineId && project.lineId === selectedLineId)?.id
    || open[0]?.id || '';
}
