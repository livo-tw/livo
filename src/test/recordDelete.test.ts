import { describe, expect, it, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: { auth: { getSession: vi.fn() } } }));
import { canDeleteTaskRecord, isUntouchedTask } from '@/lib/permissions';
import { canQaDelete, type QaContext } from '@/lib/qa/domain';
import { createQaClient } from '@/lib/qa/client';
import { activityActionLabelKey } from '@/lib/activityActions';

// Who may delete a task or a bug (team decision, 2026-10). Both servers enforce the same rules.
const statuses = [
  { id: 'todo', sortOrder: 1, isDone: false },
  { id: 'doing', sortOrder: 2, isDone: false },
  { id: 'done', sortOrder: 0, isDone: true },
];
const task = { creatorId: 'me', statusId: 'todo', startedAt: undefined as string | undefined, completedAt: undefined as string | undefined };

describe('deleting a task', () => {
  it('admins delete any task; others only one they created that nobody has picked up', () => {
    for (const role of ['admin', 'super_admin']) expect(canDeleteTaskRecord({ ...task, creatorId: 'someone', statusId: 'doing', startedAt: '2026-10-01' }, { id: 'x', role }, statuses)).toBe(true);
    expect(canDeleteTaskRecord(task, { id: 'me', role: 'member' }, statuses)).toBe(true);
    expect(canDeleteTaskRecord(task, { id: 'other', role: 'member' }, statuses)).toBe(false);
    expect(canDeleteTaskRecord({ ...task, statusId: 'doing' }, { id: 'me', role: 'member' }, statuses)).toBe(false);
    expect(canDeleteTaskRecord({ ...task, startedAt: '2026-10-01' }, { id: 'me', role: 'member' }, statuses)).toBe(false);
    expect(canDeleteTaskRecord({ ...task, completedAt: '2026-10-01' }, { id: 'me', role: 'member' }, statuses)).toBe(false);
    expect(canDeleteTaskRecord(task, null, statuses)).toBe(false);
  });
  it('treats the lowest open column as the starting one, whatever the done columns are ordered', () => {
    expect(isUntouchedTask({ ...task, statusId: 'done' }, statuses)).toBe(false);
    expect(isUntouchedTask(task, [{ id: 'todo', sortOrder: 5, isDone: false }, { id: 'backlog', sortOrder: 5, isDone: false }])).toBe(true);
    expect(isUntouchedTask(task, [])).toBe(false);
  });
});

describe('deleting a bug', () => {
  const issue = { reporterId: 'reporter', state: 'new' as const };
  it('admins and QA admins delete any bug; the reporter only while it is new', () => {
    expect(canQaDelete({ ...issue, state: 'closed' }, { id: 'a', role: 'admin' })).toBe(true);
    expect(canQaDelete({ ...issue, state: 'in_progress' }, { id: 'a', role: 'super_admin' })).toBe(true);
    expect(canQaDelete({ ...issue, state: 'verified' }, { id: 'q', role: 'member', qaAdmin: true })).toBe(true);
    expect(canQaDelete(issue, { id: 'reporter', role: 'member' })).toBe(true);
    expect(canQaDelete({ ...issue, state: 'triaged' }, { id: 'reporter', role: 'member' })).toBe(false);
    expect(canQaDelete(issue, { id: 'someone', role: 'member', qaCoordinatorProjectIds: ['p1'] })).toBe(false);
  });
  it('removes the bug in demo mode with the same checks', async () => {
    const ctx: QaContext = { actor: { id: 'reporter', role: 'member' }, workspaceId: crypto.randomUUID(), now: '2026-10-05T00:00:00Z', newId: () => crypto.randomUUID(),
      memberIds: new Set(['reporter', 'admin', 'other']), projectIds: new Set(['p1']), taskIds: new Set() };
    const client = createQaClient({ enabled: () => true, context: () => ctx, mock: true });
    const bug = await client.create({ projectId: 'p1', title: 'Typo', actual: 'Wrong label', observedEnvironment: 'Stage' });
    ctx.actor = { id: 'other', role: 'member' };
    await expect(client.delete(bug)).rejects.toMatchObject({ code: 'qa_forbidden' });
    ctx.actor = { id: 'reporter', role: 'member' };
    await expect(client.delete({ ...bug, version: bug.version + 1 })).rejects.toMatchObject({ status: 409 });
    await client.delete(bug);
    await expect(client.get(bug.id)).rejects.toMatchObject({ status: 404 });
  });
  it('names the deletion in the activity log', () => {
    expect(activityActionLabelKey('delete_qa_issue')).toBe('activityLog.extra.delete_qa_issue');
  });
});
