import { sprintBacklogTaskIds } from '@/lib/sprintBacklog';
import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { useUIContext } from '@/context/UIContext';
import { useTaskContext } from '@/context/TaskContext';
import { useMemberContext } from '@/context/MemberContext';
import { useSprintContext } from '@/context/SprintContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useProjectScope, useScopedProjectFilter } from '@/hooks/useProjectScope';
import { toast } from 'sonner';
import { SprintCompleteModal, SprintStartModal } from '@/components/board/SprintModals';
import { useSprintFlow } from '@/hooks/useSprintFlow';
import { priorityConfig } from '@/components/ui/badges';
import { ChevronDown, ChevronRight, Zap, ArrowUp, ArrowDown, Lightbulb } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DndContext, DragOverlay, useDroppable, useDraggable,
  type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core';
import type { Task } from '@/types';
import BoardFilterChips from '@/components/board/BoardFilterChips';
import { useBoardFilters } from '@/hooks/useBoardFilters';
import { useBoardSensors } from '@/hooks/useBoardSensors';
import { taskDepartment, type Department } from '@/lib/department';

/* ── Droppable zone ── */
function DroppableZone({ id, children, isOver }: { id: string; children: React.ReactNode; isOver?: boolean }) {
  const { isOver: dndIsOver, setNodeRef } = useDroppable({ id });
  const active = isOver ?? dndIsOver;
  return (
    <div ref={setNodeRef} className={`transition-colors rounded-lg ${active ? 'bg-primary/5 ring-1 ring-primary/20' : ''}`}>
      {children}
    </div>
  );
}

/* ── Draggable task row ── */
function DraggableTaskRow({ task, children }: { task: Task; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} data-drag-surface className={`select-none ${isDragging ? 'opacity-30' : ''}`}
      style={{ touchAction: 'pan-x pan-y', WebkitTouchCallout: 'none' }}>
      {children}
    </div>
  );
}

/* ── Task row component ── */
function TaskRow({
  task, statuses, userMap, selected, onToggleSelect, onClickTask, actionButton,
}: {
  task: Task;
  statuses: { id: string; name: string; color: string }[];
  userMap: Map<string, { name: string; avatar: string; color: string }>;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onClickTask: (task: Task) => void;
  actionButton?: React.ReactNode;
}) {
  const status = statuses.find(s => s.id === task.statusId);
  const assignee = task.assigneeId ? userMap.get(task.assigneeId) : null;
  const pConfig = priorityConfig[task.priority as keyof typeof priorityConfig];

  return (
    <div
      className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border/40 hover:bg-accent/50 transition-colors cursor-pointer group sm:flex-nowrap"
      onClick={() => onClickTask(task)}
    >
      <div data-no-drag className="flex min-h-11 min-w-11 items-center justify-center sm:min-h-0 sm:min-w-0" onClick={e => { e.stopPropagation(); if (e.target === e.currentTarget) onToggleSelect(task.id); }}>
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(task.id)}
          className="h-5 w-5 sm:h-3.5 sm:w-3.5"
        />
      </div>
      <span className="text-xs text-muted-foreground font-mono w-16 flex-shrink-0 truncate">{task.taskKey}</span>
      <span className="min-w-0 flex-[1_1_calc(100%-8rem)] text-sm text-foreground break-words line-clamp-2 sm:flex-1 sm:truncate">{task.title}</span>
      {status && (
        <span
          className="text-[10px] px-2 py-0.5 rounded-full font-medium text-white flex-shrink-0"
          style={{ backgroundColor: status.color }}
        >
          {status.name}
        </span>
      )}
      {pConfig && (
        <span className="flex-shrink-0 text-sm" title={i18n.t(`priority.${task.priority}`, { defaultValue: pConfig.label })}>{pConfig.icon}</span>
      )}
      {assignee ? (
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-[8px] font-bold text-white flex-shrink-0"
          style={{ backgroundColor: assignee.color }}
          title={assignee.name}
        >
          {assignee.avatar}
        </div>
      ) : (
        <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[10px] text-muted-foreground flex-shrink-0">?</div>
      )}
      {actionButton && <div onClick={e => e.stopPropagation()} className="ml-auto flex-shrink-0 opacity-100 sm:opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity [&_button]:min-h-11 sm:[&_button]:min-h-0">{actionButton}</div>}
    </div>
  );
}

/* ── BacklogView ── */
const BacklogView = () => {
  const { t } = useTranslation();
  const { setSelectedTask } = useUIContext();
  const { allTasks, setAllTasks, statuses, updateTaskInDb } = useTaskContext();
  const { users } = useMemberContext();
  const { sprintActive, currentSprint, getDefaultSprintName } = useSprintContext();
  const { selectedProjectId, allProjects } = useProjectContext();
  const { inScope, projectIds: scopeIds } = useProjectScope();

  const [sprintCollapsed, setSprintCollapsed] = useState(false);
  const [backlogCollapsed, setBacklogCollapsed] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Completing and starting a sprint, shared with the board and the stand-up.
  const sprintFlow = useSprintFlow();
  const [activeId, setActiveId] = useState<string | null>(null);

  // Filters: the same state and chips as the board (useBoardFilters, BoardFilterChips).
  const boardFilters = useBoardFilters();
  const { filterDept, filterAssignees, filterStatuses, filterPriorities, filterReviewers, filterProjects, setFilterProjects } = boardFilters;
  useScopedProjectFilter(setFilterProjects);


  const userMap = useMemo(() => new Map(users.map(u => [u.id, u])), [users]);

  const doneIds = useMemo(() => statuses.filter(s => s.isDone).map(s => s.id), [statuses]);

  const applyFilters = useCallback((tasks: Task[]) => {
    // The sidebar project or product line scopes the backlog like every other task view.
    let result = tasks.filter(t => inScope(t.projectId));
    if (filterDept.length > 0) {
      // Same department rule as the board filter (lib/department taskDepartment).
      result = result.filter(t => filterDept.includes(taskDepartment(t, users) as Department));
    }
    if (filterAssignees.length > 0) result = result.filter(t => t.assigneeId && filterAssignees.includes(t.assigneeId));
    if (filterStatuses.length > 0) result = result.filter(t => filterStatuses.includes(t.statusId));
    if (filterPriorities.length > 0) result = result.filter(t => filterPriorities.includes(t.priority));
    if (filterReviewers.length > 0) result = result.filter(t => t.reviewerId && filterReviewers.includes(t.reviewerId));
    if (filterProjects.length > 0) result = result.filter(t => filterProjects.includes(t.projectId));
    return result;
  }, [inScope, filterDept, filterAssignees, filterStatuses, filterPriorities, filterReviewers, filterProjects, users]);

  const sprintTasks = useMemo(() => {
    const raw = currentSprint ? allTasks.filter(t => t.sprintId === currentSprint.id) : [];
    return applyFilters(raw);
  }, [allTasks, currentSprint, applyFilters]);

  const backlogTasks = useMemo(() =>
    applyFilters(allTasks.filter(t => !t.sprintId)),
    [allTasks, applyFilters]
  );

  const completedCount = useMemo(() =>
    sprintTasks.filter(t => doneIds.includes(t.statusId)).length,
    [sprintTasks, doneIds]
  );


  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const moveToSprint = useCallback(async (taskIds: string[]) => {
    if (!currentSprint) return;
    try {
      const updates = { sprintId: currentSprint.id };
      setAllTasks(prev => prev.map(t => taskIds.includes(t.id) ? { ...t, ...updates } : t));
      for (const id of taskIds) {
        await updateTaskInDb(id, { sprint_id: currentSprint.id } as any);
      }
      setSelectedIds(new Set());
    } catch (err) {
      console.error('[LIVO] BacklogView moveToSprint:', err);
      toast.error(t('error.updateFailed'));
    }
  }, [currentSprint, setAllTasks, updateTaskInDb]);

  const moveToBacklog = useCallback(async (taskIds: string[]) => {
    try {
      setAllTasks(prev => prev.map(t => taskIds.includes(t.id) ? { ...t, sprintId: undefined } : t));
      for (const id of taskIds) {
        await updateTaskInDb(id, { sprint_id: null } as any);
      }
      setSelectedIds(new Set());
    } catch (err) {
      console.error('[LIVO] BacklogView moveToBacklog:', err);
      toast.error(t('error.updateFailed'));
    }
  }, [setAllTasks, updateTaskInDb]);

  /* ── dnd-kit ── */
  const sensors = useBoardSensors();

  const activeTask = activeId ? allTasks.find(t => t.id === activeId) ?? null : null;

  const handleDragStart = useCallback((e: DragStartEvent) => setActiveId(e.active.id as string), []);
  const handleDragEnd = useCallback((e: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;
    const taskId = active.id as string;
    const zone = over.id as string;
    if (zone === 'sprint-zone') moveToSprint([taskId]);
    else if (zone === 'backlog-zone') moveToBacklog([taskId]);
  }, [moveToSprint, moveToBacklog]);
  const handleDragCancel = useCallback(() => setActiveId(null), []);

  /* ── Sprint actions ── */
  const handleStartNewSprint = sprintFlow.openStart;
  // Completing moves every unfinished task of the sprint, not only the ones the filters show.
  const sprintPendingTasks = useMemo(() => currentSprint ? allTasks.filter(t => t.sprintId === currentSprint.id && !doneIds.includes(t.statusId)) : [], [allTasks, currentSprint, doneIds]);
  const sprintCompletedCount = useMemo(() => currentSprint ? allTasks.filter(t => t.sprintId === currentSprint.id && doneIds.includes(t.statusId)).length : 0, [allTasks, currentSprint, doneIds]);

  const selectedInSprint = useMemo(() => {
    const sprintIdSet = new Set(sprintTasks.map(t => t.id));
    return [...selectedIds].filter(id => sprintIdSet.has(id));
  }, [selectedIds, sprintTasks]);

  const selectedInBacklog = useMemo(() => {
    const backlogIdSet = new Set(backlogTasks.map(t => t.id));
    return [...selectedIds].filter(id => backlogIdSet.has(id));
  }, [selectedIds, backlogTasks]);

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
    <div className="min-w-0 flex-1 overflow-auto bg-board">
      {/* Header */}
      <div className="px-3 md:px-5 pt-3 md:pt-4 pb-2">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-base md:text-lg font-bold text-foreground">{t('backlog.title')}</h1>
          <div className="flex items-center gap-2">
            {sprintActive && currentSprint ? (
              <button
                onClick={sprintFlow.openComplete}
                className="flex items-center gap-1 px-2.5 md:px-3 py-1.5 rounded text-[13px] font-medium transition-colors border bg-primary/10 text-primary border-primary/30 hover:bg-primary/20"
              >
                <Zap size={14} />
                {t('button.completeSprint')}
              </button>
            ) : (
              <button
                onClick={handleStartNewSprint}
                className="flex items-center gap-1 px-2.5 md:px-3 py-1.5 rounded text-[13px] font-medium transition-colors border bg-primary/10 text-primary border-primary/30 hover:bg-primary/20"
              >
                <Zap size={14} />
                {t('button.startSprint')}
              </button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground flex items-center gap-1"><Lightbulb size={12} /> {t('backlog.dragHint')}</p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-1.5 md:gap-2 px-3 md:px-5 pb-2 flex-wrap">
        <BoardFilterChips users={users} statusOptions={statuses.map(s => ({ id: s.id, label: s.name, color: s.color }))}
          allProjects={scopeIds ? allProjects.filter(p => scopeIds.has(p.id)) : allProjects} showProjects={!selectedProjectId} filters={boardFilters} />
      </div>
      {(sprintTasks.length > 0 || backlogTasks.length > 0) && <p className="px-3 pb-3 text-xs leading-relaxed text-muted-foreground md:hidden">{t('backlog.touchHint')}</p>}

      {/* Batch action bar */}
      {selectedInSprint.length + selectedInBacklog.length > 0 && (
        <div className="mx-3 md:mx-5 mb-2 flex flex-wrap items-center gap-2 px-3 py-2 bg-muted rounded-lg border border-border [&_button]:min-h-11 sm:[&_button]:min-h-0">
          <span className="text-xs font-medium text-foreground">{t('backlog.selected', { count: selectedInSprint.length + selectedInBacklog.length })}</span>
          {selectedInBacklog.length > 0 && currentSprint && (
            <button
              onClick={() => moveToSprint(selectedInBacklog)}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <ArrowUp size={12} /> {t('backlog.batchMoveToSprint')}
            </button>
          )}
          {selectedInSprint.length > 0 && (
            <button
              onClick={() => moveToBacklog(selectedInSprint)}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-muted-foreground/20 text-foreground hover:bg-muted-foreground/30 transition-colors"
            >
              <ArrowDown size={12} /> {t('backlog.batchMoveToBacklog')}
            </button>
          )}
          <button onClick={() => setSelectedIds(new Set())} className="text-xs text-muted-foreground hover:text-foreground ml-auto">{t('button.clear')}</button>
        </div>
      )}

      <div className="px-3 md:px-5 pb-4 space-y-3">
        {/* ── Current Sprint Section ── */}
        <DroppableZone id="sprint-zone">
          <div className="bg-card rounded-xl border border-border/80 shadow-sm overflow-hidden">
            <div
              className="flex items-center gap-2.5 px-3 md:px-4 py-2.5 md:py-3 cursor-pointer hover:bg-accent/30 transition-colors border-l-4 border-l-primary"
              onClick={() => setSprintCollapsed(prev => !prev)}
            >
              <span className="text-muted-foreground">
                {sprintCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
              </span>
              <Zap size={16} className="text-primary" />
              <span className="min-w-0 flex-1 break-words text-sm font-bold text-foreground">
                {currentSprint ? `${t('backlog.currentSprint')}: ${currentSprint.name}` : t('backlog.noActiveSprint')}
              </span>
              {currentSprint && (
                <>
                  <span className="shrink-0 text-[13px] text-muted-foreground ml-auto">
                    {t('backlog.progress', { completed: completedCount, total: sprintTasks.length })}
                  </span>
                  <span className="text-[13px] text-muted-foreground">({sprintTasks.length})</span>
                </>
              )}
            </div>
            {currentSprint && !sprintCollapsed && (
              <div className="max-h-[45vh] overflow-y-auto">
                {/* Progress bar */}
                <div className="px-4 py-1.5">
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all"
                      style={{ width: sprintTasks.length > 0 ? `${(completedCount / sprintTasks.length) * 100}%` : '0%' }}
                    />
                  </div>
                </div>
                {sprintTasks.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">{t('backlog.sprintEmpty')}</div>
                ) : (
                  sprintTasks.map(task => (
                    <DraggableTaskRow key={task.id} task={task}>
                      <TaskRow
                        task={task}
                        statuses={statuses}
                        userMap={userMap}
                        selected={selectedIds.has(task.id)}
                        onToggleSelect={toggleSelect}
                        onClickTask={setSelectedTask}
                        actionButton={
                          <button
                            onClick={() => moveToBacklog([task.id])}
                            className="text-[11px] px-2 py-0.5 rounded bg-muted text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground transition-colors"
                          >
                            {t('backlog.moveToBacklog')}
                          </button>
                        }
                      />
                    </DraggableTaskRow>
                  ))
                )}
              </div>
            )}
          </div>
        </DroppableZone>

        {/* ── Backlog Section ── */}
        <DroppableZone id="backlog-zone">
          <div className="bg-card rounded-xl border border-border/80 shadow-sm overflow-hidden">
            <div
              className="flex items-center gap-2.5 px-3 md:px-4 py-2.5 md:py-3 cursor-pointer hover:bg-accent/30 transition-colors border-l-4 border-l-muted-foreground/40"
              onClick={() => setBacklogCollapsed(prev => !prev)}
            >
              <span className="text-muted-foreground">
                {backlogCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
              </span>
              <span className="text-sm font-bold text-foreground">{t('backlog.backlogTitle')}</span>
              <span className="text-[13px] text-muted-foreground ml-auto">({backlogTasks.length})</span>
            </div>
            {!backlogCollapsed && (
              <div className="max-h-[45vh] overflow-y-auto">
                {backlogTasks.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">{t('backlog.backlogEmpty')}</div>
                ) : (
                  backlogTasks.map(task => (
                    <DraggableTaskRow key={task.id} task={task}>
                      <TaskRow
                        task={task}
                        statuses={statuses}
                        userMap={userMap}
                        selected={selectedIds.has(task.id)}
                        onToggleSelect={toggleSelect}
                        onClickTask={setSelectedTask}
                        actionButton={
                          currentSprint ? (
                            <button
                              onClick={() => moveToSprint([task.id])}
                              className="text-[11px] px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                            >
                              {t('backlog.moveToSprint')}
                            </button>
                          ) : undefined
                        }
                      />
                    </DraggableTaskRow>
                  ))
                )}
              </div>
            )}
          </div>
        </DroppableZone>
      </div>

      {/* Modals */}
      {sprintFlow.showCompleteModal && (
        <SprintCompleteModal
          currentSprint={currentSprint}
          completedCount={sprintCompletedCount}
          pendingTasks={sprintPendingTasks}
          onClose={sprintFlow.closeComplete}
          onComplete={action => void sprintFlow.complete(action)}
        />
      )}
      {sprintFlow.showStartModal && (
        <SprintStartModal
          defaultName={getDefaultSprintName()}
          carryOverCount={sprintFlow.carryOverTaskIds.length}
          backlogCount={sprintBacklogTaskIds(allTasks, statuses).length}
          onClose={sprintFlow.cancelStart}
          onConfirm={(name, includeBacklog) => void sprintFlow.confirmStart(name, includeBacklog)}
        />
      )}

      {/* DragOverlay */}
      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <div className="opacity-80 bg-card rounded-lg border border-primary shadow-lg px-3 py-2 text-sm max-w-[240px] truncate">
            {activeTask.title}
          </div>
        ) : null}
      </DragOverlay>
    </div>
    </DndContext>
  );
};

export default BacklogView;
