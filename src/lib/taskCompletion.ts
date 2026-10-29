import type { Status, Task } from '@/types';

type StatusFlags = Pick<Status, 'isDone' | 'isCancelled'>;

/** Terminal cards leave open work; only successful completion earns completion. */
export function isCompletedStatus(status?: StatusFlags): boolean {
  return Boolean(status?.isDone && !status.isCancelled);
}

export function isTerminalStatus(status?: StatusFlags): boolean {
  return Boolean(status?.isDone || status?.isCancelled);
}

export function summarizeTaskCompletion(tasks: readonly Pick<Task, 'statusId'>[], statuses: readonly (StatusFlags & Pick<Status, 'id'>)[]) {
  const byId = new Map(statuses.map(status => [status.id, status]));
  let done = 0, cancelled = 0, active = 0;
  for (const task of tasks) {
    const status = byId.get(task.statusId);
    if (status?.isCancelled) cancelled++;
    else if (isCompletedStatus(status)) done++;
    else active++;
  }
  const total = tasks.length;
  return { total, done, cancelled, active, pct: total ? Math.round(done / total * 100) : 0 };
}
