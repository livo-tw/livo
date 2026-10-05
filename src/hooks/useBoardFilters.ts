import { useCallback, useState } from 'react';
import type { Department } from '@/lib/department';

/** Filter state shared by the task board and the QA board. */
export function useBoardFilters() {
  const [filterDept, setFilterDept] = useState<Department[]>([]);
  const [filterAssignees, setFilterAssignees] = useState<string[]>([]);
  const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
  const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
  const [filterReviewers, setFilterReviewers] = useState<string[]>([]);
  const [filterProjects, setFilterProjects] = useState<string[]>([]);
  const hasFilters = filterDept.length > 0 || filterAssignees.length > 0 || filterStatuses.length > 0 || filterPriorities.length > 0 || filterReviewers.length > 0 || filterProjects.length > 0;
  const clearFilters = useCallback(() => { setFilterDept([]); setFilterAssignees([]); setFilterStatuses([]); setFilterPriorities([]); setFilterReviewers([]); setFilterProjects([]); }, []);
  return {
    filterDept, setFilterDept, filterAssignees, setFilterAssignees, filterStatuses, setFilterStatuses,
    filterPriorities, setFilterPriorities, filterReviewers, setFilterReviewers, filterProjects, setFilterProjects,
    hasFilters, clearFilters,
  };
}
export type BoardFilterState = ReturnType<typeof useBoardFilters>;
