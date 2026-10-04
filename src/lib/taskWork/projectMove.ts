import type { Task } from '@/types';

/**
 * Local mirror of the server rule: a subtask always shares its parent's project,
 * so moving a parent card moves its subtasks too (one statement on the server).
 * A failed save refreshes from the server, which undoes this optimistic change.
 */
export function applyTaskUpdate(tasks: Task[], updated: Task, previousProjectId: string): Task[] {
  const parentMoved = updated.projectId !== previousProjectId && !updated.parentTaskId;
  return tasks.map(item => item.id === updated.id ? updated
    : parentMoved && item.parentTaskId === updated.id ? { ...item, projectId: updated.projectId } : item);
}
