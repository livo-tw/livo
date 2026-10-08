import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskComments } from '@/components/task-detail/hooks/useTaskComments';
import type { Comment, Project, Status, Task, User } from '@/types';

const mocks = vi.hoisted(() => ({
  insert: vi.fn(async (_table: string, _row: Record<string, unknown>) => ({ error: null })),
  update: vi.fn(async () => ({ error: null })),
  slackNotify: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  from: (table: string) => ({
    insert: (row: Record<string, unknown>) => mocks.insert(table, row),
    update: () => ({ eq: mocks.update }),
  }),
} }));
vi.mock('@/lib/generateId', () => ({ generateId: () => 'example-comment' }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/slackNotify', () => ({ sendSlackNotify: mocks.slackNotify }));
vi.mock('@/lib/featureToggleQueries', () => ({ loadFeatureToggles: vi.fn() }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const users = [
  { id: 'example-author', name: 'Alex Example', email: 'alex@example.com', isActive: true },
  { id: 'example-owner', name: 'Morgan Example', email: 'morgan@example.com', isActive: true },
  { id: 'example-reviewer', name: 'Taylor Example', email: 'taylor@example.com', isActive: true },
] as User[];

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('task comment notifications', () => {
  it.each([
    {
      name: 'notifies a shared assignee and reviewer once',
      actorId: 'example-author', assigneeId: 'example-owner', reviewerId: 'example-owner',
      content: '<p>Example update</p>',
      expected: [{ recipient_id: 'example-owner', type: 'comment' }],
    },
    {
      name: 'notifies distinct assignee and reviewer once each',
      actorId: 'example-author', assigneeId: 'example-owner', reviewerId: 'example-reviewer',
      content: '<p>Example update</p>',
      expected: [{ recipient_id: 'example-owner', type: 'comment' }, { recipient_id: 'example-reviewer', type: 'comment' }],
    },
    {
      name: 'keeps one mention notice when the mentioned owner has both roles',
      actorId: 'example-author', assigneeId: 'example-owner', reviewerId: 'example-owner',
      content: '<p><span data-type="mention" data-id="example-owner">@Morgan Example</span> Example update</p>',
      expected: [{ recipient_id: 'example-owner', type: 'mention' }],
    },
    {
      name: 'does not notify the author who has both roles',
      actorId: 'example-owner', assigneeId: 'example-owner', reviewerId: 'example-owner',
      content: '<p>Example update</p>', expected: [],
    },
  ])('$name', async ({ actorId, assigneeId, reviewerId, content, expected }) => {
    const task = {
      id: 'example-task', taskKey: 'EX-1', title: 'Example task', assigneeId, reviewerId,
      commentCount: 0, attachmentCount: 0,
    } as Task;
    const deps = {
      task, currentMemberId: actorId, currentMember: users.find(user => user.id === actorId)!, users,
      allTasks: [task], setAllTasks: vi.fn(), globalComments: [] as Comment[],
      project: { name: 'Example project' } as Project, status: { name: 'Example status' } as Status,
      assignee: users.find(user => user.id === assigneeId)!, MAX_FILE_SIZE: 1024, loadStorageUsage: vi.fn(),
    };
    const { result } = renderHook(() => useTaskComments(deps));
    act(() => { result.current.setNewComment(content); });
    await act(async () => { await result.current.addComment(); });
    const notices = mocks.insert.mock.calls.filter(([table]) => table === 'notifications')
      .map(([, row]) => ({ recipient_id: row.recipient_id, type: row.type }));
    expect(notices).toEqual(expected);
    expect(mocks.insert.mock.calls.filter(([table]) => table === 'comments')).toHaveLength(1);
    expect(mocks.slackNotify).toHaveBeenCalledTimes(1);
  });
});
