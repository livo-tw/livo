import { describe, expect, it } from 'vitest';
import type { Task, User } from '@/types';
import { getDepartmentPreferenceIds, getProjectDeveloperPreferenceIds, sortMemberOptions } from '@/lib/memberSelection';

const user = (id: string, jobTitle: string, sortOrder: number): User => ({ id, name: id,
  jobTitle, sortOrder, isActive: true, avatar: id[0], color: '#123456', email: `${id}@example.com`, role: 'member' });
const users = [user('pm', 'PM', 0), user('otherDev', 'FE', 1), user('qa', 'QA', 2),
  user('projectBe', 'Backend', 5), user('projectFe', 'FE', 3), user('projectSre', 'SRE', 4)];

describe('shared member selection order', () => {
  it('keeps the team order and eligible set even when a caller suggests QA first', () => {
    expect(sortMemberOptions(users, getDepartmentPreferenceIds(users, ['QA'])).map(row => row.id))
      .toEqual(['pm', 'otherDev', 'qa', 'projectFe', 'projectSre', 'projectBe']);
    expect(sortMemberOptions(users).map(row => row.id))
      .toEqual(['pm', 'otherDev', 'qa', 'projectFe', 'projectSre', 'projectBe']);
    expect(users.map(row => row.id)).toEqual(['pm', 'otherDev', 'qa', 'projectBe', 'projectFe', 'projectSre']);
  });

  it('does not promote project developers, reviewers or the existing repair owner', () => {
    const tasks = [{ projectId: 'example', assigneeId: 'projectBe', reviewerId: 'projectFe' },
      { projectId: 'example', assigneeId: 'pm', reviewerId: 'qa' },
      { projectId: 'other', assigneeId: 'otherDev' }] as Task[];
    const preferred = getProjectDeveloperPreferenceIds(users, tasks, 'example', 'projectSre');
    expect(preferred).toEqual(['projectBe', 'projectFe', 'projectSre']);
    expect(sortMemberOptions(users, preferred).map(row => row.id))
      .toEqual(['pm', 'otherDev', 'qa', 'projectFe', 'projectSre', 'projectBe']);
  });

  it('does not infer project membership from unrelated tasks or creation alone', () => {
    const tasks = [{ projectId: 'other', assigneeId: 'projectBe' },
      { projectId: 'example', creatorId: 'otherDev' }] as Task[];
    expect(getProjectDeveloperPreferenceIds(users, tasks, 'example', 'pm')).toEqual([]);
  });
});
