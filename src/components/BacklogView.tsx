import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIContext } from '@/context/UIContext';
import { useTaskContext } from '@/context/TaskContext';
import { useMemberContext } from '@/context/MemberContext';
import { useSprintContext } from '@/context/SprintContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useAuthContext } from '@/context/AuthContext';
import { logActivity } from '@/lib/activityLog';
import { toast } from 'sonner';
import { SprintCompleteModal, SprintStartModal } from '@/components/board/SprintModals';
import type { PendingTaskAction } from '@/context/SprintContext';
import { priorityConfig } from '@/components/ui/badges';
import { ChevronDown, ChevronRight, Zap, ArrowUp, ArrowDown, Lightbulb } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DndContext, DragOverlay, useDroppable, useDraggable,
  PointerSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, KeyboardCode,
  type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core';
import type { Task } from '@/types';
import DepartmentFilter from '@/components/DepartmentFilter';
import MultiSelectDropdown from '@/components/MultiSelectDropdown';
import { sortUsersByDept, type Department } from '@/lib/department';

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
    <div ref={setNodeRef} {...listeners} {...attributes} className={isDragging ? 'opacity-30' : ''}>
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
      className="flex items-center gap-2 px-3 py-2 border-b border-border/40 hover:bg-accent/50 transition-colors cursor-pointer group"
      onClick={() => onClickTask(task)}
    >
      <div onClick={e => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(task.id)}
          className="h-3.5 w-3.5"
        />
      </div>
      <span className="text-xs text-muted-foreground font-mono w-16 flex-shrink-0 truncate">{task.taskKey}</span>
      <span className="text-sm text-foreground flex-1 truncate">{task.title}</span>
      {status && (
        <span
          className="text-[10px] px-2 py-0.5 rounded-full font-medium text-white flex-shrink-0"
          style={{ backgroundColor: status.color }}
        >
          {status.name}
        </span>
      )}
      {pConfig && (
        <span className="flex-shrink-0 text-sm" title={pConfig.label}>{pConfig.icon}</span>
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
      {actionButton && <div onClick={e => e.stopPropagation()} className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">{actionButton}</div>}
    </div>
  );
}

/* ── BacklogView ── */
const BacklogView = () => {
  const { t } = useTranslation();
  const { setSelectedTask } = useUIContext();
  const { allTasks, setAllTasks, statuses, updateTaskInDb } = useTaskContext();
  const { users } = useMemberContext();
  const { currentMemberId, currentMember } = useAuthContext();
  const { sprintActive, currentSprint, completeSprint, startSprint, getDefaultSprintName, sprints, refreshSprints } = useSprintContext();
  const { selectedProjectId, allProjects } = useProjectContext();
  const isMobile = useIsMobile();

  const [sprintCollapsed, setSprintCollapsed] = useState(false);
  const [backlogCollapsed, setBacklogCollapsed] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [showStartModal, setShowStartModal] = useState(false);
  const [carryOverTaskIds, setCarryOverTaskIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Filters
  const [filterDept, setFilterDept] = useState<Department[]>([]);
  const [filterAssignees, setFilterAssignees] = useState<string[]>([]);
  const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
  const [filterPriorities, setFilterPriorities] = useState<string[]>([]);
  const [filterReviewers, setFilterReviewers] = useState<string[]>([]);
  const [filterProjects, setFilterProjects] = useState<string[]>([]);

  const hasFilters = filterDept.length > 0 || filterAssignees.length > 0 || filterStatuses.length > 0 || filterPriorities.length > 0 || filterReviewers.length > 0 || filterProjects.length > 0;
  const clearFilters = useCallback(() => { setFilterDept([]); setFilterAssignees([]); setFilterStatuses([]); setFilterPriorities([]); setFilterReviewers([]); setFilterProjects([]); }, []);
  const toggleArr = useCallback((setter: React.Dispatch<React.SetStateAction<string[]>>) => (id: string) =>
    setter(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]), []);

  const priorityOptions = useMemo(() => Object.entries(priorityConfig).map(([id, p]) => ({
    id, label: p.label, icon: p.icon as React.ReactElement,
  })), []);

  const userMap = useMemo(() => new Map(users.map(u => [u.id, u])), [users]);

  const doneIds = useMemo(() => statuses.filter(s => s.isDone).map(s => s.id), [statuses]);

  const applyFilters = useCallback((tasks: Task[]) => {
    let result = tasks;
    if (filterDept.length > 0) {
      const deptUserIds = new Set(users.filter(u => filterDept.includes(u.department as Department)).map(u => u.id));
      result = result.filter(t => t.assigneeId && deptUserIds.has(t.assigneeId));
    }
    if (filterAssignees.length > 0) result = result.filter(t => t.assigneeId && filterAssignees.includes(t.assigneeId));
    if (filterStatuses.length > 0) result = result.filter(t => filterStatuses.includes(t.statusId));
    if (filterPriorities.length > 0) result = result.filter(t => filterPriorities.includes(t.priority));
    if (filterReviewers.length > 0) result = result.filter(t => t.reviewerId && filterReviewers.includes(t.reviewerId));
    if (filterProjects.length > 0) result = result.filter(t => filterProjects.includes(t.projectId));
    return result;
  }, [filterDept, filterAssignees, filterStatuses, filterPriorities, filterReviewers, filterProjects, users]);

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

  const pendingTasks = useMemo(() =>
    sprintTasks.filter(t => !doneIds.includes(t.statusId)),
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
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: [KeyboardCode.Space], cancel: [KeyboardCode.Escape], end: [KeyboardCode.Space] },
    }),
  );

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
  const handleCompleteSprint = async (action: PendingTaskAction) => {
    setShowCompleteModal(false);
    try {
      const sprintName = currentSprint?.name || '';
      const pendingIds = await completeSprint(action);
      if (currentMemberId) {
        await logActivity(currentMemberId, 'complete_sprint', `${t('activityLog.completeSprint')}「${sprintName}」`, undefined, undefined, 'sprint');
      }
      setCarryOverTaskIds(pendingIds || []);
    } catch (err) {
      console.error('[LIVO] BacklogView completeSprint:', err);
      toast.error(t('error.updateFailed'));
    }
  };

  const handleConfirmStart = async (name: string, includeBacklog: boolean) => {
    setShowStartModal(false);
    try {
      await startSprint(name, carryOverTaskIds.length > 0 ? carryOverTaskIds : undefined, includeBacklog);
      setCarryOverTaskIds([]);
      if (currentMemberId) {
        await logActivity(currentMemberId, 'start_sprint', `${t('activityLog.startSprint')}「${name}」`, undefined, undefined, 'sprint');
      }
    } catch (err) {
      console.error('[LIVO] BacklogView startSprint:', err);
      toast.error(t('error.updateFailed'));
    }
  };

  const handleStartNewSprint = () => {
    setCarryOverTaskIds([]);
    setShowStartModal(true);
  };

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
    <div className="flex-1 overflow-auto bg-board">
      {/* Header */}
      <div className="px-3 md:px-5 pt-3 md:pt-4 pb-2">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-base md:text-lg font-bold text-foreground">{t('backlog.title')}</h1>
          <div className="flex items-center gap-2">
            {sprintActive && currentSprint ? (
              <button
                onClick={() => setShowCompleteModal(true)}
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
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mr-1 hidden md:inline">{t('filter.label')}</span>
        <DepartmentFilter value={filterDept} onChange={setFilterDept} />
        <MultiSelectDropdown label={isMobile ? t('filter.assigneeMobile') : t('filter.assignee')} options={sortUsersByDept(users.filter(u => u.isActive)).map(u => ({ id: u.id, label: u.name, avatar: u.avatar, avatarColor: u.color, subtitle: u.jobTitle }))} selected={filterAssignees} onToggle={toggleArr(setFilterAssignees)} />
        <MultiSelectDropdown label={t('filter.status')} options={statuses.map(s => ({ id: s.id, label: s.name, color: s.color }))} selected={filterStatuses} onToggle={toggleArr(setFilterStatuses)} />
        <MultiSelectDropdown label={isMobile ? t('filter.priorityMobile') : t('filter.priority')} options={priorityOptions} selected={filterPriorities} onToggle={toggleArr(setFilterPriorities)} />
        {!isMobile && <MultiSelectDropdown label={t('filter.reviewer')} options={sortUsersByDept(users.filter(u => u.isActive)).map(u => ({ id: u.id, label: u.name, avatar: u.avatar, avatarColor: u.color, subtitle: u.jobTitle }))} selected={filterReviewers} onToggle={toggleArr(setFilterReviewers)} />}
        {!selectedProjectId && <MultiSelectDropdown label={t('filter.project')} options={allProjects.filter(p => !p.isArchived).map(p => ({ id: p.id, label: p.name, color: p.color }))} selected={filterProjects} onToggle={toggleArr(setFilterProjects)} />}
        {hasFilters && (
          <button onClick={clearFilters} className="text-[13px] text-primary hover:text-primary/80 font-medium">{t('button.clearFilters')}</button>
        )}
      </div>

      {/* Batch action bar */}
      {selectedIds.size > 0 && (
        <div className="mx-3 md:mx-5 mb-2 flex items-center gap-2 px-3 py-2 bg-muted rounded-lg border border-border">
          <span className="text-xs font-medium text-foreground">{t('backlog.selected', { count: selectedIds.size })}</span>
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
              <span className="text-sm font-bold text-foreground">
                {currentSprint ? `${t('backlog.currentSprint')}: ${currentSprint.name}` : t('backlog.noActiveSprint')}
              </span>
              {currentSprint && (
                <>
                  <span className="text-[13px] text-muted-foreground ml-auto">
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
      {showCompleteModal && (
        <SprintCompleteModal
          currentSprint={currentSprint}
          completedCount={completedCount}
          pendingTasks={sprintTasks.filter(t => !doneIds.includes(t.statusId))}
          onClose={() => setShowCompleteModal(false)}
          onComplete={handleCompleteSprint}
        />
      )}
      {showStartModal && (
        <SprintStartModal
          defaultName={getDefaultSprintName()}
          carryOverCount={carryOverTaskIds.length}
          onClose={() => setShowStartModal(false)}
          onConfirm={handleConfirmStart}
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