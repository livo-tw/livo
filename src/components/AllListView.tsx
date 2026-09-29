import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import type { Task } from '@/types';
import { useUIContext } from '@/context/UIContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useTaskContext } from '@/context/TaskContext';
import { useMemberContext } from '@/context/MemberContext';
import { useSprintContext } from '@/context/SprintContext';
import { ChevronDown, ChevronUp, Download, Search, ClipboardList, FileSpreadsheet, FileText } from 'lucide-react';
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
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';

const ROW_HEIGHT = 41;

interface SortHeaderProps {
  label: string;
  field: string;
  width?: string;
  sortKey: string;
  sortDir: 'asc' | 'desc';
  onToggle: (field: string) => void;
}

const SortHeader = ({ label, field, width, sortKey, sortDir, onToggle }: SortHeaderProps) => (
  <th onClick={() => onToggle(field)} className="text-left text-[13px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground cursor-pointer select-none px-2 py-2.5 whitespace-nowrap" style={{ width }}>
    <span className="flex items-center gap-1">
      {label}
      {sortKey === field && (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
    </span>
  </th>
);

function escCsvCell(val: string): string {
  if (!val) return '';
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

const ExportDropdown = ({ onCsv, onExcel, onPdf, isMobile }: { onCsv: () => void; onExcel: () => void; onPdf: () => void; isMobile: boolean }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [open]);

  const items = [
    { label: 'CSV', icon: <Download size={14} />, action: onCsv },
    { label: 'Excel', icon: <FileSpreadsheet size={14} />, action: onExcel },
    { label: 'PDF', icon: <FileText size={14} />, action: onPdf },
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        title={t('list.exportCsvTitle')}
        className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-1 rounded hover:bg-accent"
      >
        <Download size={14} />
        {!isMobile && <span>{t('common.export')}</span>}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-popover border border-border rounded-lg shadow-lg py-1 z-20 min-w-[140px] max-w-[calc(100vw-16px)]">
          {items.map(item => (
            <button
              key={item.label}
              onClick={() => { item.action(); setOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent transition-colors"
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const AllListView = () => {
  const { t } = useTranslation();
  const { setSelectedTask } = useUIContext();
  const { selectedProjectId, selectedLineId, allProjects } = useProjectContext();
  const { allTasks, statuses, tags } = useTaskContext();
  const { users } = useMemberContext();
  const { sprints } = useSprintContext();
  const isMobile = useIsMobile();

  const { columnConfig, renderCell } = useListColumns({
    storageKey: 'alllist-columns',
    includeCustomFields: true,
    selectedProjectId,
  });

  const [sortKey, setSortKey] = useState<string>('taskKey');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
  const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
  const [filterAssignees, setFilterAssignees] = useState<string[]>([]);
  const [filterProjects, setFilterProjects] = useState<string[]>([]);
  const [filterDept, setFilterDept] = useState<Department[]>([]);
  const [filterReviewers, setFilterReviewers] = useState<string[]>([]);

  const toggleArr = useCallback((setter: React.Dispatch<React.SetStateAction<string[]>>) => (id: string) =>
    setter(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]), []);

  const hasFilters = filterStatuses.length > 0 || filterPriorities.length > 0 || filterAssignees.length > 0 || filterProjects.length > 0 || filterDept.length > 0 || filterReviewers.length > 0;
  const clearFilters = useCallback(() => { setFilterStatuses([]); setFilterPriorities([]); setFilterAssignees([]); setFilterProjects([]); setFilterDept([]); setFilterReviewers([]); }, []);

  const exportCsv = useCallback((tasks: Task[]) => {
    const statusMap = Object.fromEntries(statuses.map(s => [s.id, s.name]));
    const userMap = Object.fromEntries(users.map(u => [u.id, u.name]));
    const projectMap = Object.fromEntries(allProjects.map(p => [p.id, p.name]));
    const sprintMap = Object.fromEntries(sprints.map(s => [s.id, s.name]));
    const tagMap = Object.fromEntries(tags.map(tg => [tg.id, tg.name]));
    const priorityLabels: Record<string, string> = { highest: t('priority.highest'), high: t('priority.high'), medium: t('priority.medium'), low: t('priority.low'), lowest: t('priority.lowest') };

    const headers = [t('csv.taskKey'), t('csv.title'), t('csv.status'), t('csv.priority'), t('csv.assignee'), t('csv.reviewer'), t('csv.project'), t('csv.tags'), t('csv.createdAt'), t('csv.completedAt'), t('csv.sprint')];
    const rows = tasks.map(tk => [
      escCsvCell(tk.taskKey),
      escCsvCell(tk.title),
      escCsvCell(statusMap[tk.statusId] || ''),
      escCsvCell(priorityLabels[tk.priority] || tk.priority),
      escCsvCell(tk.assigneeId ? (userMap[tk.assigneeId] || '') : ''),
      escCsvCell(tk.reviewerId ? (userMap[tk.reviewerId] || '') : ''),
      escCsvCell(projectMap[tk.projectId] || ''),
      escCsvCell((tk.tagIds || []).map(id => tagMap[id] || '').filter(Boolean).join('/')),
      escCsvCell(tk.createdAt ? tk.createdAt.slice(0, 10) : ''),
      escCsvCell(tk.completedAt ? tk.completedAt.slice(0, 10) : ''),
      escCsvCell(tk.sprintId ? (sprintMap[tk.sprintId] || '') : ''),
    ].join(','));

    const csv = '\uFEFF' + [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date();
    a.href = url;
    a.download = `${t('list.csvFilename')}_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [statuses, users, allProjects, sprints, tags]);

  const getExportData = useCallback((tasks: Task[]) => {
    const statusMap = Object.fromEntries(statuses.map(s => [s.id, s.name]));
    const userMap = Object.fromEntries(users.map(u => [u.id, u.name]));
    const projectMap = Object.fromEntries(allProjects.map(p => [p.id, p.name]));
    const sprintMap = Object.fromEntries(sprints.map(s => [s.id, s.name]));
    const tagMap = Object.fromEntries(tags.map(tg => [tg.id, tg.name]));
    const priorityLabels: Record<string, string> = { highest: t('priority.highest'), high: t('priority.high'), medium: t('priority.medium'), low: t('priority.low'), lowest: t('priority.lowest') };
    const headers = [t('csv.taskKey'), t('csv.title'), t('csv.status'), t('csv.priority'), t('csv.assignee'), t('csv.reviewer'), t('csv.project'), t('csv.tags'), t('csv.createdAt'), t('csv.completedAt'), t('csv.sprint')];
    const rows = tasks.map(tk => [
      tk.taskKey, tk.title, statusMap[tk.statusId] || '', priorityLabels[tk.priority] || tk.priority,
      tk.assigneeId ? (userMap[tk.assigneeId] || '') : '', tk.reviewerId ? (userMap[tk.reviewerId] || '') : '',
      projectMap[tk.projectId] || '', (tk.tagIds || []).map(id => tagMap[id] || '').filter(Boolean).join('/'),
      tk.createdAt ? tk.createdAt.slice(0, 10) : '', tk.completedAt ? tk.completedAt.slice(0, 10) : '',
      tk.sprintId ? (sprintMap[tk.sprintId] || '') : '',
    ]);
    return { headers, rows };
  }, [statuses, users, allProjects, sprints, tags]);

  const exportExcel = useCallback((tasks: Task[]) => {
    const { headers, rows } = getExportData(tasks);
    const tableHtml = `<table><thead><tr>${headers.map(h => `<th style="font-weight:bold;background:#4472C4;color:#fff;padding:4px 8px">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td style="padding:4px 8px;border:1px solid #D9E2F3">${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    const blob = new Blob([`<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"></head><body>${tableHtml}</body></html>`], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date();
    a.href = url;
    a.download = `LIVO_Tasks_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.xls`;
    a.click();
    URL.revokeObjectURL(url);
  }, [getExportData]);

  const exportPdf = useCallback((tasks: Task[]) => {
    const { headers, rows } = getExportData(tasks);
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const printWin = window.open('', '_blank');
    if (!printWin) return;
    printWin.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>LIVO ${t('list.allListTitle')}</title><style>
      @page { size: A4 landscape; margin: 12mm; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 11px; color: #333; }
      h1 { font-size: 16px; margin-bottom: 8px; }
      table { width: 100%; border-collapse: collapse; }
      th { background: #1e3a5f; color: #fff; padding: 6px 8px; text-align: left; font-size: 10px; }
      td { padding: 5px 8px; border-bottom: 1px solid #ddd; font-size: 10px; }
      tr:nth-child(even) td { background: #f5f7fa; }
    </style></head><body>
      <h1>LIVO ${t('list.allListTitle')} — ${dateStr}</h1>
      <table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>
    </body></html>`);
    printWin.document.close();
    printWin.focus();
    setTimeout(() => { printWin.print(); printWin.close(); }, 500);
  }, [getExportData]);

  const filteredTasks = useMemo(() => {
    let tasks = allTasks;
    if (selectedProjectId) tasks = tasks.filter(t => t.projectId === selectedProjectId);
    else if (selectedLineId) {
      const lineProjectIds = allProjects.filter(p => p.lineId === selectedLineId).map(p => p.id);
      tasks = tasks.filter(t => lineProjectIds.includes(t.projectId));
    }
    if (filterStatuses.length > 0) tasks = tasks.filter(t => filterStatuses.includes(t.statusId));
    if (filterPriorities.length > 0) tasks = tasks.filter(t => filterPriorities.includes(t.priority));
    if (filterAssignees.length > 0) tasks = tasks.filter(t => t.assigneeId && filterAssignees.includes(t.assigneeId));
    if (filterProjects.length > 0) tasks = tasks.filter(t => filterProjects.includes(t.projectId));
    if (filterDept.length > 0) tasks = tasks.filter(t => { const a = users.find(u => u.id === t.assigneeId); return filterDept.includes(getDepartment(a) as Department); });
    if (filterReviewers.length > 0) tasks = tasks.filter(t => t.reviewerId && filterReviewers.includes(t.reviewerId));
    return tasks;
  }, [allTasks, selectedProjectId, selectedLineId, filterStatuses, filterPriorities, filterAssignees, filterProjects, filterDept, filterReviewers, users]);

  const toggleSort = useCallback((key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  }, [sortKey]);

  const projectMap = useMemo(() => new Map(allProjects.map(p => [p.id, p])), [allProjects]);
  const statusMap = useMemo(() => new Map(statuses.map(s => [s.id, s])), [statuses]);
  const userSortMap = useMemo(() => new Map(users.map(u => [u.id, u.sortOrder ?? 999])), [users]);
  const sprintMap = useMemo(() => new Map(sprints.map(s => [s.id, s.name])), [sprints]);

  const sortValue = (task: Task, key: string): string | number => {
    switch (key) {
      case 'taskKey': return parseInt(task.taskKey.split('-').pop() || '0', 10);
      case 'title': return task.title;
      case 'project': return projectMap.get(task.projectId)?.name || 'zzz';
      case 'status': return statusMap.get(task.statusId)?.sortOrder ?? 0;
      case 'priority': { const o: Record<string, number> = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 }; return o[task.priority]; }
      case 'createdAt': return task.createdAt || '';
      case 'startedAt': return task.startedAt || '9999';
      case 'dueDate': return task.dueDate || '9999';
      case 'sprint': return sprintMap.get(task.sprintId || '') || 'zzz';
      case 'department': return task.department || 'zzz';
      case 'assignee': return userSortMap.get(task.assigneeId || '') ?? 999;
      case 'reviewer': return userSortMap.get(task.reviewerId || '') ?? 999;
      default: return '';
    }
  };

  const sortedTasks = useMemo(() => {
    return [...filteredTasks].sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filteredTasks, sortKey, sortDir, users, statuses, sprints]);

  const { selectedIds, toggleSelect, selectAll, clearSelection, isAllSelected, isPartialSelected } = useBulkActions(filteredTasks);

  const tableContainerRef = useRef<HTMLDivElement>(null);

  const mobileVisibleKeys = new Set(['title', 'status', 'assignee']);
  const visibleCols = isMobile
    ? columnConfig.visibleColumns.filter(c => c.fixed || mobileVisibleKeys.has(c.key))
    : columnConfig.visibleColumns;

  const rowVirtualizer = useVirtualizer({
    count: sortedTasks.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const tableMinWidth = useMemo(() => {
    const checkboxCol = isMobile ? 0 : 32;
    let total = checkboxCol;
    visibleCols.forEach(c => {
      if (c.key === 'title') total += 200;
      else total += parseInt(c.width || '100', 10) || 100;
    });
    return isMobile ? `${total}px` : `${Math.max(total, 600)}px`;
  }, [visibleCols, isMobile]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-board">
      <div className="px-3 md:px-5 pt-3 md:pt-4 pb-2">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-base md:text-lg font-bold text-foreground">{t('list.allListTitle')}</h1>
          <div className="flex items-center gap-2">
            {!isMobile && <ColumnConfigDropdown config={columnConfig} fixedKeys={FIXED_KEYS} />}
            <ExportDropdown
              onCsv={() => exportCsv(sortedTasks)}
              onExcel={() => exportExcel(sortedTasks)}
              onPdf={() => exportPdf(sortedTasks)}
              isMobile={isMobile}
            />
            <span className="text-[13px] text-muted-foreground">{sortedTasks.length} / {allTasks.length}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
          <DepartmentFilter value={filterDept} onChange={setFilterDept} />
          <MultiSelectDropdown label={isMobile ? t('filter.assigneeMobile') : t('filter.assignee')} options={sortUsersByDept(users.filter(u => u.isActive)).map(u => ({ id: u.id, label: u.name, avatar: u.avatar, avatarColor: u.color, subtitle: u.jobTitle }))} selected={filterAssignees} onToggle={toggleArr(setFilterAssignees)} />
          <MultiSelectDropdown label={t('filter.status')} options={statuses.map(s => ({ id: s.id, label: s.name, color: s.color }))} selected={filterStatuses} onToggle={toggleArr(setFilterStatuses)} />
          <MultiSelectDropdown label={isMobile ? t('filter.priorityMobile') : t('filter.priority')} options={Object.entries(priorityConfig).map(([k, v]) => ({ id: k, label: v.label, icon: v.icon }))} selected={filterPriorities} onToggle={toggleArr(setFilterPriorities)} />
          {!isMobile && <MultiSelectDropdown label={t('filter.reviewer')} options={sortUsersByDept(users.filter(u => u.isActive)).map(u => ({ id: u.id, label: u.name, avatar: u.avatar, avatarColor: u.color, subtitle: u.jobTitle }))} selected={filterReviewers} onToggle={toggleArr(setFilterReviewers)} />}
          {!selectedProjectId && <MultiSelectDropdown label={t('filter.project')} options={allProjects.filter(p => !p.isArchived).map(p => ({ id: p.id, label: p.name, color: p.color }))} selected={filterProjects} onToggle={toggleArr(setFilterProjects)} />}
          {hasFilters && <button onClick={clearFilters} className="text-[13px] text-muted-foreground hover:text-foreground">{t('button.clear')}</button>}
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="mx-2 md:mx-5 mb-1">
          <BulkActionBar selectedIds={selectedIds} onClearSelection={clearSelection} />
        </div>
      )}

      <div ref={tableContainerRef} className="flex-1 overflow-auto mx-2 md:mx-5 mb-2 md:mb-4 bg-card rounded-xl border border-border/80 shadow-sm">
        <table className="w-full text-sm" style={{ minWidth: tableMinWidth }}>
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
                <SortHeader key={col.key} label={col.label} field={col.key} width={col.width} sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedTasks.length === 0 ? (
              <tr>
                <td colSpan={visibleCols.length + 2} className="py-16 text-center">
                  <div className="flex flex-col items-center justify-center px-4">
                    {hasFilters ? (
                      <>
                        <Search size={48} className="mb-3 text-slate-400" aria-hidden="true" />
                        <p className="text-sm font-semibold text-foreground mb-1">{t('list.noResults')}</p>
                        <p className="text-xs text-muted-foreground mb-3">{t('list.adjustFilters')}</p>
                        <button
                          onClick={clearFilters}
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
                </td>
              </tr>
            ) : (() => {
              const virtualItems = rowVirtualizer.getVirtualItems();
              const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
              const paddingBottom = virtualItems.length > 0
                ? rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
                : 0;
              return (
                <>
                  {paddingTop > 0 && <tr><td colSpan={visibleCols.length + 2} style={{ height: paddingTop, padding: 0 }} /></tr>}
                  {virtualItems.map(virtualRow => {
                    const task = sortedTasks[virtualRow.index];
                    const isSelected = selectedIds.has(task.id);
                    return (
                      <tr
                        key={task.id}
                        data-index={virtualRow.index}
                        ref={rowVirtualizer.measureElement}
                        onClick={() => setSelectedTask(task)}
                        className={`border-b border-border/40 cursor-pointer transition-colors ${isSelected ? 'bg-primary/5' : 'hover:bg-accent/50'}`}
                      >
                        {!isMobile && (
                          <td className="px-2 py-1 w-8">
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => toggleSelect(task.id)}
                              onClick={e => e.stopPropagation()}
                            />
                          </td>
                        )}
                        {visibleCols.map(col => (
                          <td key={col.key} className={`px-2 py-2 text-sm text-foreground whitespace-nowrap ${col.key === 'title' ? 'max-w-[260px] overflow-hidden text-ellipsis' : ''}`}>
                            {renderCell(task, col.key)}
                          </td>
                        ))}
                        <td className="w-4" />
                      </tr>
                    );
                  })}
                  {paddingBottom > 0 && <tr><td colSpan={visibleCols.length + 2} style={{ height: paddingBottom, padding: 0 }} /></tr>}
                </>
              );
            })()}
          </tbody>
        </table>
      </div>

    </div>
  );
};

export default AllListView;