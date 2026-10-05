import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Task } from '@/types';
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { useUIState } from '@/context/hooks/useUIState';
import { confirmDiscardDrafts, hasUnsavedDraft, resetUnsavedDrafts, useUnsavedDraft, type UnsavedDraftScope } from '@/lib/unsavedDrafts';

afterEach(() => { cleanup(); resetUnsavedDrafts(); vi.restoreAllMocks(); vi.useRealTimers(); });

function withDraft(scope: UnsavedDraftScope, active: boolean) {
  return renderHook(({ on }) => { const ui = useUIState('admin'); useUnsavedDraft(scope, on, `discard ${scope}?`); return ui; }, { initialProps: { on: active } });
}

describe('unsaved drafts', () => {
  it('asks only while something is unsaved, and one answer covers the rest of the same click', () => {
    vi.useFakeTimers();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    expect(confirmDiscardDrafts('view')).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    const { rerender } = renderHook(({ on }) => useUnsavedDraft('task', on, 'lose it?'), { initialProps: { on: true } });
    expect(hasUnsavedDraft('task')).toBe(true);
    expect(confirmDiscardDrafts('view')).toBe(true);
    expect(confirmDiscardDrafts('task')).toBe(true);
    expect(confirmDiscardDrafts('task')).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith('lose it?');
    act(() => { vi.runAllTimers(); });
    expect(confirmDiscardDrafts('task')).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
    rerender({ on: false });
    expect(hasUnsavedDraft()).toBe(false);
  });

  it('keeps the knowledge base open when the user keeps the draft', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { result, rerender } = withDraft('view', false);
    act(() => result.current.setCurrentView('knowledge-base'));
    rerender({ on: true });
    act(() => result.current.setCurrentView('board'));
    expect(confirm).toHaveBeenCalledWith('discard view?');
    expect(result.current.currentView).toBe('knowledge-base');
    confirm.mockReturnValue(true);
    act(() => result.current.setCurrentView('board'));
    expect(result.current.currentView).toBe('board');
  });

  it('keeps the task open with an unsaved edit, but still lets the same task update', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { result, rerender } = withDraft('task', false);
    act(() => result.current.setSelectedTask({ id: 'task-1', title: 'A' } as Task));
    rerender({ on: true });
    confirm.mockReturnValue(false);
    act(() => result.current.setSelectedTask({ id: 'task-1', title: 'A, renamed' } as Task));
    expect(result.current.selectedTask?.title).toBe('A, renamed');
    expect(confirm).not.toHaveBeenCalled();
    act(() => result.current.setSelectedTask(null));
    act(() => result.current.setSelectedTask({ id: 'task-2' } as Task));
    expect(result.current.selectedTask?.id).toBe('task-1');
    expect(confirm).toHaveBeenCalledTimes(2);
    // A view change keeps the open task, so it does not ask about the task's edit.
    act(() => result.current.setCurrentView('backlog'));
    expect(result.current.currentView).toBe('backlog');
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});

describe('address after a view change', () => {
  it('drops links that belong to the view being left, and keeps those of the view being opened', () => {
    const { result } = renderHook(() => useUIState('admin'));
    window.history.replaceState({}, '', '/demo/?kb=page-1&anchor=intro&qa=bug-1&task=EX-1');
    act(() => result.current.setCurrentView('qa'));
    expect(window.location.search).toBe('?qa=bug-1&task=EX-1');
    act(() => result.current.setCurrentView('board'));
    expect(window.location.search).toBe('?task=EX-1');
    window.history.replaceState({}, '', '/demo/?kb=page-2');
    act(() => result.current.setCurrentView('knowledge-base'));
    expect(window.location.search).toBe('?kb=page-2');
    window.history.replaceState({}, '', '/demo/');
  });
});
