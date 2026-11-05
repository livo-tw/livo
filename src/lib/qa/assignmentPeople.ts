import type { User } from '@/types';

export type QaAssignmentUser = User & { qaExternal?: boolean };
/** API candidates carry a server-derived identity kind. Ordinary member-context
 * rows are internal; no identifier or display name is used to guess a role. */
export function qaRepairAssigneeOptions(people: readonly QaAssignmentUser[] | undefined): readonly User[] | undefined {
  return people?.filter(person => person.qaExternal !== true);
}
