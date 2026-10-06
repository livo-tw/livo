import { ProjectMultiSelect } from '@/components/project/ProjectOptions';
import { useMemo, useState, useCallback } from 'react';
import { useAuthContext } from '@/context/AuthContext';
import { useUIContext } from '@/context/UIContext';
import { useTaskContext } from '@/context/TaskContext';
import { useMemberContext } from '@/context/MemberContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useProjectScope, useScopedProjectFilter } from '@/hooks/useProjectScope';
import { useSprintContext } from '@/context/SprintContext';
import { ChevronDown, ChevronUp, LayoutDashboard, List } from 'lucide-react';
import TaskCard from '@/components/TaskCard';
import MultiSelectDropdown from '@/components/MultiSelectDropdown';
import { usePersistentSort } from '@/hooks/usePersistentSort';
import { priorityConfig } from '@/components/ui/badges';
import ColumnConfigDropdown from '@/components/ColumnConfigDropdown';
import { useIsMobile } from '@/hooks/use-mobile';
import { FIXED_KEYS } from '@/lib/columnDefs';
import type { Task } from '@/types';
import { useListColumns } from '@/hooks/useListColumns';
import { useBulkActions } from '@/hooks/useBulkActions';
import BulkActionBar from '@/components/BulkActionBar';
import { Checkbox } from '@/components/ui/checkbox';
import { useTranslation } from 'react-i18next';

type DisplayMode = 'board' | 'list';
type RoleFilter = 'all' | 'assignee' | 'reviewer';

const MyTasksView = () => {
  const { t } = useTranslation();
  const { currentMemberId } = useAuthContext();
  const { setSelectedTask, setCurrentView, featureToggles, featureTogglesReady } = useUIContext();
  const { allTasks, statuses } = useTaskContext();
  const { users } = useMemberContext();
  const { allProjects } = useProjectContext();
  const scope = useProjectScope();
  const { sprints } = useSprintContext();
  const isMobile = useIsMobile();

  const { columnConfig, renderCell } = useListColumns({
    storageKey: 'mytasks-columns',
  });

  const [displayMode, setDisplayMode] = useState<DisplayMode>('list');
  const { sortKey, setSortKey, sortDir, setSortDir } = usePersistentSort('mine', 'status', 'asc');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
  const [filterProjects, setFilterProjects] = useState<string[]>([]);
  const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
  useScopedProjectFilter(setFilterProjects);
  const toggleFilterPriority = useCallback((id: string) => setFilterPriorities(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]), []);
  const priorityOptions = useMemo(() => Object.entries(priorityConfig).map(([id, p]) => ({ id, label: t(`priority.${id}`, { defaultValue: p.label }), icon: p.icon as React.ReactElement })), [t]);
  const hasFilters = filterStatuses.length > 0 || filterProjects.length > 0 || filterPriorities.length > 0;

  const toggleFilterStatus = useCallback((id: string) => setFilterStatuses(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]), []);
  const toggleFilterProject = useCallback((id: string) => setFilterProjects(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]), []);

  const myTasks = useMemo(() => {
    // The sidebar project or product line scopes my tasks like every other task view.
    let tasks = allTasks.filter(t => scope.inScope(t.projectId));
    switch (roleFilter) {
      case 'assignee': tasks = tasks.filter(t => t.assigneeId === currentMemberId); break;
      case 'reviewer': tasks = tasks.filter(t => t.reviewerId === currentMemberId); break;
      default: tasks = tasks.filter(t => t.assigneeId === currentMemberId || t.reviewerId === currentMemberId);
    }
    if (filterStatuses.length > 0) tasks = tasks.filter(t => filterStatuses.includes(t.statusId));
    if (filterProjects.length > 0) tasks = tasks.filter(t => filterProjects.includes(t.projectId));
    if (filterPriorities.length > 0) tasks = tasks.filter(t => filterPriorities.includes(t.priority));
    return tasks;
  }, [allTasks, scope.inScope, currentMemberId, roleFilter, filterStatuses, filterProjects, filterPriorities]);

  const toggleSort = useCallback((key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  }, [sortKey, setSortKey, setSortDir]);

  const sortValue = (task: Task, key: string): string | number | undefined => {
    switch (key) {
      case 'taskKey': return parseInt(task.taskKey.split('-').pop() || '0');
      case 'title': return task.title;
      case 'project': return allProjects.find(p => p.id === task.projectId)?.name || 'zzz';
      case 'status': {
        const s = statuses.find(s => s.id === task.statusId);
        return (s?.isDone ? 1000 : 0) + (s?.sortOrder ?? 0);
      }
      case 'priority': { const o: Record<string, number> = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 }; return o[task.priority]; }
      case 'createdAt': return task.createdAt || '';
      case 'startedAt': return task.startedAt || '9999';
      case 'dueDate': return task.dueDate || '9999';
      case 'sprint': return sprints.find(s => s.id === task.sprintId)?.name || 'zzz';
      case 'department': return task.department || 'zzz';
      case 'assignee': return users.find(u => u.id === task.assigneeId)?.sortOrder ?? 999;
      case 'reviewer': return users.find(u => u.id === task.reviewerId)?.sortOrder ?? 999;
      default: return '';
    }
  };

  const sortedTasks = useMemo(() => {
    return [...myTasks].sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [myTasks, sortKey, sortDir, statuses, allProjects, users, sprints]);

  const { selectedIds, toggleSelect, selectAll, clearSelection, isAllSelected, isPartialSelected } = useBulkActions(sortedTasks);

  const currentUser = users.find(u => u.id === currentMemberId);

  const mobileVisibleKeys = new Set(['title', 'status', 'assignee']);
  const visibleCols = isMobile
    ? columnConfig.visibleColumns.filter(c => c.fixed || mobileVisibleKeys.has(c.key))
    : columnConfig.visibleColumns;

  const tableMinWidth = useMemo(() => {
    const checkboxCol = isMobile ? 0 : 32;
    let total = checkboxCol;
    visibleCols.forEach(c => {
      if (c.key === 'title') total += 200;
      else total += parseInt(c.width || '100', 10) || 100;
    });
    return isMobile ? `${total}px` : `${Math.max(total, 600)}px`;
  }, [visibleCols, isMobile]);

  const SortHeader = ({ label, field, width }: { label: string; field: string; width?: string }) => (
    <th onClick={() => toggleSort(field)} className="text-left text-[13px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground cursor-pointer select-none px-2 py-2.5 whitespace-nowrap" style={{ width }}>
      <span className="flex items-center gap-1">
        {label}
        {sortKey === field && (sortDir === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />)}
      </span>
    </th>
  );

  // Board mode: group by status
  const statusGroups = useMemo(() => {
    const sorted = statuses.slice().sort((a, b) => a.sortOrder - b.sortOrder);
    return sorted.map(s => ({ status: s, tasks: sortedTasks.filter(t => t.statusId === s.id) })).filter(g => g.tasks.length > 0);
  }, [statuses, sortedTasks]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-board">
      <div className="px-3 md:px-5 pt-3 md:pt-4 pb-2">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <h1 className="text-base md:text-lg font-bold text-foreground">{t('myTasks.title')}</h1>
            {currentUser && <span className="text-[13px] md:text-sm text-muted-foreground">— {currentUser.name}</span>}
          </div>
          <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
            {featureTogglesReady && featureToggles.qa && <button className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-accent" onClick={() => { const url = new URL(window.location.href); url.searchParams.delete('qa'); window.history.replaceState({}, '', url.toString()); setSelectedTask(null); setCurrentView('my-qa'); }}>{t('qa.myTitle')}</button>}
            <div className="flex items-center border border-border rounded-md overflow-hidden">
              {([['all', t('myTasks.all')], ['assignee', t('myTasks.assignedToMe')], ['reviewer', t('myTasks.reviewByMe')]] as [RoleFilter, string][]).map(([val, label]) => (
                <button key={val} onClick={() => setRoleFilter(val)} className={`px-2.5 md:px-3 py-1.5 text-[13px] font-medium transition-colors ${roleFilter === val ? 'bg-accent text-foreground' : 'bg-card text-muted-foreground hover:text-foreground'}`}>{label}</button>
              ))}
            </div>
            <span className="text-[13px] md:text-sm text-muted-foreground">{myTasks.length} {t('myTasks.countUnit')}</span>
            {!isMobile && <ColumnConfigDropdown config={columnConfig} fixedKeys={FIXED_KEYS} />}
            <div className="flex items-center border border-border rounded-md overflow-hidden">
              <button onClick={() => setDisplayMode('list')} className={`flex items-center gap-1 px-2.5 md:px-3 py-1.5 text-[13px] font-medium transition-colors ${displayMode === 'list' ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground'}`}><List size={14} />{t('myTasks.listMode')}</button>
              <button onClick={() => setDisplayMode('board')} className={`flex items-center gap-1 px-2.5 md:px-3 py-1.5 text-[13px] font-medium transition-colors ${displayMode === 'board' ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:text-foreground'}`}><LayoutDashboard size={14} />{t('myTasks.boardMode')}</button>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
          <MultiSelectDropdown label={t('filter.status')} options={statuses.map(s => ({ id: s.id, label: s.name, color: s.color }))} selected={filterStatuses} onToggle={toggleFilterStatus} />
          <MultiSelectDropdown label={isMobile ? t('filter.priorityMobile') : t('filter.priority')} options={priorityOptions} selected={filterPriorities} onToggle={toggleFilterPriority} />
          {scope.kind !== 'project' && <ProjectMultiSelect label={t('filter.project')} projects={scope.projectIds ? allProjects.filter(p => scope.projectIds!.has(p.id)) : allProjects} selected={filterProjects} onToggle={toggleFilterProject} />}
          {/* Same clear control as the board's filter row. */}
          {hasFilters && (
            <button onClick={() => { setFilterStatuses([]); setFilterProjects([]); setFilterPriorities([]); }} className="text-[13px] text-primary hover:text-primary/80 font-medium">{t('button.clearFilters')}</button>
          )}
        </div>
      </div>

      {displayMode === 'list' ? (
        <>
          {selectedIds.size > 0 && (
            <div className="mx-2 md:mx-5 mb-1">
              <BulkActionBar selectedIds={selectedIds} onClearSelection={clearSelection} />
            </div>
          )}
          <div className="flex-1 overflow-auto mx-2 md:mx-5 mb-2 md:mb-4 bg-card rounded-xl border border-border/80 shadow-sm">
            <table className="w-full" style={{ minWidth: tableMinWidth }}>
              <thead className="sticky top-0 z-[2] bg-card border-b border-border">
                <tr>
                  {!isMobile && (
                    <th className="w-8 px-2 py-2.5" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-center">
                        <Checkbox
                          checked={isAllSelected ? true : isPartialSelected ? 'indeterminate' : false}
                          onCheckedChange={v => v ? selectAll() : clearSelection()}
                          className="h-3.5 w-3.5"
                        />
                      </div>
                    </th>
                  )}
                  {visibleCols.map(col => (
                    <SortHeader key={col.key} label={col.label} field={col.key} width={col.width} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedTasks.map(task => {
                  const isSelected = selectedIds.has(task.id);
                  return (
                    <tr
                      key={task.id}
                      onClick={() => setSelectedTask(task)}
                      className={`border-b border-border/40 cursor-pointer transition-colors ${isSelected ? 'bg-blue-50 dark:bg-blue-950/20 hover:bg-blue-100 dark:hover:bg-blue-950/30' : 'hover:bg-accent/30'}`}
                    >
                      {!isMobile && (
                        <td className="px-2 py-2.5" onClick={e => { e.stopPropagation(); toggleSelect(task.id); }}>
                          <div className="flex items-center justify-center">
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => toggleSelect(task.id)}
                              className="h-3.5 w-3.5"
                            />
                          </div>
                        </td>
                      )}
                      {visibleCols.map(col => (
                        <td key={col.key} className="px-2 py-2.5">{renderCell(task, col.key)}</td>
                      ))}
                    </tr>
                  );
                })}
                {sortedTasks.length === 0 && (
                  <tr><td colSpan={visibleCols.length + 1} className="p-8 text-center text-[13px] text-muted-foreground">{t('myTasks.noTasks')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain px-3 md:px-5 pb-4 snap-x snap-proximity md:snap-none" style={{ touchAction: 'pan-x pan-y', WebkitOverflowScrolling: 'touch' }}>
          <div className="flex gap-4 h-full min-w-0">
            {statusGroups.map(({ status, tasks }) => (
              <div key={status.id} className="flex min-w-0 flex-col w-[min(82vw,300px)] md:w-72 flex-shrink-0 snap-start">
                <div className="flex items-center gap-2 mb-3 px-1">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: status.color }} />
                  <span className="text-[13px] font-semibold text-foreground uppercase tracking-wide">{status.name}</span>
                  <span className="text-[13px] text-muted-foreground bg-muted rounded-full px-1.5 py-0.5">{tasks.length}</span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain space-y-2 pr-1">
                  {tasks.map(task => <TaskCard key={task.id} task={task} />)}
                </div>
              </div>
            ))}
            {statusGroups.length === 0 && <div className="flex-1 flex items-center justify-center text-[13px] text-muted-foreground">{t('myTasks.noTasks')}</div>}
          </div>
        </div>
      )}
    </div>
  );
};

export default MyTasksView;
