import { afterEach, describe, expect, it, vi } from 'vitest';
import { groupMembers } from '@/hooks/useStandupGrouping';
import { clearStandupLaunch, getStandupLaunch, restoreStandupGroups, saveStandupLaunch } from '@/lib/standupLaunch';
import type { StandupSettings } from '@/hooks/useStandupSettings';
import type { Project, Task, User } from '@/types';

vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));

const person = (id: string): User => ({
  id, name: id, avatar: id[0], role: 'member', jobTitle: 'Engineer',
  color: '#667788', email: `${id}@example.com`, isActive: true, sortOrder: 0,
});
const users = [person('alex'), person('blair')];
const projects: Project[] = [{
  id: 'project', lineId: 'line', name: 'Example project', key: 'EX', color: '#667788', isArchived: false,
}];
const task = (id: string, assigneeId?: string, reviewerId?: string): Task => ({
  id, taskKey: id, projectId: 'project', title: id, statusId: 'todo', priority: 'medium',
  creatorId: 'alex', assigneeId, reviewerId, sortOrder: 0, createdAt: '2026-11-04T00:00:00Z',
  commentCount: 0, attachmentCount: 0, deployments: [],
});
const tasks = [task('shared', 'alex', 'blair'), task('review-only', undefined, 'blair'), task('creator-only', 'someone-else')];
const settings: StandupSettings = {
  defaultSpeakDuration: 120, autoAdvance: true, sortMode: 'by_project', bufferSeconds: 15, memberDurations: {},
};
const duration = () => 120;

afterEach(clearStandupLaunch);

describe('review assignments in standup', () => {
  it('adds a reviewer-only presenter to the project and counts each card once', () => {
    const enabled = groupMembers(users, tasks, projects, 'by_project', duration, 15, true);
    const disabled = groupMembers(users, tasks, projects, 'by_project', duration, 15, false);

    expect(enabled.find(group => group.group_key === 'project')).toMatchObject({ members: users, task_count: 2 });
    expect(disabled.find(group => group.group_key === 'project')).toMatchObject({ members: [users[0]], task_count: 1 });
  });

  it('keeps the launch selection when rebuilding task counts after the meeting starts', () => {
    const groups = groupMembers(users, tasks, projects, 'by_member', duration, 15, true);
    saveStandupLaunch({ ...settings, sortMode: 'by_member', includeReviewTasks: false }, groups);
    const launch = getStandupLaunch();
    expect(launch).toBeDefined();
    if (!launch) throw new Error('Missing standup launch');

    const restored = restoreStandupGroups(launch, users, tasks, duration, 15);
    expect(restored.find(group => group.group_key === 'alex')?.task_count).toBe(1);
    expect(restored.find(group => group.group_key === 'blair')?.task_count).toBe(0);
  });
});
