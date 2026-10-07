import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSidebarOrder } from '@/hooks/useSidebarOrder';
import type { SidebarOrder } from '@/lib/sidebarOrder';

type ReadResult = { data: { visible_keys: unknown } | null; error: { message: string } | null };
type WriteResult = { error: { message: string } | null };
const mock = vi.hoisted(() => ({ from: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: mock.from } }));
const viewKey = 'sidebar-personal-order:v1';
const original: SidebarOrder = { version: 1, lineOrder: ['line-a'], projectOrder: ['project-a'] };
const desired: SidebarOrder = { version: 1, lineOrder: ['line-b', 'line-a'], projectOrder: ['project-b', 'project-a'] };
const other: SidebarOrder = { version: 1, lineOrder: ['other-line'], projectOrder: ['other-project'] };
const row = (order: unknown): ReadResult => ({ data: { visible_keys: order }, error: null });
const failure = (): ReadResult => ({ data: null, error: { message: 'synthetic read failure' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.read.mockReset().mockResolvedValue(row(original));
  mock.write.mockReset().mockResolvedValue({ error: null });
  mock.from.mockImplementation(() => {
    const filters: Record<string, string> = {};
    const query: { select: (columns: string) => unknown; eq: (key: string, value: string) => unknown; maybeSingle: () => Promise<ReadResult>; upsert: typeof mock.write } = {
      select: vi.fn(() => query),
      eq: vi.fn((key: string, value: string) => { filters[key] = value; return query; }),
      maybeSingle: () => mock.read(filters.member_id, filters.view_key),
      upsert: mock.write,
    };
    return query;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function loaded(memberId = 'workspace-one:member-one') {
  const hook = renderHook(() => useSidebarOrder(memberId));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe('account-scoped sidebar preference persistence', () => {
  it('loads a single versioned preference from the shared account store on another device', async () => {
    const { result } = await loaded();
    expect(result.current.lineOrder).toEqual(original.lineOrder);
    expect(result.current.projectOrder).toEqual(original.projectOrder);
    expect(result.current.error).toBeNull();
    expect(mock.from).toHaveBeenCalledWith('user_column_configs');
    expect(mock.read).toHaveBeenCalledOnce();
    expect(mock.read).toHaveBeenCalledWith('workspace-one:member-one', viewKey);
    expect(mock.write).not.toHaveBeenCalled();
  });

  it('uses name-order defaults when the member has no saved row', async () => {
    mock.read.mockResolvedValue({ data: null, error: null });
    const { result } = await loaded();
    expect(result.current.lineOrder).toEqual([]);
    expect(result.current.projectOrder).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('blocks writes until the initial read has completed', async () => {
    const pending = deferred<ReadResult>();
    mock.read.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useSidebarOrder('member-one'));
    expect(result.current.loading).toBe(true);
    let ok = true;
    await act(async () => { ok = await result.current.save(desired); });
    expect(ok).toBe(false);
    expect(mock.write).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(row(original)); });
    expect(result.current.lineOrder).toEqual(original.lineOrder);
  });

  it.each([failure(), row({ version: 1, lineOrder: ['bad'], projectOrder: 'invalid' })])
    ('blocks saves after a failed or malformed account read', async initialRead => {
      mock.read.mockResolvedValue(initialRead);
      const { result } = await loaded();
      expect(result.current.error).toBe('load');
      let ok = true;
      await act(async () => { ok = await result.current.save(desired); });
      expect(ok).toBe(false);
      expect(mock.write).not.toHaveBeenCalled();
    });

  it('does not access or write preferences without a member identity', async () => {
    const { result } = await loaded('');
    let ok = true;
    await act(async () => { ok = await result.current.save(desired); });
    expect(ok).toBe(false);
    expect(mock.read).not.toHaveBeenCalled();
    expect(mock.write).not.toHaveBeenCalled();
  });

  it('previews, atomically saves both orders, and reports success only after matching readback', async () => {
    const { result } = await loaded();
    mock.read.mockResolvedValueOnce(row(original)).mockResolvedValueOnce(row(desired));
    let ok = false;
    await act(async () => { ok = await result.current.save(desired); });
    expect(ok).toBe(true);
    expect(mock.write).toHaveBeenCalledOnce();
    expect(mock.write).toHaveBeenCalledWith({
      member_id: 'workspace-one:member-one', view_key: viewKey, visible_keys: desired, updated_at: expect.any(String),
    }, { onConflict: 'member_id,view_key' });
    expect(mock.read).toHaveBeenCalledTimes(3);
    expect(result.current.lineOrder).toEqual(desired.lineOrder);
    expect(result.current.projectOrder).toEqual(desired.projectOrder);
    expect(result.current.error).toBeNull();
    expect(result.current.saving).toBe(false);
  });

  it.each([failure(), row({ version: 99, lineOrder: [], projectOrder: [] })])
    ('stops before upsert if its fresh preview fails or is malformed', async preview => {
      const { result } = await loaded();
      mock.read.mockResolvedValueOnce(preview);
      let ok = true;
      await act(async () => { ok = await result.current.save(desired); });
      expect(ok).toBe(false);
      expect(mock.write).not.toHaveBeenCalled();
      expect(result.current.lineOrder).toEqual(original.lineOrder);
      expect(result.current.error).toBe('save');
    });

  it('keeps the old displayed order and reports a failed upsert', async () => {
    const { result } = await loaded();
    mock.write.mockResolvedValueOnce({ error: { message: 'synthetic save failure' } });
    let ok = true;
    await act(async () => { ok = await result.current.save(desired); });
    expect(ok).toBe(false);
    expect(result.current.lineOrder).toEqual(original.lineOrder);
    expect(result.current.projectOrder).toEqual(original.projectOrder);
    expect(result.current.error).toBe('save');
    expect(result.current.saving).toBe(false);
  });

  it.each([failure(), { data: null, error: null }, row(other)])
    ('does not claim success when the upsert outcome cannot be confirmed', async readback => {
      const { result } = await loaded();
      mock.read.mockResolvedValueOnce(row(original)).mockResolvedValueOnce(readback);
      let ok = true;
      await act(async () => { ok = await result.current.save(desired); });
      expect(ok).toBe(false);
      expect(mock.write).toHaveBeenCalledOnce();
      expect(result.current.lineOrder).toEqual(original.lineOrder);
      expect(result.current.projectOrder).toEqual(original.projectOrder);
      expect(result.current.error).toBe('save');
    });

  it('reconciles an uncertain successful write before retrying and does not write it twice', async () => {
    let remote: SidebarOrder = original;
    mock.read.mockImplementation(async () => row(remote));
    const { result } = await loaded();
    mock.write.mockImplementationOnce(async () => {
      remote = desired;
      return { error: { message: 'synthetic response lost after commit' } };
    });
    let first = true, retry = false;
    await act(async () => { first = await result.current.save(desired); });
    expect(first).toBe(false);
    await act(async () => { retry = await result.current.save(desired); });
    expect(retry).toBe(true);
    expect(mock.write).toHaveBeenCalledOnce();
    expect(result.current.lineOrder).toEqual(desired.lineOrder);
    expect(result.current.error).toBeNull();
  });

  it('ignores an old member load after the next member has loaded', async () => {
    const pending = deferred<ReadResult>();
    mock.read.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(row(other));
    const { result, rerender } = renderHook(({ member }) => useSidebarOrder(member), { initialProps: { member: 'member-a' } });
    rerender({ member: 'member-b' });
    expect(result.current.loading).toBe(true);
    expect(result.current.lineOrder).toEqual([]);
    await waitFor(() => expect(result.current.lineOrder).toEqual(other.lineOrder));
    await act(async () => { pending.resolve(row(original)); });
    expect(result.current.lineOrder).toEqual(other.lineOrder);
    expect(mock.read).toHaveBeenLastCalledWith('member-b', viewKey);
  });

  it('guards generations when a member returns before that member previous fetch completes', async () => {
    const first = deferred<ReadResult>();
    mock.read.mockReturnValueOnce(first.promise).mockResolvedValueOnce(row(other)).mockResolvedValueOnce(row(desired));
    const { result, rerender } = renderHook(({ member }) => useSidebarOrder(member), { initialProps: { member: 'member-a' } });
    rerender({ member: 'member-b' });
    await waitFor(() => expect(result.current.lineOrder).toEqual(other.lineOrder));
    rerender({ member: 'member-a' });
    await waitFor(() => expect(result.current.lineOrder).toEqual(desired.lineOrder));
    await act(async () => { first.resolve(row(original)); });
    expect(result.current.lineOrder).toEqual(desired.lineOrder);
  });

  it('does not send an old save after switching identity during its preview', async () => {
    const pending = deferred<ReadResult>();
    const { result, rerender } = renderHook(({ member }) => useSidebarOrder(member), { initialProps: { member: 'member-a' } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    mock.read.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(row(other));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save(desired); });
    rerender({ member: 'member-b' });
    await waitFor(() => expect(result.current.lineOrder).toEqual(other.lineOrder));
    await act(async () => { pending.resolve(row(original)); expect(await saving).toBe(false); });
    expect(mock.write).not.toHaveBeenCalled();
    expect(result.current.lineOrder).toEqual(other.lineOrder);
    expect(result.current.saving).toBe(false);
  });

  it('does not publish old upsert completion or make readback for another identity', async () => {
    const pending = deferred<WriteResult>();
    const { result, rerender } = renderHook(({ member }) => useSidebarOrder(member), { initialProps: { member: 'member-a' } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    mock.write.mockReturnValueOnce(pending.promise);
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save(desired); });
    await waitFor(() => expect(mock.write).toHaveBeenCalledOnce());
    mock.read.mockResolvedValueOnce(row(other));
    rerender({ member: 'member-b' });
    await waitFor(() => expect(result.current.lineOrder).toEqual(other.lineOrder));
    const readsBeforeResolution = mock.read.mock.calls.length;
    await act(async () => { pending.resolve({ error: null }); expect(await saving).toBe(false); });
    expect(mock.read).toHaveBeenCalledTimes(readsBeforeResolution);
    expect(result.current.lineOrder).toEqual(other.lineOrder);
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does not publish a delayed save readback into the next member snapshot', async () => {
    const pending = deferred<ReadResult>();
    const { result, rerender } = renderHook(({ member }) => useSidebarOrder(member), { initialProps: { member: 'member-a' } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    mock.read.mockResolvedValueOnce(row(original)).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(row(other));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save(desired); });
    await waitFor(() => expect(mock.read).toHaveBeenCalledTimes(3));
    rerender({ member: 'member-b' });
    await waitFor(() => expect(result.current.lineOrder).toEqual(other.lineOrder));
    await act(async () => { pending.resolve(row(desired)); expect(await saving).toBe(false); });
    expect(result.current.lineOrder).toEqual(other.lineOrder);
    expect(result.current.projectOrder).toEqual(other.projectOrder);
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('rejects a second save while the first preview is outstanding', async () => {
    const pending = deferred<ReadResult>();
    const { result } = await loaded();
    mock.read.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(row(desired));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save(desired); });
    let second = true;
    await act(async () => { second = await result.current.save(other); });
    expect(second).toBe(false);
    expect(mock.write).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(row(original)); expect(await saving).toBe(true); });
    expect(mock.write).toHaveBeenCalledOnce();
    expect(result.current.projectOrder).toEqual(desired.projectOrder);
  });
  it('waits for an earlier account write and fresh readback when switching A to B to A', async () => {
    const pendingWrite = deferred<WriteResult>();
    const pendingReload = deferred<ReadResult>();
    let remoteA: SidebarOrder = original;
    let holdReload = false;
    mock.read.mockImplementation(async (member: string) => {
      if (member === 'member-b') return row(other);
      return holdReload ? pendingReload.promise : row(remoteA);
    });
    mock.write.mockImplementation(async (value: { visible_keys: SidebarOrder }) => {
      remoteA = value.visible_keys;
      return { error: null };
    });
    mock.write.mockImplementationOnce(async (value: { visible_keys: SidebarOrder }) => {
      await pendingWrite.promise;
      remoteA = value.visible_keys;
      holdReload = true;
      return { error: null };
    });
    const { result, rerender } = renderHook(({ member }) => useSidebarOrder(member), { initialProps: { member: 'member-a' } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let oldSave!: Promise<boolean>;
    act(() => { oldSave = result.current.save(desired); });
    await waitFor(() => expect(mock.write).toHaveBeenCalledOnce());

    rerender({ member: 'member-b' });
    await waitFor(() => expect(result.current.lineOrder).toEqual(other.lineOrder));
    rerender({ member: 'member-a' });
    await waitFor(() => expect(result.current.lineOrder).toEqual(original.lineOrder));
    expect(result.current.saving).toBe(true);
    let whilePending = true;
    await act(async () => { whilePending = await result.current.save(other); });
    expect(whilePending).toBe(false);
    expect(mock.write).toHaveBeenCalledOnce();

    const readsBeforeCommit = mock.read.mock.calls.length;
    await act(async () => { pendingWrite.resolve({ error: null }); expect(await oldSave).toBe(false); });
    await waitFor(() => expect(mock.read).toHaveBeenCalledTimes(readsBeforeCommit + 1));
    expect(result.current.loading).toBe(true);
    let beforeReadback = true;
    await act(async () => { beforeReadback = await result.current.save(other); });
    expect(beforeReadback).toBe(false);
    expect(mock.write).toHaveBeenCalledOnce();

    await act(async () => { holdReload = false; pendingReload.resolve(row(remoteA)); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.lineOrder).toEqual(desired.lineOrder);
    expect(result.current.projectOrder).toEqual(desired.projectOrder);
    expect(result.current.saving).toBe(false);
    let afterReadback = false;
    await act(async () => { afterReadback = await result.current.save(other); });
    expect(afterReadback).toBe(true);
    expect(mock.write).toHaveBeenCalledTimes(2);
    expect(result.current.lineOrder).toEqual(other.lineOrder);
  });
});
