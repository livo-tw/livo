import type { Status, Task } from '@/types';

export type SprintOutcome = 'completed' | 'cancelled' | 'pending' | 'removed' | 'unknown';
export type SprintCommand =
  | { commandId: string; operation: 'start'; sprintId: string; name: string; taskIds: string[]; includeBacklog: boolean }
  | { commandId: string; operation: 'complete'; sprintId: string; expectedVersion: number };
export type SprintIntent = SprintCommand extends infer C ? C extends SprintCommand ? Omit<C, 'commandId'> : never : never;
export interface SprintCommandResult {
  sprintId: string;
  version: number;
  completedCount: number;
  cancelledCount: number;
  pendingCount: number;
  pendingIds: string[];
  carryIds?: string[];
  taskIds: string[];
  replayed?: boolean;
}
export interface SprintHistoryRecord {
  id: string;
  sprint_id: string;
  task_id: string;
  task_key: string;
  title: string;
  project_id: string;
  status_id: string;
  status_name: string;
  assignee_id: string | null;
  parent_task_id: string | null;
  outcome: SprintOutcome;
  source: 'snapshot' | 'observed' | 'legacy';
  recorded_at: string;
}

export function sprintOutcome(status?: Pick<Status, 'isDone' | 'isCancelled'>): 'completed' | 'cancelled' | 'pending' {
  if (status?.isCancelled) return 'cancelled';
  return status?.isDone ? 'completed' : 'pending';
}

export function sprintSummary(tasks: readonly Task[], statuses: readonly Status[]) {
  const byId = new Map(statuses.map(status => [status.id, status]));
  const completed: Task[] = [], cancelled: Task[] = [], pending: Task[] = [];
  for (const task of tasks) {
    const outcome = sprintOutcome(byId.get(task.statusId));
    (outcome === 'completed' ? completed : outcome === 'cancelled' ? cancelled : pending).push(task);
  }
  return { completed, cancelled, pending };
}

/** An explicit active-sprint view never includes unassigned historical cards. */
export function tasksInSprint<T extends Pick<Task, 'sprintId'>>(tasks: readonly T[], sprintId: string | null): T[] {
  return sprintId ? tasks.filter(task => task.sprintId === sprintId) : [...tasks];
}
