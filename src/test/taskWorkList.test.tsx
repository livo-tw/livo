import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskCheck } from '@/types';
import type { TaskWorkItem } from '@/lib/taskWork/client';
const mocks = vi.hoisted(() => ({ read: vi.fn(), run: vi.fn(), error: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/taskWork/client', () => ({ createTaskWorkCommandRunner: () => mocks.run, getTaskWorkItems: mocks.read,
  taskWorkErrorCode: (error: { code?: string }) => error.code || 'work_unavailable', taskWorkItem: (value: unknown) => value }));
vi.mock('sonner', () => ({ toast: { error: mocks.error } }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
import { useTaskWorkList } from '@/components/task-detail/hooks/useTaskWorkList';
const task = { id: 'task-1', taskKey: 'EX-1' } as Task;
const item: TaskWorkItem = { id: 'item-1', task_id: task.id, text: 'Original', is_done: false, sort_order: 1, version: 4 };
const props = { task, selectedTaskId: task.id, currentMemberId: 'me', globalItems: [] as TaskCheck[], list: 'checks' as const, getFieldLocker: vi.fn(), trackPresence: vi.fn().mockResolvedValue(undefined) };
beforeEach(() => { mocks.read.mockReset().mockResolvedValue([item]); mocks.run.mockReset(); mocks.error.mockReset(); });
describe('LIVO work list confirmed writes and conflict handling', () => {
  it('keeps the displayed state on a failed toggle and submits the original version', async () => {
    mocks.run.mockRejectedValue({ code: 'work_conflict' });
    const view = renderHook(() => useTaskWorkList(props));
    await waitFor(() => expect(view.result.current.items).toHaveLength(1));
    await act(async () => view.result.current.toggle(item.id));
    expect(view.result.current.items[0].isDone).toBe(false);
    expect(mocks.run).toHaveBeenCalledWith({ operation: 'update_item', taskId: task.id, list: 'checks', itemId: item.id, expectedVersion: 4, isDone: true });
    expect(mocks.error).toHaveBeenCalledWith('taskWork.errors.work_conflict');
  });
  it('captures the version when editing starts and preserves the draft after an external edit', async () => {
    mocks.run.mockRejectedValue({ code: 'work_conflict' });
    const view = renderHook(() => useTaskWorkList(props));
    await waitFor(() => expect(view.result.current.items).toHaveLength(1));
    act(() => { view.result.current.startEdit(view.result.current.items[0]); view.result.current.setEditingText('My draft'); });
    mocks.read.mockResolvedValue([{ ...item, text: 'Slack change', version: 5 }]);
    await act(async () => view.result.current.load(task.id));
    await act(async () => view.result.current.saveEdit());
    expect(mocks.run.mock.calls[0][0]).toMatchObject({ expectedVersion: 4, text: 'My draft' });
    expect(view.result.current.editingText).toBe('My draft');
    expect(view.result.current.editingId).toBe(item.id);
    expect(view.result.current.items[0].text).toBe('Slack change');
  });
  it('coalesces repeated clicks while the original write is pending', async () => {
    let resolve!: (value: unknown) => void; mocks.run.mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = renderHook(() => useTaskWorkList(props));
    await waitFor(() => expect(view.result.current.items).toHaveLength(1));
    let flight!: Promise<void>;
    act(() => { flight = view.result.current.toggle(item.id); void view.result.current.toggle(item.id); });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(view.result.current.items[0].isDone).toBe(false);
    await act(async () => { resolve({ record: { ...item, is_done: true, version: 5 } }); await flight; });
    expect(view.result.current.items[0].isDone).toBe(true);
  });
  it('does not hide an item when deletion fails', async () => {
    mocks.run.mockRejectedValue({ code: 'work_forbidden' });
    const view = renderHook(() => useTaskWorkList(props));
    await waitFor(() => expect(view.result.current.items).toHaveLength(1));
    await act(async () => view.result.current.remove(item.id));
    expect(view.result.current.items).toHaveLength(1);
  });
  it('preserves text typed while an add is pending', async () => {
    let resolve!: (value: unknown) => void; mocks.run.mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = renderHook(() => useTaskWorkList(props));
    await waitFor(() => expect(view.result.current.items).toHaveLength(1));
    act(() => view.result.current.setNewText('First'));
    let flight!: Promise<void>; act(() => { flight = view.result.current.add(); });
    act(() => view.result.current.setNewText('Next draft'));
    await act(async () => { resolve({ record: { ...item, id: 'item-2', text: 'First', version: 0 } }); await flight; });
    expect(view.result.current.newText).toBe('Next draft');
    expect(view.result.current.items).toHaveLength(2);
  });
  it('keeps edits typed during save and advances their base to the confirmed version', async () => {
    let resolve!: (value: unknown) => void; mocks.run.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue({ record: { ...item, text: 'Second', version: 6 } });
    const view = renderHook(() => useTaskWorkList(props));
    await waitFor(() => expect(view.result.current.items).toHaveLength(1));
    act(() => { view.result.current.startEdit(view.result.current.items[0]); view.result.current.setEditingText('First'); });
    let flight!: Promise<void>; act(() => { flight = view.result.current.saveEdit(); });
    act(() => view.result.current.setEditingText('Second'));
    await act(async () => { resolve({ record: { ...item, text: 'First', version: 5 } }); await flight; });
    expect(view.result.current.editingText).toBe('Second');
    expect(view.result.current.editingId).toBe(item.id);
    await act(async () => view.result.current.saveEdit());
    expect(mocks.run.mock.calls[1][0]).toMatchObject({ expectedVersion: 5, text: 'Second' });
  });
  it('discards a late read and late write after switching account', async () => {
    let resolve!: (value: unknown) => void; mocks.run.mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = renderHook(current => useTaskWorkList(current), { initialProps: props });
    await waitFor(() => expect(view.result.current.items).toHaveLength(1));
    let flight!: Promise<void>; act(() => { flight = view.result.current.toggle(item.id); });
    mocks.read.mockResolvedValue([]); view.rerender({ ...props, currentMemberId: 'other' });
    await waitFor(() => expect(view.result.current.items).toHaveLength(0));
    await act(async () => { resolve({ record: { ...item, is_done: true, version: 5 } }); await flight; });
    expect(view.result.current.items).toHaveLength(0);
  });
  it('does not resurrect a deleted item from an old receipt', async () => {
    mocks.run.mockResolvedValue({ replayed: true, record: { ...item, version: 5, is_done: true } });
    const view = renderHook(() => useTaskWorkList(props));
    await waitFor(() => expect(view.result.current.items).toHaveLength(1));
    mocks.read.mockResolvedValue([]);
    await act(async () => view.result.current.toggle(item.id));
    expect(view.result.current.items).toHaveLength(0);
  });
  it('does not repeat a known successful operation when its readback fails', async () => {
    mocks.run.mockResolvedValue({ replayed: true, record: { ...item, version: 5, is_done: true } });
    const view = renderHook(() => useTaskWorkList(props));
    await waitFor(() => expect(view.result.current.items).toHaveLength(1));
    mocks.read.mockRejectedValue(new Error('readback unavailable'));
    await act(async () => view.result.current.toggle(item.id));
    expect(mocks.error).toHaveBeenCalledWith('taskWork.refreshFailed');
    await act(async () => view.result.current.toggle(item.id));
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it('preserves a newer live item when an earlier successful write returns late', async () => {
    let resolve!: (value: unknown) => void; mocks.run.mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = renderHook(() => useTaskWorkList(props));
    await waitFor(() => expect(view.result.current.items).toHaveLength(1));
    let flight!: Promise<void>; act(() => { flight = view.result.current.toggle(item.id); });
    mocks.read.mockResolvedValue([{ ...item, version: 6, text: 'Newer Slack edit', is_done: true }]);
    await act(async () => view.result.current.load(task.id));
    await act(async () => { resolve({ record: { ...item, version: 5, is_done: true } }); await flight; });
    expect(view.result.current.items[0]).toMatchObject({ version: 6, text: 'Newer Slack edit' });
  });
});
