import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useUIState } from '@/context/hooks/useUIState';
import { clearQaNavigationGuards, registerQaNavigationGuard } from '@/lib/qa/navigationGuard';
import { clearReleaseNavigationGuards, registerReleaseNavigationGuard } from '@/components/releases/navigation';
import { resetUnsavedDrafts, useUnsavedDraft } from '@/lib/unsavedDrafts';
import { resolveFeatureToggles } from '@/lib/featureToggles';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/lib/featureToggleQueries', () => ({
  loadFeatureToggles: async () => resolveFeatureToggles({ qa: true }, { hasApprovalRules: false, hasApprovalRequests: false }),
  persistFeatureToggle: vi.fn(),
}));

beforeEach(() => { window.history.replaceState({}, '', '/?kb=example-draft#section'); });
afterEach(() => {
  cleanup(); clearQaNavigationGuards(); clearReleaseNavigationGuards(); resetUnsavedDrafts(); vi.restoreAllMocks();
});

describe('accepted navigation creation intent', () => {
  it('publishes an intent after old view parameters are cleared and before the next view mounts', () => {
    const { result } = renderHook(() => useUIState());
    let callbackView = '';
    const accepted = vi.fn(() => {
      callbackView = result.current.currentView;
      expect(new URLSearchParams(window.location.search).has('kb')).toBe(false);
      const url = new URL(window.location.href); url.searchParams.set('qaCreate', '1');
      window.history.replaceState({}, '', url.toString());
    });
    act(() => result.current.setCurrentView(previous => previous === 'board' ? 'qa' : 'board', accepted));
    expect(accepted).toHaveBeenCalledOnce();
    expect(callbackView).toBe('board');
    expect(result.current.currentView).toBe('qa');
    expect(new URLSearchParams(window.location.search).get('qaCreate')).toBe('1');
  });

  it('does not publish an intent when a release form blocks navigation', () => {
    const { result } = renderHook(() => useUIState());
    const release = registerReleaseNavigationGuard(vi.fn());
    const accepted = vi.fn();
    const before = window.location.href;
    act(() => result.current.setCurrentView('qa', accepted));
    expect(accepted).not.toHaveBeenCalled();
    expect(result.current.currentView).toBe('board');
    expect(window.location.href).toBe(before);
    release();
  });

  it('does not publish an intent while a QA submission is pending', async () => {
    const { result } = renderHook(() => useUIState());
    await act(async () => { await result.current.refreshFeatureToggles(); });
    const qa = registerQaNavigationGuard(vi.fn());
    const accepted = vi.fn();
    const before = window.location.href;
    act(() => result.current.setCurrentView('qa', accepted));
    expect(accepted).not.toHaveBeenCalled();
    expect(result.current.currentView).toBe('board');
    expect(window.location.href).toBe(before);
    qa();
  });

  it('honors a knowledge draft rejection and only publishes after discard is accepted', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { result } = renderHook(() => { useUnsavedDraft('view', true, 'Keep the example draft'); return useUIState(); });
    const accepted = vi.fn();
    const before = window.location.href;
    act(() => result.current.setCurrentView('qa', accepted));
    expect(accepted).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    expect(result.current.currentView).toBe('board');
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    act(() => result.current.setCurrentView('qa', accepted));
    expect(accepted).toHaveBeenCalledOnce();
    expect(result.current.currentView).toBe('qa');
  });
});
