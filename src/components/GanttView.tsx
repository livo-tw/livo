import { useProjectColor } from '@/hooks/useProjectColor';
import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { useAuthContext } from '@/context/AuthContext';
import { useMemberContext } from '@/context/MemberContext';
import { useUIContext } from '@/context/UIContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useTaskContext } from '@/context/TaskContext';
import { useSprintContext } from '@/context/SprintContext';
import { useLicense } from '@/context/LicenseContext';
import { logActivity } from '@/lib/activityLog';
import { deadlineTaskFields, planningErrorCode, setTaskDeadline } from '@/lib/taskPlanning/client';
import { deadlineReasonRequired } from '@/lib/taskPlanning/core';
import { TooltipProvider } from '@/components/ui/tooltip';
import { format } from 'date-fns';
import { taskDepartment, type Department } from '@/lib/department';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

import type { EnrichedTask, GanttFlatRow, GanttGroup, GroupByMode, ViewMode } from './gantt/types';
import { ROW_H, HEADER_H } from './gantt/types';
import { useGanttTimeline, useGanttTimelineNavigation } from './gantt/useGanttTimeline';
import { useGanttDrag } from './gantt/useGanttDrag';
import GanttToolbar from './gantt/GanttToolbar';
import GanttTimelineHeader from './gantt/GanttTimelineHeader';
import GanttTaskBar from './gantt/GanttTaskBar';
import GanttLeftPanel from './gantt/GanttLeftPanel';
import GanttDependencyArrows from './gantt/GanttDependencyArrows';
import GanttMobileTimeline from './gantt/GanttMobileTimeline';
import { useTranslation } from 'react-i18next';

const GanttView = () => {
  const getProjectColor = useProjectColor();
  const { t } = useTranslation();
  const { currentMemberId } = useAuthContext();
  const { users } = useMemberContext();
  const { setSelectedTask } = useUIContext();
  const { selectedProjectId, selectedLineId, allProjects, productLines } = useProjectContext();
  const { allTasks, statuses, setAllTasks, taskDependencies } = useTaskContext();
  const { sprints, currentSprint } = useSprintContext();
  const { hasFeature } = useLicense();
  const isMobile = useIsMobile();
  const scrollRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('day');
  const [groupBy, setGroupBy] = useState<GroupByMode>('project');
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [collapsedSubtaskParents, setCollapsedSubtaskParents] = useState<Set<string>>(new Set());
  const [filterDept, setFilterDept] = useState<Department[]>([]);
  const [selectedSprintId, setSelectedSprintId] = useState<string>('current');
  const [planningReason, setPlanningReason] = useState('');
  const [planningError, setPlanningError] = useState('');
  const [planningSaving, setPlanningSaving] = useState(false);

  // ─── Timeline Computation (with dynamic date range) ───
  const timelineWithTasks = useGanttTimeline(viewMode, allTasks);
  const { today, columns, cellW, timelineWidth, todayColIndex, dateToPx, todayPx, yearGroups } = timelineWithTasks;

  // ─── Timeline Navigation ───
  const timelineNav = useGanttTimelineNavigation(scrollRef, todayPx, timelineWidth, dateToPx);

  // ─── Drag Logic ───
  const drag = useGanttDrag({ cellW, pxToDate: timelineWithTasks.pxToDate, snapToPx: timelineWithTasks.snapToPx, allTasks, isMobile });
  const { dragInfo, pendingChange, setPendingChange, dragActivatedRef, handlePointerDown, handleTouchStart, dragPreviewDates, getDragBarPos } = drag;
  useEffect(() => { setPlanningReason(''); setPlanningError(''); }, [pendingChange]);
  const planningReasonRequired = !!pendingChange && deadlineReasonRequired(
    { dueDate: pendingChange.oldEnd || null, kind: pendingChange.dueDateKind }, pendingChange.newEnd || null);

  // ─── Enrichment & Grouping ───
  const enrichTask = useCallback((task: typeof allTasks[0]): EnrichedTask => {
    const project = allProjects.find(p => p.id === task.projectId);
    const start = new Date(task.startedAt || task.createdAt || Date.now());
    start.setHours(0, 0, 0, 0);
    const end = task.dueDate ? new Date(task.dueDate) : today;
    end.setHours(0, 0, 0, 0);
    const startPx = dateToPx(start);
    const endPx = dateToPx(end);
    const barWidth = Math.max(cellW, endPx - startPx + cellW);
    const isOverdue = task.dueDate && new Date(task.dueDate) < today && !task.completedAt;
    return { ...task, project, startPx, endPx, barWidth, isOverdue };
  }, [allProjects, dateToPx, today, cellW]);

  const sortTasks = useCallback((tasks: typeof allTasks) =>
    tasks.sort((a, b) => {
      const aS = new Date(a.startedAt || a.createdAt).getTime();
      const bS = new Date(b.startedAt || b.createdAt).getTime();
      if (aS !== bS) return aS - bS;
      const aD = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const bD = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      return aD - bD;
    }), []);

  const getFlatRows = useCallback((groupTasks: EnrichedTask[]): GanttFlatRow[] => {
    if (!hasFeature('subtasks')) return groupTasks.map(t => ({ task: t, isSubtask: false, hasSubtasks: false, isOrphan: false }));
    const rows: GanttFlatRow[] = [];
    const taskIds = new Set(groupTasks.map(t => t.id));
    groupTasks.forEach(task => {
      if (task.parentTaskId && taskIds.has(task.parentTaskId)) return;
      const children = groupTasks.filter(t => t.parentTaskId === task.id);
      const hasSubtasks = children.length > 0;
      rows.push({ task, isSubtask: !!task.parentTaskId, hasSubtasks, isOrphan: !!task.parentTaskId && !taskIds.has(task.parentTaskId) });
      if (hasSubtasks && !collapsedSubtaskParents.has(task.id)) {
        children.forEach(child => {
          rows.push({ task: child, isSubtask: true, hasSubtasks: false, isOrphan: false });
        });
      }
    });
    return rows;
  }, [hasFeature, collapsedSubtaskParents]);

  const getCollapsedParentBarPos = useCallback((task: EnrichedTask, groupTasks: EnrichedTask[]) => {
    const basePos = getDragBarPos(task);
    if (!hasFeature('subtasks') || !collapsedSubtaskParents.has(task.id)) return basePos;
    const subtasks = groupTasks.filter(t => t.parentTaskId === task.id);
    if (subtasks.length === 0) return basePos;
    let minLeft = basePos.left;
    let maxRight = basePos.left + basePos.width;
    subtasks.forEach(sub => {
      const subPos = getDragBarPos(sub);
      minLeft = Math.min(minLeft, subPos.left);
      maxRight = Math.max(maxRight, subPos.left + subPos.width);
    });
    return { left: minLeft, width: maxRight - minLeft };
  }, [getDragBarPos, hasFeature, collapsedSubtaskParents]);

  const getBarPos = useCallback((task: EnrichedTask, groupTasks: EnrichedTask[], hasSubtasks: boolean) => {
    return hasSubtasks ? getCollapsedParentBarPos(task, groupTasks) : getDragBarPos(task);
  }, [getCollapsedParentBarPos, getDragBarPos]);

  const visibleProjectIds = useMemo(() => {
    if (selectedProjectId) return [selectedProjectId];
    if (selectedLineId) return allProjects.filter(p => p.lineId === selectedLineId).map(p => p.id);
    return allProjects.map(p => p.id);
  }, [selectedProjectId, selectedLineId, allProjects]);

  const effectiveLineId = selectedProjectId
    ? allProjects.find(p => p.id === selectedProjectId)?.lineId ?? null
    : selectedLineId;

  const legendProjects = useMemo(() => {
    if (selectedProjectId) return allProjects.filter(p => p.id === selectedProjectId);
    if (effectiveLineId) return allProjects.filter(p => p.lineId === effectiveLineId);
    return allProjects.filter(p => !p.isArchived);
  }, [selectedProjectId, effectiveLineId, allProjects]);

  const grouped: GanttGroup[] = useMemo(() => {
    const isViewingPastSprint = selectedSprintId !== 'current' && selectedSprintId !== 'all';
    const isViewingAll = selectedSprintId === 'all';

    let activeTasks = allTasks.filter(t => {
      if (!visibleProjectIds.includes(t.projectId)) return false;
      if (isViewingAll) return true;
      if (isViewingPastSprint) return t.sprintId === selectedSprintId;
      // "Current": the active sprint's tasks; without an active sprint, every open task.
      if (currentSprint) return t.sprintId === currentSprint.id;
      const s = statuses.find(s => s.id === t.statusId);
      return s && !s.isDone;
    });
    if (filterDept.length > 0) {
      activeTasks = activeTasks.filter(t => filterDept.includes(taskDepartment(t, users) as Department));
    }

    if (groupBy === 'member') {
      const known = new Set(users.map(user => user.id));
      return [...users.map(user => ({
        id: user.id, label: user.name, avatar: user.avatar, color: user.color,
        tasks: sortTasks(activeTasks.filter(t => t.assigneeId === user.id)).map(enrichTask),
      })), {
        // Unassigned tasks (or a removed member's) still need a row.
        id: '__unassigned', label: t('common.unassigned'), color: '#6B778C',
        tasks: sortTasks(activeTasks.filter(t => !t.assigneeId || !known.has(t.assigneeId))).map(enrichTask),
      }].filter(g => g.tasks.length > 0);
    }
    if (groupBy === 'line') {
      return productLines.map(line => ({
        id: line.id, label: line.name, icon: line.icon, color: line.color,
        tasks: sortTasks(activeTasks.filter(t => {
          const p = allProjects.find(p => p.id === t.projectId);
          return p?.lineId === line.id;
        })).map(enrichTask),
      })).filter(g => g.tasks.length > 0);
    }
    // An archived project the sidebar selected still shows its tasks.
    return allProjects.filter(p => !p.isArchived || visibleProjectIds.includes(p.id)).map(proj => ({
      id: proj.id, label: proj.name, color: getProjectColor(proj),
      tasks: sortTasks(activeTasks.filter(t => t.projectId === proj.id)).map(enrichTask),
    })).filter(g => g.tasks.length > 0);
  }, [allTasks, visibleProjectIds, dateToPx, today, cellW, allProjects, groupBy, filterDept, users, statuses, productLines, selectedSprintId, currentSprint, enrichTask, sortTasks, getProjectColor, t]);

  // ─── Scroll Sync ───
  const handleRightScroll = () => {
    if (scrollRef.current && leftRef.current) {
      leftRef.current.scrollTop = scrollRef.current.scrollTop;
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      const scrollTo = Math.max(0, todayPx - scrollRef.current.clientWidth / 3);
      scrollRef.current.scrollLeft = scrollTo;
    }
  }, [viewMode, todayPx]);

  // ─── Confirm / Cancel Change ───
  const confirmChange = async () => {
    if (!pendingChange || planningSaving) return;
    const task = allTasks.find(t => t.id === pendingChange.taskId);
    if (!task) { setPendingChange(null); return; }

    setPlanningSaving(true); setPlanningError('');
    try {
      const row = await setTaskDeadline(task.id,
        { dueDate: pendingChange.oldEnd || null, kind: pendingChange.dueDateKind, version: pendingChange.dueDateVersion },
        pendingChange.newEnd || null, pendingChange.newEnd ? pendingChange.dueDateKind : null, planningReason,
        pendingChange.newStart !== pendingChange.oldStart ? { before: pendingChange.oldStart || null, next: pendingChange.newStart || null } : undefined);
      const merge = (card: typeof task) => card.id !== row.id || (card.dueDateVersion ?? 0) > row.due_date_version ? card : { ...card, ...deadlineTaskFields(row) };
      setAllTasks(previous => previous.map(merge));
      setSelectedTask(previous => previous ? merge(previous) : previous);
    } catch (failure) {
      setPlanningError(planningErrorCode(failure)); setPlanningSaving(false); return;
    }

    if (currentMemberId) {
      const details: string[] = [];
      if (pendingChange.oldStart !== pendingChange.newStart) {
        details.push(`${t('gantt.startDate')}${pendingChange.oldStart || t('common.none')} → ${pendingChange.newStart || t('common.none')}`);
      }
      if (pendingChange.oldEnd !== pendingChange.newEnd) {
        details.push(`${t('gantt.dueDate')}${pendingChange.oldEnd || t('common.none')} → ${pendingChange.newEnd || t('common.none')}`);
      }
      if (details.length > 0) {
        logActivity(currentMemberId, 'gantt_date_change', `${t('gantt.dragHint')}：${details.join('、')}`, task.id, task.taskKey);
      }
    }
    setPendingChange(null);
    setPlanningSaving(false);
  };

  const cancelChange = () => { if (!planningSaving) setPendingChange(null); };
  const fmtDisplay = (d?: string) => d ? format(new Date(d), 'yyyy/MM/dd') : t('common.none');

  // ─── Render ───
  return (
    <TooltipProvider delayDuration={200}>
    <div className="flex-1 flex flex-col overflow-hidden bg-board">
      <GanttToolbar
        groupBy={groupBy} setGroupBy={setGroupBy}
        viewMode={viewMode} setViewMode={setViewMode}
        filterDept={filterDept} setFilterDept={setFilterDept}
        selectedSprintId={selectedSprintId} setSelectedSprintId={setSelectedSprintId}
        currentSprint={currentSprint} sprints={sprints}
        legendProjects={legendProjects}
        onScrollLeft={timelineNav.scrollLeft}
        onScrollRight={timelineNav.scrollRight}
        onScrollToToday={timelineNav.scrollToToday}
      />

      {isMobile ? (
        <GanttMobileTimeline
          grouped={grouped}
          statuses={statuses}
          onSelectTask={setSelectedTask}
        />
      ) : (
      <div className="flex-1 flex overflow-hidden mx-2 md:mx-5 mb-2 md:mb-4 bg-card rounded-xl border border-border/80 shadow-sm">
        <GanttLeftPanel
          grouped={grouped}
          collapsedGroups={collapsedGroups}
          setCollapsedGroups={setCollapsedGroups}
          collapsedSubtaskParents={collapsedSubtaskParents}
          setCollapsedSubtaskParents={setCollapsedSubtaskParents}
          getFlatRows={getFlatRows}
          onSelectTask={setSelectedTask}
          groupBy={groupBy}
          leftRef={leftRef as React.RefObject<HTMLDivElement>}
        />

        {/* Right Panel: Timeline */}
        <div ref={scrollRef} className="flex-1 overflow-auto" onScroll={handleRightScroll} style={{ cursor: dragInfo ? 'grabbing' : undefined, touchAction: dragInfo ? 'none' : undefined }}>
          <GanttTimelineHeader
            viewMode={viewMode}
            columns={columns}
            cellW={cellW}
            timelineWidth={timelineWidth}
            todayColIndex={todayColIndex}
            today={today}
            yearGroups={yearGroups}
          />

          {/* Task rows */}
          <div className="relative" style={{ width: timelineWidth }}>
            {/* Today line */}
            <div className="absolute top-0 bottom-0 z-[3] pointer-events-none" style={{ left: todayPx - 1 }}>
              <div className="absolute -top-[22px] left-1/2 -translate-x-1/2 bg-destructive text-destructive-foreground text-[11px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap">
                {t('gantt.today')}
              </div>
              <div className="w-0.5 h-full bg-destructive" />
            </div>

            {/* Dependency arrows */}
            {hasFeature('task-dependencies') && (
              <GanttDependencyArrows
                grouped={grouped}
                collapsedGroups={collapsedGroups}
                taskDependencies={taskDependencies}
                timelineWidth={timelineWidth}
                getFlatRows={getFlatRows}
                getBarPos={getBarPos}
              />
            )}

            {/* v25: column grid lines via CSS background — replaces N column divs per row.
                Massive DOM savings on 6-year range (was ~50 tasks × 72 month cols = 3600 nodes → ~50 nodes total). */}
            {(() => {
              const gridBg = {
                backgroundImage: `linear-gradient(90deg, transparent calc(${cellW}px - 1px), hsl(var(--border)) calc(${cellW}px - 1px), hsl(var(--border)) ${cellW}px)`,
                backgroundSize: `${cellW}px 100%`,
                backgroundRepeat: 'repeat-x',
              } as React.CSSProperties;
              return grouped.map(group => {
                const isCollapsed = collapsedGroups.includes(group.id);
                return (
                <div key={group.id}>
                  {/* Group header row — single div with grid backdrop */}
                  <div className="bg-muted/50" style={{ height: ROW_H, ...gridBg }} />
                  {/* Task rows — each row: 1 div backdrop + 1 bar */}
                  {!isCollapsed && getFlatRows(group.tasks).map(({ task, isSubtask, hasSubtasks }) => {
                    const barPos = getBarPos(task, group.tasks, hasSubtasks);
                    const isDragging = dragInfo?.taskId === task.id;
                    return (
                    <div key={task.id} className="relative" style={{ height: ROW_H, ...gridBg }}>
                      <GanttTaskBar
                        task={task}
                        isSubtask={isSubtask}
                        barPos={barPos}
                        isDragging={!!isDragging}
                        dragPreviewDates={isDragging ? dragPreviewDates : null}
                        users={users}
                        onPointerDown={handlePointerDown}
                        onTouchStart={handleTouchStart}
                        onClickTask={setSelectedTask}
                        dragActivatedRef={dragActivatedRef}
                      />
                    </div>
                    );
                  })}
                </div>
                );
              });
            })()}
          </div>
        </div>
      </div>
      )}
    </div>

    {/* Confirmation dialog */}
    <AlertDialog open={!!pendingChange} onOpenChange={open => { if (!open) cancelChange(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('gantt.confirmDateChange')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p className="font-medium text-foreground">{pendingChange?.taskKey}: {pendingChange?.taskTitle}</p>
              <div className="grid grid-cols-[80px_1fr] gap-y-1 text-sm">
                <span className="text-muted-foreground">{t('gantt.startDate')}</span>
                <span>
                  {pendingChange?.oldStart !== pendingChange?.newStart ? (
                    <><span className="line-through text-muted-foreground">{fmtDisplay(pendingChange?.oldStart)}</span> → <span className="font-medium text-primary">{fmtDisplay(pendingChange?.newStart)}</span></>
                  ) : (
                    <span>{fmtDisplay(pendingChange?.newStart)}</span>
                  )}
                </span>
                <span className="text-muted-foreground">{t('gantt.dueDate')}</span>
                <span>
                  {pendingChange?.oldEnd !== pendingChange?.newEnd ? (
                    <><span className="line-through text-muted-foreground">{fmtDisplay(pendingChange?.oldEnd)}</span> → <span className="font-medium text-primary">{fmtDisplay(pendingChange?.newEnd)}</span></>
                  ) : (
                    <span>{fmtDisplay(pendingChange?.newEnd)}</span>
                  )}
                </span>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {pendingChange?.oldEnd !== pendingChange?.newEnd && <label className="block text-sm">
          {t(planningReasonRequired ? 'taskPlanning.reasonRequired' : 'taskPlanning.reason')}
          <textarea className="mt-1 block w-full rounded border bg-background p-2" value={planningReason} maxLength={2000} disabled={planningSaving} onChange={event => setPlanningReason(event.target.value)} />
        </label>}
        {planningError && <p role="alert">{t(`taskPlanning.errors.${planningError}`)}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={planningSaving} onClick={cancelChange}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction disabled={planningSaving || (planningReasonRequired && !planningReason.trim())} onClick={event => { event.preventDefault(); void confirmChange(); }}>{t('button.confirmChange')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </TooltipProvider>
  );
};

export default GanttView;
