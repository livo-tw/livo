import type { Task, User } from '@/types';
import { getDepartment, sortUsersByDept, type Department } from '@/lib/department';
import { sortQaPeople } from '@/lib/qa/peopleOrder';

/** System suggestions are not a saved personal order and cannot override the team order. */
export function sortMemberOptions(users: User[], _preferredUserIds: readonly string[] = []): User[] {
  return users.some(user => 'isExternal' in user || 'qaExternal' in user)
    ? sortQaPeople(users) : sortUsersByDept(users);
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
