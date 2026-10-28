import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useSprintState } from '@/context/hooks/useSprintState';
import type { SprintRow } from '@/context/mappers';
import type { SprintCommand } from '@/lib/sprintLifecycle';

type ReadReply = { data: SprintRow[] | null; error: { message: string } | null };
type RpcReply = { data: unknown; error: { message: string } | null };
const boundary = vi.hoisted(() => ({
  read: vi.fn<() => Promise<ReadReply>>(),
  rpc: vi.fn<(name: string, args: { p_command: SprintCommand }) => Promise<RpcReply>>(),
  error: vi.fn(), success: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  from: (table: string) => {
    if (table !== 'sprints') throw new Error('Unexpected example table');
    return { select: () => ({ order: boundary.read }) };
  },
  rpc: boundary.rpc,
} }));
vi.mock('sonner', () => ({ toast: { error: boundary.error, success: boundary.success } }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const row = (id: string, version = 1, active = true): SprintRow => ({
  id, name: `Example ${id}`, started_at: '2026-01-01T00:00:00Z', completed_at: active ? null : '2026-01-02T00:00:00Z',
  completed_count: 0, cancelled_count: 0, pending_count: 0, is_active: active, history_captured_at: active ? null : '2026-01-02T00:00:00Z', version,
});
const read = (...rows: SprintRow[]): ReadReply => ({ data: rows, error: null });
beforeEach(() => { boundary.read.mockReset(); boundary.rpc.mockReset(); boundary.error.mockReset(); boundary.success.mockReset(); });
afterEach(() => cleanup());

describe('actual sprint state identity and read ordering', () => {
  it('starts a fresh read when member binding finishes and ignores the earlier initial-loader response', async () => {
    const early = deferred<ReadReply>(), fresh = deferred<ReadReply>();
    boundary.read.mockReturnValueOnce(early.promise).mockReturnValueOnce(fresh.promise);
    const view = renderHook(({ actor }: { actor: string | undefined }) => useSprintState(actor), { initialProps: { actor: undefined } });
    let initialRead!: Promise<void>;
    act(() => { initialRead = view.result.current.refreshSprints(); });
    expect(boundary.read).toHaveBeenCalledTimes(1);
    view.rerender({ actor: 'member-a' });
    await waitFor(() => expect(boundary.read).toHaveBeenCalledTimes(2));
    await act(async () => { fresh.resolve(read(row('member-a-active', 4))); await fresh.promise; });
    expect(view.result.current.currentSprint?.id).toBe('member-a-active');
    expect(view.result.current.sprintActive).toBe(true);
    await act(async () => { early.resolve(read(row('pre-binding-stale'))); await initialRead; });
    expect(view.result.current.sprints.map(sprint => sprint.id)).toEqual(['member-a-active']);
    expect(view.result.current.currentSprint?.version).toBe(4);
    expect(boundary.rpc).not.toHaveBeenCalled();
  });

  it('clears the previous account immediately and cannot refill it from a late read while the next account loads', async () => {
    const oldAccount = deferred<ReadReply>(), newAccount = deferred<ReadReply>();
    boundary.read.mockResolvedValueOnce(read(row('account-a-active'))).mockReturnValueOnce(oldAccount.promise).mockReturnValueOnce(newAccount.promise);
    const view = renderHook(({ actor }) => useSprintState(actor), { initialProps: { actor: 'account-a' } });
    await waitFor(() => expect(view.result.current.currentSprint?.id).toBe('account-a-active'));
    let oldRead!: Promise<void>;
    act(() => { oldRead = view.result.current.refreshSprints(); });
    view.rerender({ actor: 'account-b' });
    expect(view.result.current.sprints).toEqual([]);
    expect(view.result.current.currentSprint).toBeNull();
    expect(view.result.current.sprintActive).toBe(false);
    expect(view.result.current.sprintStartedAt).toBeNull();
    await act(async () => { oldAccount.resolve(read(row('account-a-late', 7))); await oldRead; });
    expect(view.result.current.currentSprint).toBeNull();
    await act(async () => { newAccount.resolve(read(row('account-b-active', 2))); await newAccount.promise; });
    expect(view.result.current.sprints.map(sprint => sprint.id)).toEqual(['account-b-active']);
    expect(view.result.current.currentSprint?.version).toBe(2);
    expect(boundary.read).toHaveBeenCalledTimes(3);
  });

  it('keeps the latest requested refresh when same-account responses finish in reverse order', async () => {
    const older = deferred<ReadReply>(), newer = deferred<ReadReply>();
    boundary.read.mockResolvedValueOnce(read(row('initial'))).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const view = renderHook(() => useSprintState('account-a'));
    await waitFor(() => expect(view.result.current.currentSprint?.id).toBe('initial'));
    let oldRead!: Promise<void>, newRead!: Promise<void>;
    act(() => { oldRead = view.result.current.refreshSprints(); newRead = view.result.current.refreshSprints(); });
    await act(async () => { newer.resolve(read(row('newest', 3))); await newRead; });
    await act(async () => { older.resolve(read(row('older', 2))); await oldRead; });
    expect(view.result.current.sprints.map(sprint => sprint.id)).toEqual(['newest']);
    expect(view.result.current.currentSprint?.version).toBe(3);
    expect(boundary.rpc).not.toHaveBeenCalled();
  });

  it('keeps a committed command successful when view refresh fails and does not send it again for recovery', async () => {
    boundary.read.mockResolvedValueOnce(read(row('active', 4)))
      .mockResolvedValueOnce({ data: null, error: { message: 'Example read failure' } })
      .mockResolvedValueOnce(read(row('active', 5, false)));
    boundary.rpc.mockImplementation(async (_name, args) => ({
      data: { sprintId: args.p_command.sprintId, version: 5, completedCount: 0, cancelledCount: 0, pendingCount: 0, pendingIds: [], carryIds: [], taskIds: [] }, error: null,
    }));
    const refreshTasks = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('Example task refresh failure'));
    const view = renderHook(() => useSprintState('account-a'));
    await waitFor(() => expect(view.result.current.currentSprint?.id).toBe('active'));
    await act(async () => {
      const result = await view.result.current.createCompleteSprint([], [], refreshTasks)('backlog');
      expect(result).toEqual({ pendingIds: [], carryIds: [] });
    });
    expect(boundary.rpc).toHaveBeenCalledTimes(1);
    expect(boundary.rpc.mock.calls[0][1].p_command).toMatchObject({ operation: 'complete', sprintId: 'active', expectedVersion: 4 });
    expect(view.result.current.commandState).toEqual({ busy: false, unresolved: false });
    expect(boundary.error).toHaveBeenCalledWith('sprint.savedRefreshFailed');
    expect(refreshTasks).toHaveBeenCalledTimes(1);
    await act(async () => { await view.result.current.refreshSprints(); });
    expect(view.result.current.currentSprint).toBeNull();
    expect(view.result.current.sprints[0].version).toBe(5);
    expect(boundary.rpc).toHaveBeenCalledTimes(1);
  });
});
