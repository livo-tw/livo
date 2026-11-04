import type { Task } from '@/types';

export function matchesStandupMember(
  task: Pick<Task, 'assigneeId' | 'reviewerId'>,
  memberId: string,
  includeReviewTasks: boolean,
): boolean {
  return task.assigneeId === memberId || (includeReviewTasks && task.reviewerId === memberId);
}
