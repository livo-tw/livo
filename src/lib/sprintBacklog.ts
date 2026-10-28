import type { Project, Status, Task } from '@/types';

/**
 * Tasks a new sprint takes in automatically: the backlog (no sprint) that is
 * not done. Tasks of earlier sprints and finished tasks keep their history.
 */
export function sprintBacklogTaskIds(tasks: readonly Task[], statuses: readonly Status[], projects?: readonly Project[], excludeIds: readonly string[] = []): string[] {
  const done = new Set(statuses.filter(status => status.isDone || status.isCancelled).map(status => status.id));
  const archived = new Set(projects?.filter(project => project.isArchived).map(project => project.id) ?? []);
  const excluded = new Set(excludeIds);
  return tasks.filter(task => !task.sprintId && !done.has(task.statusId) && !archived.has(task.projectId) && !excluded.has(task.id)).map(task => task.id);
}
