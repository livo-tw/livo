import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QaDetail } from '@/lib/qa/domain';

const realtime = vi.hoisted(() => ({ events: [] as { filter: Record<string, string>; callback: () => void }[], status: undefined as undefined | ((status: string) => void), remove: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: false, supabase: {
  channel: () => {
    const channel = { on: (_event: string, filter: Record<string, string>, callback: () => void) => { realtime.events.push({ filter, callback }); return channel; },
      subscribe: (callback: (status: string) => void) => { realtime.status = callback; return channel; } };
    return channel;
  }, removeChannel: realtime.remove,
} }));
import { useQaDetailInvalidation } from './useQaDetailInvalidation';
const value = { issue: { id: 'example-bug', version: 2, state: 'closed' } } as QaDetail;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const tick = async (ms = 50) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => { vi.useFakeTimers(); realtime.events = []; realtime.status = undefined; realtime.remove.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
function setup(load = vi.fn().mockResolvedValue(value)) {
  const apply = vi.fn(); let dirty = false;
  const hook = renderHook(({ scope, blocked }) => useQaDetailInvalidation({ issueId: 'example-bug', scope, blocked, isBlocked: () => dirty, load, apply }), { initialProps: { scope: 1, blocked: false } });
  return { ...hook, apply, load, dirty: (next: boolean) => { dirty = next; hook.rerender({ scope: 1, blocked: next }); } };
}
describe('opened QA detail invalidation', () => {
  it('uses scoped realtime events as invalidations and reads authorized detail once for a burst', async () => {
    const h = setup();
    expect(realtime.events.map(event => event.filter)).toEqual([
      { event: '*', schema: 'public', table: 'qa_issues', filter: 'id=eq.example-bug' },
      ...['qa_comments', 'qa_events', 'qa_attachments'].map(table => ({ event: '*', schema: 'public', table, filter: 'issue_id=eq.example-bug' })),
    ]);
    act(() => realtime.events.forEach(event => event.callback())); await tick();
    expect(h.load).toHaveBeenCalledTimes(1); expect(h.load.mock.calls[0][0]).toBeInstanceOf(AbortSignal); expect(h.apply).toHaveBeenCalledWith(value);
  });
  it.each(['focus', 'online', 'livo:qa-changed'])('refreshes an already open detail on %s', async event => {
    const h = setup(); act(() => window.dispatchEvent(new Event(event))); await tick(); expect(h.apply).toHaveBeenCalledWith(value);
  });
  it('refreshes when realtime subscribes again after a disconnect', async () => {
    const h = setup(); act(() => realtime.status?.('SUBSCRIBED')); await tick(); expect(h.load).not.toHaveBeenCalled();
    act(() => { realtime.status?.('CHANNEL_ERROR'); realtime.status?.('SUBSCRIBED'); }); await tick(); expect(h.apply).toHaveBeenCalledTimes(1);
  });
  it('defers while editing and reloads after the draft is cleared', async () => {
    const h = setup(); h.dirty(true); act(() => window.dispatchEvent(new Event('focus'))); await tick();
    expect(h.load).not.toHaveBeenCalled(); expect(h.result.current.pending).toBe(true);
    h.dirty(false); await tick(); expect(h.apply).toHaveBeenCalledWith(value); expect(h.result.current.pending).toBe(false);
  });
  it('does not fill a draft that became dirty during a pending read', async () => {
    const read = deferred<QaDetail>(); const h = setup(vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue(value));
    act(() => window.dispatchEvent(new Event('focus'))); await tick(); h.dirty(true);
    await act(async () => read.resolve(value)); expect(h.apply).not.toHaveBeenCalled(); expect(h.result.current.pending).toBe(true);
    h.dirty(false); await tick(); expect(h.load).toHaveBeenCalledTimes(2); expect(h.apply).toHaveBeenCalledTimes(1);
  });
  it('queues one trailing read when updates arrive during a read', async () => {
    const read = deferred<QaDetail>(); const h = setup(vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue(value));
    act(() => window.dispatchEvent(new Event('focus'))); await tick(); act(() => realtime.events.forEach(event => event.callback()));
    await act(async () => read.resolve(value)); await tick(); expect(h.load).toHaveBeenCalledTimes(2);
  });
  it('aborts on unmount and rejects a late response even if the transport ignores abort', async () => {
    const read = deferred<QaDetail>(); const h = setup(vi.fn().mockReturnValue(read.promise));
    act(() => window.dispatchEvent(new Event('focus'))); await tick(); const signal = h.load.mock.calls[0][0]; h.unmount();
    await act(async () => read.resolve(value)); expect(signal.aborted).toBe(true); expect(h.apply).not.toHaveBeenCalled(); expect(realtime.remove).toHaveBeenCalledTimes(1);
  });
  it('rejects an old visit response after actor or issue A -> B -> A', async () => {
    const read = deferred<QaDetail>(); const h = setup(vi.fn().mockReturnValue(read.promise));
    act(() => window.dispatchEvent(new Event('focus'))); await tick();
    h.rerender({ scope: 2, blocked: false }); h.rerender({ scope: 3, blocked: false });
    await act(async () => read.resolve(value)); expect(h.apply).not.toHaveBeenCalled();
  });
  it('polls only while visible and catches up on visibilitychange', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); const h = setup();
    await tick(30_050); expect(h.load).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible'); act(() => document.dispatchEvent(new Event('visibilitychange'))); await tick(); expect(h.apply).toHaveBeenCalledTimes(1);
    await tick(30_000); expect(h.apply).toHaveBeenCalledTimes(2);
  });
  it('preserves read errors and retries on the next invalidation', async () => {
    const failure = new Error('not authorized'); const h = setup(vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(value));
    act(() => window.dispatchEvent(new Event('focus'))); await tick(); expect(h.result.current.error).toBe(failure); expect(h.apply).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new Event('online'))); await tick(); expect(h.apply).toHaveBeenCalledWith(value); expect(h.result.current.error).toBeNull();
  });
  it('an acknowledged manual refresh supersedes an older pending automatic read', async () => {
    const read = deferred<QaDetail>(); const h = setup(vi.fn().mockReturnValue(read.promise));
    act(() => window.dispatchEvent(new Event('focus'))); await tick(); act(() => h.result.current.acknowledge());
    await act(async () => read.resolve(value)); expect(h.apply).not.toHaveBeenCalled(); expect(h.result.current.pending).toBe(false);
  });
});
