import { useState, useCallback, useEffect, useMemo } from 'react';
import type { Task } from '@/types';

/**
 * Selection for bulk actions over the tasks a view shows. A task that a filter
 * or search hides is no longer selected, so a bulk action only ever changes
 * tasks the user can see.
 */
export function useBulkActions(tasks: Task[]) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const visibleIds = useMemo(() => new Set(tasks.map(t => t.id)), [tasks]);
  const selectedIds = useMemo(() => {
    const visible = new Set([...picked].filter(id => visibleIds.has(id)));
    return visible.size === picked.size ? picked : visible;
  }, [picked, visibleIds]);

  // Hidden tasks stay deselected when the filter is cleared again.
  useEffect(() => {
    setPicked(prev => [...prev].every(id => visibleIds.has(id)) ? prev : new Set([...prev].filter(id => visibleIds.has(id))));
  }, [visibleIds]);

  const toggleSelect = useCallback((id: string) => {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setPicked(new Set(tasks.map(t => t.id)));
  }, [tasks]);

  const clearSelection = useCallback(() => {
    setPicked(new Set());
  }, []);

  const isAllSelected = tasks.length > 0 && selectedIds.size === tasks.length;
  const isPartialSelected = selectedIds.size > 0 && selectedIds.size < tasks.length;

  return { selectedIds, toggleSelect, selectAll, clearSelection, isAllSelected, isPartialSelected };
}
