import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/types';

const state = vi.hoisted(() => ({
  reads: [] as Array<{ id: string; resolve: (value: unknown) => void }>,
  writes: [] as Array<{ id: string; patch: unknown }>,
  saved: vi.fn(), failed: vi.fn(), presence: vi.fn(),
  existingRead: null as null | ((value: unknown) => void),
  holdExisting: false, holdSave: false, saveError: false,
  saveResult: null as null | ((value: unknown) => void),
}));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('sonner', () => ({ toast: { success: state.saved, error: state.failed } }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('@/components/task-detail/utils', () => ({ createNotification: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  from: () => {
    let id = '', fields = '', patch: unknown;
    const chain = {
      select: (next: string) => { fields = next; return chain; },
      eq: (_column: string, value: string) => { id = value; return chain; },
      maybeSingle: () => {
        if (fields === '*') return new Promise(resolve => state.reads.push({ id, resolve }));
        if (state.holdExisting) return new Promise(resolve => { state.existingRead = resolve; });
        return Promise.resolve({ data: { id: `spec-${id}` }, error: null });
      },
      update: (value: unknown) => { patch = value; return chain; },
      then: (resolve: (value: unknown) => unknown) => {
        state.writes.push({ id, patch });
        if (state.holdSave) return new Promise(saved => { state.saveResult = saved; }).then(resolve);
        return Promise.resolve({ error: state.saveError ? { message: 'Save denied' } : null }).then(resolve);
      },
    };
    return chain;
  },
  channel: () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; },
  removeChannel: vi.fn(),
} }));
import { useTaskSpecs } from '@/components/task-detail/hooks/useTaskSpecs';

const task = (id: string) => ({ id, title: `Example ${id}`, taskKey: id }) as Task;
const mount = () => renderHook(({ id }) => useTaskSpecs({ task: task(id), selectedTaskId: id,
  currentMemberId: 'member-example', getFieldLocker: () => undefined, trackPresence: state.presence }), { initialProps: { id: 'a' } });
const answer = async (index: number, label: string, error: unknown = null) => {
  await act(async () => state.reads[index].resolve({ data: error ? null : { background: `${label} background`, requirement: `${label} requirement`, notes: `${label} note` }, error }));
};
beforeEach(() => { vi.clearAllMocks(); state.reads = []; state.writes = []; state.existingRead = null; state.holdExisting = false; state.holdSave = false; state.saveResult = null; state.saveError = false; });
afterEach(cleanup);

describe('task requirement identity and recovery', () => {
  it('clears old content immediately and ignores an out-of-order response from another task', async () => {
    const { result, rerender } = mount();
    rerender({ id: 'b' });
    await answer(1, 'B');
    await answer(0, 'A');
    expect(result.current.specBackground).toBe('B background');
    rerender({ id: 'c' });
    expect(result.current.specBackground).toBe('');
    expect(result.current.specLoading).toBe(true);
  });

  it('saves only the edited column rather than overwriting other requirement fields', async () => {
    const { result } = mount(); await answer(0, 'A');
    act(() => result.current.richFieldStartEdit('taskDetail.spec.notes', result.current.specNotes));
    await act(async () => result.current.richFieldConfirm(result.current.setSpecNotes, 'Updated note'));
    expect(state.writes).toEqual([{ id: 'a', patch: { notes: 'Updated note' } }]);
    expect(state.saved).toHaveBeenCalledOnce();
  });

  it('does not resume a pending save after switching away and returning to the same task', async () => {
    const { result, rerender } = mount(); await answer(0, 'A');
    act(() => result.current.richFieldStartEdit('taskDetail.spec.notes', result.current.specNotes));
    state.holdExisting = true;
    let saving!: Promise<void>;
    act(() => { saving = result.current.richFieldConfirm(result.current.setSpecNotes, 'Old visit'); });
    rerender({ id: 'b' }); rerender({ id: 'a' });
    expect(result.current.specSaving).toBe(true);
    act(() => result.current.richFieldStartEdit('taskDetail.spec.background', 'Must wait'));
    expect(result.current.editingField).toBeNull();
    await act(async () => { state.existingRead?.({ data: { id: 'spec-a' }, error: null }); await saving; });
    await waitFor(() => expect(state.reads).toHaveLength(3));
    await answer(2, 'New A');
    act(() => result.current.richFieldStartEdit('taskDetail.spec.background', result.current.specBackground));
    expect(state.writes).toEqual([]);
    expect(result.current.editingField).toBe('taskDetail.spec.background');
    expect(result.current.specBackground).toBe('New A background');
    expect(state.saved).not.toHaveBeenCalled();
  });

  it('does not apply an old save completion to another task editor', async () => {
    const { result, rerender } = mount(); await answer(0, 'A');
    act(() => result.current.richFieldStartEdit('taskDetail.spec.notes', result.current.specNotes));
    state.holdSave = true; let saving!: Promise<void>;
    act(() => { saving = result.current.richFieldConfirm(result.current.setSpecNotes, 'Saved A note'); });
    await waitFor(() => expect(state.writes).toHaveLength(1));
    rerender({ id: 'b' }); await answer(1, 'B');
    act(() => result.current.richFieldStartEdit('taskDetail.spec.background', result.current.specBackground));
    await act(async () => { state.saveResult?.({ error: null }); await saving; });
    expect(state.writes[0]).toEqual({ id: 'a', patch: { notes: 'Saved A note' } });
    expect(result.current.editingField).toBe('taskDetail.spec.background');
    expect(result.current.specNotes).toBe('B note');
    expect(state.saved).not.toHaveBeenCalled();
  });

  it('keeps an already-sent write locked across unmount and reloads before a new editor can save', async () => {
    const first = mount(); await answer(0, 'A');
    act(() => first.result.current.richFieldStartEdit('taskDetail.spec.notes', first.result.current.specNotes));
    state.holdSave = true; let saving!: Promise<void>;
    act(() => { saving = first.result.current.richFieldConfirm(first.result.current.setSpecNotes, 'Older saved note'); });
    await waitFor(() => expect(state.writes).toHaveLength(1));
    first.unmount();
    const second = mount();
    expect(second.result.current.specSaving).toBe(true);
    act(() => second.result.current.richFieldStartEdit('taskDetail.spec.notes', 'Newer draft'));
    expect(second.result.current.editingField).toBeNull(); expect(state.writes).toHaveLength(1);
    await act(async () => { state.saveResult?.({ error: null }); await saving; });
    await waitFor(() => expect(state.reads).toHaveLength(2));
    await answer(1, 'Saved A');
    state.holdSave = false;
    act(() => second.result.current.richFieldStartEdit('taskDetail.spec.notes', second.result.current.specNotes));
    await act(async () => second.result.current.richFieldConfirm(second.result.current.setSpecNotes, 'Newer saved note'));
    expect(state.writes).toEqual([{ id: 'a', patch: { notes: 'Older saved note' } }, { id: 'a', patch: { notes: 'Newer saved note' } }]);
    expect(state.saved).toHaveBeenCalledOnce();
  });

  it('keeps the editor and original value after a failed save so the draft can be retried', async () => {
    const { result } = mount(); await answer(0, 'A'); state.saveError = true;
    act(() => result.current.richFieldStartEdit('taskDetail.spec.notes', result.current.specNotes));
    const apply = vi.fn();
    await act(async () => result.current.richFieldConfirm(apply, 'Retain this draft'));
    expect(apply).not.toHaveBeenCalled();
    expect(result.current.editingField).toBe('taskDetail.spec.notes');
    expect(result.current.specNotes).toBe('A note');
    expect(result.current.specSaving).toBe(false);
    expect(state.failed).toHaveBeenCalled(); expect(state.saved).not.toHaveBeenCalled();
  });

  it('blocks editing after a failed read and allows it only after a successful retry', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = mount(); await answer(0, '', { message: 'Read denied' });
    report.mockRestore();
    expect(result.current.specLoadError).toBe(true);
    act(() => result.current.richFieldStartEdit('taskDetail.spec.notes', ''));
    expect(result.current.editingField).toBeNull();
    let reload!: Promise<void>;
    act(() => { reload = result.current.loadSpecFromDb('a'); });
    await answer(1, 'A'); await reload;
    await waitFor(() => expect(result.current.specLoadError).toBe(false));
    act(() => result.current.richFieldStartEdit('taskDetail.spec.notes', result.current.specNotes));
    expect(result.current.editingField).toBe('taskDetail.spec.notes');
  });
});
