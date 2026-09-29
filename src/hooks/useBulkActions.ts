import { useState, useCallback } from 'react';
import type { Task } from '@/types';

export function useBulkActions(tasks: Task[]) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(tasks.map(t => t.id)));
  }, [tasks]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const isAllSelected = tasks.length > 0 && selectedIds.size === tasks.length;
  const isPartialSelected = selectedIds.size > 0 && selectedIds.size < tasks.length;

  return { selectedIds, toggleSelect, selectAll, clearSelection, isAllSelected, isPartialSelected };
}
