import type { Status, Task } from '@/types';

/**
 * Tasks a new sprint takes in automatically: the backlog (no sprint) that is
 * not done. Tasks of earlier sprints and finished tasks keep their history.
 */
export function sprintBacklogTaskIds(tasks: readonly Task[], statuses: readonly Status[]): string[] {
  const done = new Set(statuses.filter(status => status.isDone).map(status => status.id));
  return tasks.filter(task => !task.sprintId && !done.has(task.statusId)).map(task => task.id);
}
