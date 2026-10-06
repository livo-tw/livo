import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';
import { useProjectContext } from '@/context/ProjectContext';
import { hasQaNavigationGuard, notifyQaNavigationBlocked } from '@/lib/qa/navigationGuard';
import { hasReleaseNavigationGuard, notifyReleaseNavigationBlocked } from '@/components/releases/navigation';

/** Views that follow the sidebar scope (work report covers all of a member's work). */
export const SCOPED_VIEWS: readonly string[] = ['dashboard', 'gantt', 'board', 'backlog', 'all-list', 'my-tasks', 'knowledge-base', 'qa', 'my-qa', 'deployment-queue'];
const TASK_VIEWS: readonly string[] = ['dashboard', 'gantt', 'board', 'backlog', 'all-list', 'my-tasks'];

/**
 * Where to go after the scope changes. Picking a project or product line keeps
 * any scoped view (my QA becomes the project's QA); "All tasks" keeps a task view.
 * Everything else opens the board.
 */
export function viewAfterScopeChange<V extends string>(view: V, change: 'scope' | 'all'): V | 'board' | 'qa' {
  if (change === 'scope') return view === 'my-qa' ? 'qa' : SCOPED_VIEWS.includes(view) ? view : 'board';
  return TASK_VIEWS.includes(view) ? view : 'board';
}

/**
 * The one sidebar entry to highlight. A view that follows the scope highlights
 * the selected project or product line when there is one, otherwise its own
 * workspace entry (knowledge base, QA, my QA, or "All tasks" for every task view).
 * Other views (team intro, approvals, settings…) highlight their own entry only.
 */
export function sidebarEntry(view: string, scoped: boolean): 'scope' | 'knowledge-base' | 'qa' | 'my-qa' | 'all-tasks' | 'deployment-queue' | null {
  if (!SCOPED_VIEWS.includes(view)) return null;
  if (scoped) return 'scope';
  return view === 'knowledge-base' || view === 'qa' || view === 'my-qa' || view === 'deployment-queue' ? view : 'all-tasks';
}

/** A pending QA or release write must finish first; changing the scope would remount it. */
export function scopeChangeBlocked(): boolean {
  if (hasReleaseNavigationGuard()) { notifyReleaseNavigationBlocked(); return true; }
  if (hasQaNavigationGuard()) { notifyQaNavigationBlocked(); return true; }
  return false;
}

/**
 * The sidebar scope every project view follows: one project, every project of
 * one product line, or (null) all projects. Board, schedule, backlog, list, my
 * tasks, dashboard, knowledge base and QA read it here so they always agree.
 */
export function scopedProjectIds(projects: readonly { id: string; lineId?: string | null }[], projectId: string | null, lineId: string | null): Set<string> | null {
  if (projectId) return new Set([projectId]);
  if (lineId) return new Set(projects.filter(project => project.lineId === lineId).map(project => project.id));
  return null;
}

export function useProjectScope() {
  const { allProjects, productLines, selectedProjectId, selectedLineId, setSelectedProjectId, setSelectedLineId } = useProjectContext();
  const projectIds = useMemo(() => scopedProjectIds(allProjects, selectedProjectId, selectedLineId), [allProjects, selectedProjectId, selectedLineId]);
  const inScope = useCallback((projectId: string | null | undefined) => !projectIds || (!!projectId && projectIds.has(projectId)), [projectIds]);
  const label = selectedProjectId ? allProjects.find(project => project.id === selectedProjectId)?.name || ''
    : selectedLineId ? productLines.find(line => line.id === selectedLineId)?.name || '' : '';
  const clear = useCallback(() => { if (scopeChangeBlocked()) return; setSelectedProjectId(null); setSelectedLineId(null); }, [setSelectedProjectId, setSelectedLineId]);
  return { projectIds, inScope, active: !!projectIds, label, kind: selectedProjectId ? 'project' as const : selectedLineId ? 'line' as const : null, clear };
}

/**
 * A project filter chip must not keep filtering after the sidebar scope hides it:
 * drop choices outside the new scope, and all of them when one project is selected.
 */
export function useScopedProjectFilter(setFilterProjects: Dispatch<SetStateAction<string[]>>) {
  const { projectIds, kind } = useProjectScope();
  useEffect(() => {
    setFilterProjects(previous => {
      const next = kind === 'project' ? [] : projectIds ? previous.filter(id => projectIds.has(id)) : previous;
      return next.length === previous.length ? previous : next;
    });
  }, [projectIds, kind, setFilterProjects]);
}
