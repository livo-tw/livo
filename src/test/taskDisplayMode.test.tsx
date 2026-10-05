import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { useUIState } from '@/context/hooks/useUIState';

const width = (value: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value });
afterEach(() => { cleanup(); localStorage.clear(); width(1024); });

describe('how a task opens', () => {
  it('remembers the member\'s choice of modal, side panel or page', () => {
    const first = renderHook(() => useUIState('member'));
    expect(first.result.current.taskDisplayMode).toBe('modal');
    act(() => first.result.current.setTaskDisplayMode('side'));
    expect(first.result.current.taskDisplayMode).toBe('side');
    first.unmount();
    // Next visit in this browser.
    expect(renderHook(() => useUIState('member')).result.current.taskDisplayMode).toBe('side');
  });

  it('shows a full page on a phone without overwriting the desktop choice', () => {
    localStorage.setItem('livo.taskDisplayMode', 'side');
    width(390);
    const phone = renderHook(() => useUIState('member'));
    expect(phone.result.current.taskDisplayMode).toBe('page');
    expect(localStorage.getItem('livo.taskDisplayMode')).toBe('side');
    phone.unmount();
    width(1280);
    expect(renderHook(() => useUIState('member')).result.current.taskDisplayMode).toBe('side');
  });

  it('ignores an unknown stored value', () => {
    localStorage.setItem('livo.taskDisplayMode', 'floating');
    expect(renderHook(() => useUIState('member')).result.current.taskDisplayMode).toBe('modal');
  });
});
