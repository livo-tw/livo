import { describe, expect, it, vi } from 'vitest';
import { createTaskWorkCommandRunner, executeTaskWorkCommand, getTaskResponsibility, responsibilityTaskPatch, taskWorkErrorCode } from '@/lib/taskWork/client';
import { TaskWorkError } from '@/lib/taskWork/core';
import type { TaskResponsibility } from '@/lib/taskWork/client';
const taskId = '10000000-0000-4000-8000-000000000001';
const me = '10000000-0000-4000-8000-000000000002';
const other = '10000000-0000-4000-8000-000000000003';
const intent = { operation: 'acknowledge' as const, taskId, role: 'assignee' as const, expectedRevision: 4 };
const state: TaskResponsibility = { id: taskId, assignee_id: me, reviewer_id: other, assignee_revision: 4, reviewer_revision: 2, assignee_acknowledged_at: '2026-10-03T01:00:00Z', reviewer_acknowledged_at: null };
const result = (commandId: string): { commandId: string; replayed: boolean; eventId: string; task: TaskResponsibility; record: null } => ({ commandId, replayed: false, eventId: 'event-1', task: state, record: null });
describe('task work client identity and retry boundaries', () => {
  it('sends only the command and uses the authenticated function transport', async () => {
    const invoke = vi.fn(async (_name, options) => ({ data: result(options.body.commandId), error: null }));
    await createTaskWorkCommandRunner({ functions: { invoke } } as never)(intent);
    expect(invoke.mock.calls[0][0]).toBe('task-work-command');
    expect(Object.keys(invoke.mock.calls[0][1].body).sort()).toEqual(['commandId', 'expectedRevision', 'operation', 'role', 'taskId']);
  });
  it('coalesces concurrent clicks and preserves the command ID after an uncertain result', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockRejectedValueOnce(new Error('lost response'))
      .mockImplementation(async (_name, options) => ({ data: result(options.body.commandId), error: null }));
    const run = createTaskWorkCommandRunner({ functions: { invoke } } as never);
    const first = run(intent); expect(run(intent)).toBe(first);
    await expect(first).rejects.toMatchObject({ code: 'work_transport_error' });
    await run(intent);
    expect(new Set(invoke.mock.calls.map(call => call[1].body.commandId)).size).toBe(1);
  });
  it('does not retry a definite permission failure', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: { error: 'work_forbidden' }, error: null });
    await expect(createTaskWorkCommandRunner({ functions: { invoke } } as never)(intent)).rejects.toMatchObject({ code: 'work_forbidden' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('uses the live task state on a replay without accepting a newer assignment', async () => {
    const invoke = vi.fn(async (_name, options) => ({ data: { ...result(options.body.commandId), replayed: true,
      task: { ...state, assignee_id: other, assignee_revision: 5, assignee_acknowledged_at: null } }, error: null }));
    const saved = await createTaskWorkCommandRunner({ functions: { invoke } } as never)(intent);
    expect(saved.task.assignee_revision).toBe(5);
    expect(saved.task.assignee_acknowledged_at).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('keeps the error response whitelist even when HTTP errors contain private detail', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: null, error: { message: 'private database detail', context: new Response(JSON.stringify({ error: 'work_conflict' }), { status: 409 }) } });
    await expect(createTaskWorkCommandRunner({ functions: { invoke } } as never)(intent)).rejects.toMatchObject({ code: 'work_conflict' });
    expect(taskWorkErrorCode(new Error('private server information'))).toBe('work_unavailable');
  });
  it.each(['task', 'revision', 'acknowledgement', 'receipt'])('rejects a mismatched %s response', async kind => {
    const invoke = vi.fn(async (_name, options) => {
      const data = result(options.body.commandId);
      if (kind === 'task') data.task = { ...state, id: other };
      if (kind === 'revision') data.task = { ...state, assignee_revision: 3 };
      if (kind === 'acknowledgement') data.task = { ...state, assignee_acknowledged_at: null as never };
      if (kind === 'receipt') data.commandId = 'different-command';
      return { data, error: null };
    });
    await expect(executeTaskWorkCommand({ functions: { invoke } } as never, { ...intent, commandId: '10000000-0000-4000-8000-000000000004' })).rejects.toMatchObject({ code: 'work_transport_error' });
  });
  it('loads an authoritative task row and refuses unavailable/malformed revisions', async () => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue({ data: [state], error: null }) };
    expect(await getTaskResponsibility({ from: vi.fn(() => query) } as never, taskId)).toEqual(state);
    query.limit.mockResolvedValueOnce({ data: [{ ...state, reviewer_revision: -1 }], error: null });
    await expect(getTaskResponsibility({ from: vi.fn(() => query) } as never, taskId)).rejects.toBeInstanceOf(TaskWorkError);
  });
  it('cannot overwrite a newer assignment or an optimistic change with an old acknowledgement', () => {
    const current = { id: taskId, assigneeId: other, assigneeRevision: 5, reviewerId: me, reviewerRevision: 2 };
    expect(responsibilityTaskPatch(state, current as never)).toEqual({});
    expect(responsibilityTaskPatch(state, { ...current, assigneeId: me, assigneeRevision: 4, reviewerId: other } as never)).toMatchObject({ assigneeAcknowledgedAt: state.assignee_acknowledged_at, reviewerAcknowledgedAt: undefined });
  });
});
