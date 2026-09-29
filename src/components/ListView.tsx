import { useMemo, useState, useCallback } from 'react';
import type { Task } from '@/types';
import { useUIContext } from '@/context/UIContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useTaskContext } from '@/context/TaskContext';
import { useMemberContext } from '@/context/MemberContext';
import { useSprintContext } from '@/context/SprintContext';
import { ChevronDown, ChevronRight, Search, ClipboardList } from 'lucide-react';
import DepartmentFilter from '@/components/DepartmentFilter';
import MultiSelectDropdown from '@/components/MultiSelectDropdown';
import ColumnConfigDropdown from '@/components/ColumnConfigDropdown';
import { priorityConfig } from '@/components/ui/badges';
import { getDepartment, sortUsersByDept, type Department } from '@/lib/department';
import { useIsMobile } from '@/hooks/use-mobile';
import { FIXED_KEYS } from '@/lib/columnDefs';
import { useListColumns } from '@/hooks/useListColumns';
import { useBulkActions } from '@/hooks/useBulkActions';
import BulkActionBar from '@/components/BulkActionBar';
import { Checkbox } from '@/components/ui/checkbox';
import { useTranslation } from 'react-i18next';

const ListView = () => {
  const { t } = useTranslation();
  const { setSelectedTask } = useUIContext();
  const { selectedProjectId, selectedLineId, allProjects, productLines } = useProjectContext();
  const { allTasks, statuses, tags } = useTaskContext();
  const { users } = useMemberContext();
  const { sprintActive, currentSprint, sprints } = useSprintContext();
  const isMobile = useIsMobile();

  const { columnConfig, renderCell } = useListColumns({
    storageKey: 'listview-columns',
    includeCustomFields: true,
    selectedProjectId,
  });

  const [sortKey, setSortKey] = useState<string>('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  const [filterDept, setFilterDept] = useState<Department[]>([]);
  const [filterAssignees, setFilterAssignees] = useState<string[]>([]);
  const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
  const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
  const [filterReviewers, setFilterReviewers] = useState<string[]>([]);
  const [filterProjects, setFilterProjects] = useState<string[]>([]);
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [collapsedSubtaskParents, setCollapsedSubtaskParents] = useState<Set<string>>(new Set());
  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);

  const toggleArr = useCallback((setter: React.Dispatch<React.SetStateAction<string[]>>) => (id: string) =>
    setter(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]), []);

  const userMap = useMemo(() => new Map(users.map(u => [u.id, u])), [users]);

  const filteredTasks = useMemo(() => {
    let tasks = allTasks;
    if (selectedProjectId) tasks = tasks.filter(t => t.projectId === selectedProjectId);
    else if (selectedLineId) {
      const lineProjectIds = allProjects.filter(p => p.lineId === selectedLineId).map(p => p.id);
      tasks = tasks.filter(t => lineProjectIds.includes(t.projectId));
    }
    if (sprintActive && currentSprint) tasks = tasks.filter(t => t.sprintId === currentSprint.id || !t.sprintId);
    if (filterDept.length > 0) tasks = tasks.filter(t => { const a = userMap.get(t.assigneeId || ''); return filterDept.includes(getDepartment(a) as Department); });
    if (filterAssignees.length > 0) tasks = tasks.filter(t => t.assigneeId && filterAssignees.includes(t.assigneeId));
    if (filterStatuses.length > 0) tasks = tasks.filter(t => filterStatuses.includes(t.statusId));
    if (filterPriorities.length > 0) tasks = tasks.filter(t => filterPriorities.includes(t.priority));
    if (filterReviewers.length > 0) tasks = tasks.filter(t => t.reviewerId && filterReviewers.includes(t.reviewerId));
    if (filterProjects.length > 0) tasks = tasks.filter(t => filterProjects.includes(t.projectId));
    if (filterTags.length > 0) tasks = tasks.filter(t => t.tagIds && t.tagIds.some(tagId => filterTags.includes(tagId)));
    return tasks;
  }, [allTasks, selectedProjectId, selectedLineId, sprintActive, currentSprint, filterDept, userMap, filterAssignees, filterStatuses, filterPriorities, filterReviewers, filterProjects, filterTags, allProjects]);

  const toggleSort = useCallback((key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  }, [sortKey]);

  const toggleCollapse = useCallback((projectId: string) => {
    setCollapsedProjects(prev => prev.includes(projectId) ? prev.filter(id => id !== projectId) : [...prev, projectId]);
  }, []);

  const sortValue = (task: Task, key: string): string | number => {
    switch (key) {
      case 'taskKey': return parseInt(task.taskKey.split('-').pop() || '0');
      case 'title': return task.title;
      case 'project': return allProjects.find(p => p.id === task.projectId)?.name || 'zzz';
      case 'status': return statuses.find(s => s.id === task.statusId)?.sortOrder ?? 0;
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

  const groupedByProject = useMemo(() => {
    const projectIds = [...new Set(filteredTasks.map(t => t.projectId))];
    return projectIds.map(pid => {
      const project = allProjects.find(p => p.id === pid);
      const line = project ? productLines.find(l => l.id === project.lineId) : null;
      const tasks = filteredTasks.filter(t => t.projectId === pid).sort((a, b) => {
        const va = sortValue(a, sortKey);
        const vb = sortValue(b, sortKey);
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return sortDir === 'asc' ? cmp : -cmp;
      });
      return { project, line, tasks };
    }).filter(g => g.tasks.length > 0)
      .sort((a, b) => {
        const lineOrderA = a.line?.sortOrder ?? 999;
        const lineOrderB = b.line?.sortOrder ?? 999;
        if (lineOrderA !== lineOrderB) return lineOrderA - lineOrderB;
        return (a.project?.name || '').localeCompare(b.project?.name || '');
      });
  }, [filteredTasks, allProjects, sortKey, sortDir, productLines, statuses, users, sprints]);

  const { selectedIds, toggleSelect, selectAll, clearSelection, isAllSelected, isPartialSelected } = useBulkActions(filteredTasks);

  const totalCount = filteredTasks.length;

  const mobileVisibleKeys = new Set(['title', 'status', 'assignee']);
  const visibleCols = isMobile
    ? columnConfig.visibleColumns.filter(c => c.fixed || mobileVisibleKeys.has(c.key))
    : columnConfig.visibleColumns;

  const tableMinWidth = useMemo(() => {
    // 20px checkbox col + 24px expand/done col
    const checkboxCol = isMobile ? 0 : 44;
    const gapSize = isMobile ? 8 : 12;
    let total = checkboxCol;
    visibleCols.forEach(c => {
      if (c.key === 'title') total += 200;
      else total += parseInt(c.width || '100', 10) || 100;
    });
    total += visibleCols.length * gapSize;
    return isMobile ? `${total}px` : `${Math.max(total, 600)}px`;
  }, [visibleCols, isMobile]);

  // Two leading fixed cols on desktop: 20px checkbox + 24px expand/done
  const gridTemplate = useMemo(() => `${isMobile ? '' : '20px 24px '}${visibleCols.map(c => c.key === 'title' ? 'minmax(200px, 1fr)' : `minmax(0, ${c.width || '100px'})`).join(' ')}`, [visibleCols, isMobile]);

  const SortHeader = ({ label, field, className = '' }: { label: string; field: string; className?: string }) => (
    <button onClick={() => toggleSort(field)} className={`text-left text-[13px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors ${className}`}>
      {label} {sortKey === field ? (sortDir === 'asc' ? '↑' : '↓') : ''}
    </button>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-board">
      <div className="px-5 pt-4 pb-2">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-base md:text-lg font-bold text-foreground">{t('list.title')}</h1>
          <div className="flex items-center gap-2">
            {!isMobile && <ColumnConfigDropdown config={columnConfig} fixedKeys={FIXED_KEYS} />}
            <span className="text-[13px] text-muted-foreground">{totalCount} {t('list.taskCount')}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <DepartmentFilter value={filterDept} onChange={setFilterDept} />
          <MultiSelectDropdown label={t('filter.assignee')} options={sortUsersByDept(users.filter(u => u.isActive)).map(u => ({ id: u.id, label: u.name, avatar: u.avatar, avatarColor: u.color, subtitle: u.jobTitle }))} selected={filterAssignees} onToggle={toggleArr(setFilterAssignees)} />
          <MultiSelectDropdown label={t('filter.status')} options={statuses.map(s => ({ id: s.id, label: s.name, color: s.color }))} selected={filterStatuses} onToggle={toggleArr(setFilterStatuses)} />
          <MultiSelectDropdown label={t('filter.priority')} options={Object.entries(priorityConfig).map(([id, p]) => ({ id, label: p.label, icon: p.icon as React.ReactElement }))} selected={filterPriorities} onToggle={toggleArr(setFilterPriorities)} />
          <MultiSelectDropdown label={t('filter.reviewer')} options={sortUsersByDept(users.filter(u => u.isActive)).map(u => ({ id: u.id, label: u.name, avatar: u.avatar, avatarColor: u.color, subtitle: u.jobTitle }))} selected={filterReviewers} onToggle={toggleArr(setFilterReviewers)} />
          {!selectedProjectId && <MultiSelectDropdown label={t('filter.project')} options={allProjects.filter(p => !p.isArchived).map(p => ({ id: p.id, label: p.name, color: p.color }))} selected={filterProjects} onToggle={toggleArr(setFilterProjects)} />}
          <MultiSelectDropdown label={t('filter.tags')} options={tags.map(tg => ({ id: tg.id, label: tg.name, color: tg.color }))} selected={filterTags} onToggle={toggleArr(setFilterTags)} />
          {(filterDept.length > 0 || filterAssignees.length > 0 || filterStatuses.length > 0 || filterPriorities.length > 0 || filterReviewers.length > 0 || filterProjects.length > 0 || filterTags.length > 0) && (
            <button onClick={() => { setFilterDept([]); setFilterAssignees([]); setFilterStatuses([]); setFilterPriorities([]); setFilterReviewers([]); setFilterProjects([]); setFilterTags([]); }} className="text-sm text-muted-foreground hover:text-foreground">{t('button.clear')}</button>
          )}
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="mx-2 md:mx-5 mb-1">
          <BulkActionBar selectedIds={selectedIds} onClearSelection={clearSelection} />
        </div>
      )}

      <div className="flex-1 overflow-auto mx-2 md:mx-5 mb-2 md:mb-4 bg-card rounded-xl border border-border/80 shadow-sm">
        <div style={{ minWidth: tableMinWidth }}>
          {/* Header */}
          <div className="sticky top-0 z-[2] bg-card border-b border-border">
            <div className={`grid items-center ${isMobile ? 'px-3 py-2.5 gap-x-2' : 'px-4 py-2.5 gap-x-3'}`} style={{ gridTemplateColumns: gridTemplate }}>
              {!isMobile && (
                <div className="flex items-center justify-center" onClick={e => e.stopPropagation()}>
                  <Checkbox
                    checked={isAllSelected ? true : isPartialSelected ? 'indeterminate' : false}
                    onCheckedChange={v => v ? selectAll() : clearSelection()}
                    className="h-3.5 w-3.5"
                  />
                </div>
              )}
              {!isMobile && <span />}
              {visibleCols.map(col => (
                <SortHeader key={col.key} label={col.label} field={col.key} className="min-w-0 overflow-hidden truncate" />
              ))}
            </div>
          </div>

          {/* Rows grouped by project */}
          <div>
            {groupedByProject.map(({ project, line, tasks }) => {
              const isCollapsed = project ? collapsedProjects.includes(project.id) : false;
              return (
                <div key={project?.id || 'unknown'}>
                  {!selectedProjectId && project && (
                    <button onClick={() => toggleCollapse(project.id)} className="w-full flex items-center gap-2 px-3 py-2 text-sm font-semibold text-foreground hover:bg-accent/50 transition-colors bg-muted/50">
                      {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      {line && <span className="text-xs">{line.icon}</span>}
                      <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: project.color }} />
                      <span>{project.name}</span>
                      <span className="text-muted-foreground font-normal">({tasks.length})</span>
                    </button>
                  )}
                  {!isCollapsed && (() => {
                    const taskIds = new Set(tasks.map(t => t.id));
                    const rows: Array<{ task: typeof tasks[0]; isSubtask: boolean; hasSubtasks: boolean }> = [];
                    tasks.forEach(task => {
                      if (task.parentTaskId && taskIds.has(task.parentTaskId)) return;
                      const children = tasks.filter(t => t.parentTaskId === task.id);
                      rows.push({ task, isSubtask: false, hasSubtasks: children.length > 0 });
                      if (children.length > 0 && !collapsedSubtaskParents.has(task.id)) {
                        children.forEach(child => rows.push({ task: child, isSubtask: true, hasSubtasks: false }));
                      }
                    });
                    return rows.map(({ task, isSubtask, hasSubtasks }) => {
                      const status = statuses.find(s => s.id === task.statusId);
                      const isDone = status?.isDone;
                      const isSelected = selectedIds.has(task.id);
                      return (
                        <div
                          key={task.id}
                          onClick={() => setSelectedTask(task)}
                          className={`grid items-center ${isMobile ? 'gap-x-2' : 'gap-x-3'} border-b border-border/50 cursor-pointer transition-colors ${isSelected ? 'bg-blue-50 dark:bg-blue-950/20 hover:bg-blue-100 dark:hover:bg-blue-950/30' : 'hover:bg-accent/30'} ${isSubtask ? (isMobile ? 'px-3 py-2' : 'pr-4 py-2') : (isMobile ? 'px-3 py-2.5' : 'px-4 py-2.5')}`}
                          style={{ gridTemplateColumns: gridTemplate, paddingLeft: isSubtask ? (isMobile ? '28px' : '36px') : undefined }}
                        >
                          {!isMobile && (
                            <div
                              className="flex items-center justify-center"
                              onClick={e => { e.stopPropagation(); toggleSelect(task.id); }}
                            >
                              <Checkbox
                                checked={isSelected}
                                onCheckedChange={() => toggleSelect(task.id)}
                                className="h-3.5 w-3.5"
                              />
                            </div>
                          )}
                          {!isMobile && (
                            <div className="flex items-center justify-center">
                              {hasSubtasks ? (
                                <button
                                  type="button"
                                  onClick={e => {
                                    e.stopPropagation();
                                    setCollapsedSubtaskParents(prev => {
                                      const next = new Set(prev);
                                      if (next.has(task.id)) next.delete(task.id); else next.add(task.id);
                                      return next;
                                    });
                                  }}
                                  className="text-muted-foreground hover:text-foreground"
                                >
                                  {collapsedSubtaskParents.has(task.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                                </button>
                              ) : (
                                <div className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center ${isDone ? 'border-emerald-500 bg-emerald-500' : 'border-border bg-transparent'}`}>
                                  {isDone && <span className="text-[8px] text-white">✓</span>}
                                </div>
                              )}
                            </div>
                          )}
                          {visibleCols.map(col => (
                            <div key={col.key} className="min-w-0 overflow-hidden">{renderCell(task, col.key)}</div>
                          ))}
                        </div>
                      );
                    });
                  })()}
                </div>
              );
            })}
            {filteredTasks.length === 0 && (() => {
              const hasFilters = filterDept.length > 0 || filterAssignees.length > 0 || filterStatuses.length > 0 || filterPriorities.length > 0 || filterReviewers.length > 0 || filterProjects.length > 0 || filterTags.length > 0;
              return (
                <div className="flex flex-col items-center justify-center py-16 text-center px-4">
                  {hasFilters ? (
                    <>
                      <Search size={48} className="mb-3 text-slate-400" aria-hidden="true" />
                      <p className="text-sm font-semibold text-foreground mb-1">{t('list.noResults')}</p>
                      <p className="text-xs text-muted-foreground mb-3">{t('list.adjustFilters')}</p>
                      <button
                        onClick={() => { setFilterDept([]); setFilterAssignees([]); setFilterStatuses([]); setFilterPriorities([]); setFilterReviewers([]); setFilterProjects([]); setFilterTags([]); }}
                        className="text-sm text-primary hover:text-primary/80 font-medium transition-colors"
                      >
                        {t('button.clearAllFilters')}
                      </button>
                    </>
                  ) : (
                    <>
                      <ClipboardList size={48} className="mb-3 text-slate-400" aria-hidden="true" />
                      <p className="text-sm font-semibold text-foreground mb-1">{t('list.noTasks')}</p>
                      <p className="text-xs text-muted-foreground">{t('list.createFirstTask')}</p>
                    </>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ListView;
