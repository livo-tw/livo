import type { Task, User } from '@/types';
import { getDepartment, sortUsersByDept, type Department } from '@/lib/department';

/** Preferences change presentation order; they never restrict who can be selected. */
export function sortMemberOptions(users: User[], preferredUserIds: readonly string[] = []): User[] {
  const preferred = new Set(preferredUserIds);
  return sortUsersByDept(users).sort((a, b) => Number(preferred.has(b.id)) - Number(preferred.has(a.id)));
}

export function getDepartmentPreferenceIds(users: User[], departments: readonly Department[]): string[] {
  const preferred = new Set(departments);
  return users.filter(user => preferred.has(getDepartment(user)!)).map(user => user.id);
}

/** Project participation comes from task responsibility, plus the Bug's existing repair owner. */
export function getProjectDeveloperPreferenceIds(users: User[], tasks: Task[], projectId: string,
  existingAssigneeId?: string | null): string[] {
  const related = new Set<string>();
  if (existingAssigneeId) related.add(existingAssigneeId);
  for (const task of tasks) {
    if (task.projectId !== projectId) continue;
    if (task.assigneeId) related.add(task.assigneeId);
    if (task.reviewerId) related.add(task.reviewerId);
  }
  const developers = new Set(getDepartmentPreferenceIds(users, ['BE', 'FE', 'SRE']));
  return users.filter(user => related.has(user.id) && developers.has(user.id)).map(user => user.id);
}
