import { describe, expect, it, vi } from 'vitest';
import type { Status, Task } from '@/types';
import { sprintOutcome, sprintSummary, tasksInSprint, type SprintCommand, type SprintCommandResult, type SprintIntent } from '@/lib/sprintLifecycle';
import { createSprintCommandRunner } from '@/lib/sprintCommands';

const status = (id: string, isDone: boolean, isCancelled = false): Status => ({ id, name: id, color: '#667788', sortOrder: 0, isDone, isCancelled, autoStart: false, autoDone: false });
const task = (id: string, statusId: string, sprintId?: string): Task => ({ id, taskKey: `EX-${id}`, projectId: 'project-example', title: `Example ${id}`, statusId, priority: 'medium', creatorId: 'member-example', sortOrder: 0, createdAt: '2026-01-01', commentCount: 0, attachmentCount: 0, deployments: [], ...(sprintId ? { sprintId } : {}) });
const statuses = [status('working', false), status('finished', true), status('cancelled-custom', true, true)];
const intent: SprintIntent = { operation: 'start', sprintId: 'sprint-next', name: 'Example sprint', taskIds: ['task-b', 'task-a'], includeBacklog: false };
const result = (sprintId = 'sprint-next'): SprintCommandResult => ({ sprintId, version: 1, completedCount: 0, cancelledCount: 0, pendingCount: 2, pendingIds: ['task-a', 'task-b'], taskIds: ['task-a', 'task-b'] });
type Reply = { data: unknown; error: unknown };
type Rpc = (name: 'livo_sprint_command', args: { p_command: unknown }) => PromiseLike<Reply>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const commandAt = (rpc: ReturnType<typeof vi.fn<Rpc>>, index: number) => rpc.mock.calls[index][1].p_command as SprintCommand;

describe('sprint lifecycle outcomes and active-only scope', () => {
  it('uses the explicit cancellation flag before terminal completion, independent of name or column order', () => {
    expect(sprintOutcome(status('finished', true))).toBe('completed');
    const renamedCancelled: Status = { ...status('custom', true, true), name: 'Renamed outcome', sortOrder: 0 };
    const cancelledNameOnly: Status = { ...status('custom', true), name: '不做了', sortOrder: 99 };
    expect(sprintOutcome(renamedCancelled)).toBe('cancelled');
    expect(sprintOutcome(cancelledNameOnly)).toBe('completed');
    expect(sprintOutcome(status('cancelled-custom', false, true))).toBe('cancelled');
    expect(sprintOutcome(undefined)).toBe('pending');
  });

  it('keeps cancelled tasks out of completed and pending counts and preserves source tasks', () => {
    const tasks = Object.freeze([task('done', 'finished'), task('cancel', 'cancelled-custom'), task('open', 'working'), task('unknown-status', 'missing')]);
    const summary = sprintSummary(tasks, statuses);
    expect(summary.completed.map(value => value.id)).toEqual(['done']);
    expect(summary.cancelled.map(value => value.id)).toEqual(['cancel']);
    expect(summary.pending.map(value => value.id)).toEqual(['open', 'unknown-status']);
    expect(summary.cancelled[0]).toBe(tasks[1]);
    expect(tasks.map(value => value.id)).toEqual(['done', 'cancel', 'open', 'unknown-status']);
    expect(sprintSummary([], statuses)).toEqual({ completed: [], cancelled: [], pending: [] });
  });

  it('shows only this active sprint including its just-completed and cancelled cards, with unassigned and past/future cards excluded', () => {
    const tasks = [task('now-open', 'working', 'active'), task('now-done', 'finished', 'active'), task('now-cancel', 'cancelled-custom', 'active'), task('old-done', 'finished', 'closed'), task('not-planned-done', 'finished'), task('not-planned-open', 'working'), task('future-open', 'working', 'future')];
    expect(tasksInSprint(tasks, 'active').map(value => value.id)).toEqual(['now-open', 'now-done', 'now-cancel']);
    expect(tasksInSprint(tasks, 'unknown')).toEqual([]);
    const unscoped = tasksInSprint(tasks, null);
    expect(unscoped).toEqual(tasks);
    expect(unscoped).not.toBe(tasks);
  });
});

describe('sprint command identity and recovery', () => {
  it('deduplicates double submission into one in-flight RPC without silently enabling backlog', async () => {
    const response = deferred<Reply>();
    const rpc = vi.fn<Rpc>().mockReturnValue(response.promise);
    const runner = createSprintCommandRunner({ rpc });
    const first = runner.run(intent), second = runner.run({ ...intent, taskIds: [...intent.taskIds] });
    expect(first).toBe(second);
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe('livo_sprint_command');
    expect(commandAt(rpc, 0)).toMatchObject({ ...intent, includeBacklog: false });
    response.resolve({ data: result(), error: null });
    await expect(first).resolves.toEqual(result());
    expect(runner.pending()).toBeNull();
  });

  it('retries a lost response with the same command ID and exact original payload even if selected-ID order changes', async () => {
    const rpc = vi.fn<Rpc>().mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({ data: { ...result(), replayed: true }, error: null });
    const runner = createSprintCommandRunner({ rpc });
    await expect(runner.run(intent)).rejects.toMatchObject({ code: 'sprint_transport_error', uncertain: true });
    const original = commandAt(rpc, 0);
    expect(runner.pending()).toEqual(original);
    await expect(runner.run({ ...intent, taskIds: ['task-a', 'task-b'] })).resolves.toMatchObject({ replayed: true });
    expect(commandAt(rpc, 1)).toEqual(original);
    expect(runner.pending()).toBeNull();
  });

  it('refuses a changed intent while a lost response is unresolved, then permits only that original intent to reconcile', async () => {
    const rpc = vi.fn<Rpc>().mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({ data: result(), error: null });
    const runner = createSprintCommandRunner({ rpc });
    await expect(runner.run(intent)).rejects.toMatchObject({ uncertain: true });
    const original = runner.pending();
    await expect(runner.run({ ...intent, includeBacklog: true })).rejects.toMatchObject({ code: 'sprint_resolve_pending', uncertain: true });
    await expect(runner.run({ operation: 'complete', sprintId: 'other', expectedVersion: 3 })).rejects.toMatchObject({ code: 'sprint_resolve_pending', uncertain: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(runner.pending()).toEqual(original);
    await runner.run(intent);
    expect(commandAt(rpc, 1)).toEqual(original);
  });

  it('retains the unresolved command on a synchronously thrown transport failure and actually retries its RPC', async () => {
    const rpc = vi.fn<Rpc>().mockImplementationOnce(() => { throw new Error('transport unavailable'); }).mockResolvedValueOnce({ data: result(), error: null });
    const runner = createSprintCommandRunner({ rpc });
    await expect(runner.run(intent)).rejects.toMatchObject({ code: 'sprint_transport_error', uncertain: true });
    const original = runner.pending();
    const retry = runner.run(intent);
    const settled = retry.catch(error => error);
    expect(await settled).toEqual(result());
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(commandAt(rpc, 1)).toEqual(original);
    expect(runner.pending()).toBeNull();
  });

  it('clears a known server refusal without inventing success and gives a corrected new operation its own ID', async () => {
    const rpc = vi.fn<Rpc>().mockResolvedValueOnce({ data: null, error: { code: 'PT409', message: 'sprint_conflict' } }).mockResolvedValueOnce({ data: result('active'), error: null });
    const runner = createSprintCommandRunner({ rpc });
    await expect(runner.run(intent)).rejects.toMatchObject({ code: 'sprint_conflict', uncertain: false });
    expect(runner.pending()).toBeNull();
    await runner.run({ operation: 'complete', sprintId: 'active', expectedVersion: 4 });
    expect(commandAt(rpc, 1)).toMatchObject({ operation: 'complete', sprintId: 'active', expectedVersion: 4 });
    expect(commandAt(rpc, 1).commandId).not.toBe(commandAt(rpc, 0).commandId);
  });

  it.each<[string, (value: SprintCommandResult) => unknown]>([
    ['wrong sprint', value => ({ ...value, sprintId: 'different' })],
    ['invalid version', value => ({ ...value, version: 0 })],
    ['negative cancellation count', value => ({ ...value, cancelledCount: -1 })],
    ['invalid member IDs', value => ({ ...value, pendingIds: [''] })],
  ])('keeps the original command on a malformed %s receipt instead of submitting a fresh command', async (_name, corrupt) => {
    const rpc = vi.fn<Rpc>().mockResolvedValueOnce({ data: corrupt(result()), error: null }).mockResolvedValueOnce({ data: result(), error: null });
    const runner = createSprintCommandRunner({ rpc });
    await expect(runner.run(intent)).rejects.toMatchObject({ code: 'sprint_transport_error', uncertain: true });
    const original = runner.pending();
    await runner.run(intent);
    expect(commandAt(rpc, 1)).toEqual(original);
    expect(runner.pending()).toBeNull();
  });
});
