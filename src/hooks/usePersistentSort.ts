import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

type Direction = 'asc' | 'desc';
type Sort = { key: string; dir: Direction };
const read = (storageKey: string, fallback: Sort): Sort => {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || 'null') as { key?: unknown; dir?: unknown } | null;
    if (value && typeof value.key === 'string' && value.key && (value.dir === 'asc' || value.dir === 'desc')) return { key: value.key, dir: value.dir as Direction };
  } catch { /* fall back */ }
  return fallback;
};

/**
 * A list's sort column and direction, remembered in this browser like the board's sort.
 * Same shape as two useState pairs, so a view only swaps its declarations.
 */
export function usePersistentSort(name: string, defaultKey: string, defaultDir: Direction) {
  const storageKey = `livo.listSort.${name}`;
  const [sort, setSort] = useState<Sort>(() => read(storageKey, { key: defaultKey, dir: defaultDir }));
  const save = useCallback((next: Sort): Sort => {
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* the choice still applies until reload */ }
    return next;
  }, [storageKey]);
  const setSortKey: Dispatch<SetStateAction<string>> = useCallback(value => setSort(previous => save({ ...previous, key: typeof value === 'function' ? value(previous.key) : value })), [save]);
  const setSortDir: Dispatch<SetStateAction<Direction>> = useCallback(value => setSort(previous => save({ ...previous, dir: typeof value === 'function' ? value(previous.dir) : value })), [save]);
  return { sortKey: sort.key, sortDir: sort.dir, setSortKey, setSortDir };
}
