import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import type { Task } from '@/types';
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { useUIState } from '@/context/hooks/useUIState';
import { clearReleaseNavigationGuards, hasReleaseNavigationGuard, registerReleaseNavigationGuard } from '@/components/releases/navigation';
afterEach(() => { cleanup(); clearReleaseNavigationGuards(); });
describe('Release navigation independent from QA toggle', () => {
  it('retains pending forms even when QA is disabled or not yet loaded', () => {
    const notify = vi.fn(); const { result, rerender } = renderHook(({ active }) => { const ui = useUIState('admin'); useLayoutEffect(() => active ? registerReleaseNavigationGuard(notify) : undefined, [active]); return ui; }, { initialProps: { active: false } });
    act(() => result.current.setCurrentView('releases')); rerender({ active: true }); act(() => result.current.setCurrentView('board')); expect(result.current.currentView).toBe('releases'); expect(notify).toHaveBeenCalledTimes(1);
    rerender({ active: false }); act(() => result.current.setCurrentView('board')); expect(result.current.currentView).toBe('board');
  });
  it('blocks page-mode task replacement, but forced sign-out tears down the guard', () => {
    const { result } = renderHook(() => useUIState('admin')); act(() => result.current.setTaskDisplayMode('page')); const notify = vi.fn(); registerReleaseNavigationGuard(notify);
    act(() => result.current.setSelectedTask({ id: 'task' } as Task)); expect(result.current.selectedTask).toBeNull(); expect(notify).toHaveBeenCalled();
    fireEvent(window, new Event('livo:qa-abort')); expect(hasReleaseNavigationGuard()).toBe(false); act(() => result.current.setSelectedTask({ id: 'task' } as Task)); expect(result.current.selectedTask?.id).toBe('task');
  });
  it.each(['popstate', 'livo:qa-navigation'])('restores the same-tab release URL when %s attempts to discard a pending form', event => {
    window.history.replaceState({}, '', '/?release=original'); registerReleaseNavigationGuard(vi.fn()); window.history.replaceState({}, '', '/?release=other'); fireEvent(window, new Event(event)); expect(window.location.search).toBe('?release=original');
  });
});
