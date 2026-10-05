import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { usePersistentSort } from '@/hooks/usePersistentSort';

afterEach(() => localStorage.clear());

describe('list sort', () => {
  it('is remembered in this browser per list', () => {
    const first = renderHook(() => usePersistentSort('all', 'taskKey', 'desc'));
    expect([first.result.current.sortKey, first.result.current.sortDir]).toEqual(['taskKey', 'desc']);
    act(() => { first.result.current.setSortKey('dueDate'); first.result.current.setSortDir(dir => dir === 'asc' ? 'desc' : 'asc'); });
    first.unmount();
    const again = renderHook(() => usePersistentSort('all', 'taskKey', 'desc'));
    expect([again.result.current.sortKey, again.result.current.sortDir]).toEqual(['dueDate', 'asc']);
    // Another list keeps its own.
    const mine = renderHook(() => usePersistentSort('mine', 'status', 'asc'));
    expect([mine.result.current.sortKey, mine.result.current.sortDir]).toEqual(['status', 'asc']);
  });

  it('ignores a damaged stored value', () => {
    localStorage.setItem('livo.listSort.all', JSON.stringify({ key: '', dir: 'sideways' }));
    const { result } = renderHook(() => usePersistentSort('all', 'taskKey', 'desc'));
    expect([result.current.sortKey, result.current.sortDir]).toEqual(['taskKey', 'desc']);
  });
});
