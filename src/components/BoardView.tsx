import { useProjectColor } from '@/hooks/useProjectColor';
import { sprintBacklogTaskIds } from '@/lib/sprintBacklog';
import { useState, useRef, useMemo, useCallback, useEffect, type ReactNode } from 'react';
import { useAppContext } from '@/context/AppContext';
import { useUIContext } from '@/context/UIContext';
import { announceStatusChange } from '@/lib/taskAnnouncements';
import { logActivity } from '@/lib/activityLog';
import TaskCard from '@/components/TaskCard';
import StandupLaunchDialog from '@/components/StandupLaunchDialog';
import UpgradePrompt from '@/components/UpgradePrompt';
import BoardFilters from '@/components/board/BoardFilters';
import { useBoardFilters } from '@/hooks/useBoardFilters';
import { useProjectScope, useScopedProjectFilter } from '@/hooks/useProjectScope';
import { readBoardSort, sortBoardTasks, writeBoardSort, type BoardSort } from '@/lib/boardSort';
import { SprintCompleteModal, SprintStartModal } from '@/components/board/SprintModals';
import BoardSprintHeader from '@/components/board/BoardSprintHeader';
import BoardApprovalModal from '@/components/board/BoardApprovalModal';
import { type CardFieldVisibility } from '@/lib/fieldRegistry';
import { readBoardDisplay, writeBoardDisplay } from '@/lib/boardDisplay';
import { useLicense } from '@/context/LicenseContext';
import { useSprintFlow } from '@/hooks/useSprintFlow';
import { BookOpen, ChevronDown, ChevronRight, ClipboardList, GripVertical, Search, Plus } from 'lucide-react';
import { taskDepartment, type Department } from '@/lib/department';
import { useUndoStack } from '@/hooks/useUndoStack';
import { useIsMobile } from '@/hooks/use-mobile';
import { useBoardSensors } from '@/hooks/useBoardSensors';
import { useStatusChangeGate } from '@/hooks/useStatusChangeGate';
import { statusChangeUpdates } from '@/lib/taskStatusChange';
import { useNotificationToast } from '@/components/notifications/NotificationToastProvider';
import { useApprovalRules } from '@/hooks/useApprovalRules';
import { useApprovalWorkflow } from '@/hooks/useApprovalWorkflow';
import { useBoardApproval } from '@/components/board/useBoardApproval';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  DndContext, DragOverlay, closestCenter, pointerWithin, useDroppable, useDraggable,
  type CollisionDetection, type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core';
import type { Task } from '@/types';

/* ── dnd-kit helper components (defined outside BoardView to keep stable references) ── */
const boardCollision: CollisionDetection = args => args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);

function DroppableColumn({ id, children }: { id: string; children: ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`snap-start w-[min(82vw,300px)] min-w-0 shrink-0 md:w-auto md:min-w-[140px] md:flex-1 rounded-xl border flex flex-col max-h-[max(240px,calc(100dvh-240px))] transition-colors ${
        isOver ? 'bg-primary/5 border-primary/40 ring-1 ring-primary/20' : 'bg-card/50 border-border/60'
      }`}
    >
      {children}
    </div>
  );
}

function DraggableCard({ task, fields, subtaskMode, customCardFields }: { task: Task; fields?: CardFieldVisibility; subtaskMode?: 'independent' | 'nested'; customCardFields?: Record<string, boolean> }) {
  const { setSelectedTask } = useUIContext();
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dndOnKeyDown = (listeners as any)?.onKeyDown;

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-drag-surface
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') { e.preventDefault(); setSelectedTask(task); return; }
        dndOnKeyDown?.(e);
      }}
      aria-label={t('task.ariaLabel', { title: task.title })}
      className={isDragging ? 'opacity-30' : ''}
      style={{ touchAction: 'pan-x pan-y', WebkitTouchCallout: 'none' }}
    >
      <TaskCard task={task} fields={fields} subtaskMode={subtaskMode} customCardFields={customCardFields} interactive={false}
        dragHandle={(
          <button
            {...attributes}
            {...listeners}
            type="button"
            data-drag-surface
            aria-label={t('board.dragCard', { title: task.title })}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground cursor-grab active:cursor-grabbing md:hidden [@media(any-pointer:coarse)]:inline-flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ touchAction: 'none', WebkitTouchCallout: 'none' }}
            onClick={event => { event.preventDefault(); event.stopPropagation(); }}
          >
            <GripVertical size={18} aria-hidden="true" />
          </button>
        )}
      />
    </div>
  );
}

/* ── BoardView ── */

const BoardView = () => {
  const getProjectColor = useProjectColor();
  const { t } = useTranslation();
  const { approvalsEnabled, featureTogglesReady, allTasks, setAllTasks, selectedProjectId, selectedLineId, standupMode, setStandupMode, standupUserId, allProjects, statuses, productLines, updateTaskInDb, sprintActive, currentSprint, users, currentMemberId, currentMember, renameSprint, getDefaultSprintName, setSelectedProjectId, setSelectedLineId, setCurrentView, setSelectedTask, customFields, setShowCreateTask } = useAppContext();
  const isMobile = useIsMobile();
  const { hasFeature } = useLicense();
  const statusGate = useStatusChangeGate();
  const { triggerNotification } = useNotificationToast();
  const announcements = useMemo(() => ({ actor: currentMember, users, projects: allProjects, statuses, showRules: triggerNotification }), [currentMember, users, allProjects, statuses, triggerNotification]);
  const announceDirect = useCallback((task: Task, from: string, to: string) => announceStatusChange(task, from, to, announcements), [announcements]);
  const { getRuleForTransition } = useApprovalRules();
  const { requestApproval } = useApprovalWorkflow();
  const undoStack = useUndoStack();
  const { approvalConfirm, setApprovalConfirm, handleApprovalDirectChange, handleApprovalSubmit, handleMandatoryApproval } = useBoardApproval({ allTasks, statuses, setAllTasks, updateTaskInDb, getRuleForTransition, requestApproval, t, announce: announceDirect });
  const userMap = useMemo(() => new Map(users.map(u => [u.id, u])), [users]);
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  const boardFilters = useBoardFilters();
  const scope = useProjectScope();
  useScopedProjectFilter(boardFilters.setFilterProjects);
  const { filterDept, filterAssignees, filterStatuses, filterPriorities, filterReviewers, filterProjects, hasFilters, clearFilters } = boardFilters;
  const [sort, setSortState] = useState<BoardSort>(() => readBoardSort('tasks'));
  const setSort = useCallback((next: BoardSort) => { setSortState(next); writeBoardSort('tasks', next); }, []);
  const [editingSprintName, setEditingSprintName] = useState(false);
  const [editSprintValue, setEditSprintValue] = useState('');
  const [showStandupLaunch, setShowStandupLaunch] = useState(false);
  const [showStandupUpgrade, setShowStandupUpgrade] = useState(false);
  // Completing and starting a sprint, shared with the backlog and the stand-up.
  const sprintFlow = useSprintFlow();
  const [activeId, setActiveId] = useState<string | null>(null);
  // Card fields and the subtask layout are remembered in this browser, like the sort.
  const [initialDisplay] = useState(readBoardDisplay);
  const [cardFields, setCardFields] = useState<CardFieldVisibility>(initialDisplay.cardFields);
  const [subtaskDisplayMode, setSubtaskDisplayMode] = useState<'independent' | 'nested'>(initialDisplay.subtaskMode);
  const [customCardFields, setCustomCardFields] = useState<Record<string, boolean>>(initialDisplay.customCardFields);
  useEffect(() => { writeBoardDisplay({ cardFields, subtaskMode: subtaskDisplayMode, customCardFields }); }, [cardFields, subtaskDisplayMode, customCardFields]);
  const sprintInputRef = useRef<HTMLInputElement>(null);

  const toggleCardField = useCallback((field: keyof CardFieldVisibility) => {
    setCardFields(prev => ({ ...prev, [field]: !prev[field] }));
  }, []);
  const toggleCustomCardField = useCallback((fieldId: string) => {
    setCustomCardFields(prev => ({ ...prev, [fieldId]: !prev[fieldId] }));
  }, []);

  const toggleArr = useCallback((setter: React.Dispatch<React.SetStateAction<string[]>>) => (id: string) =>
    setter(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]), []);

  const toggleProject = (projectId: string) => {
    setCollapsedProjects(prev =>
      prev.includes(projectId) ? prev.filter(id => id !== projectId) : [...prev, projectId]
    );
  };

  // Every filter except the sprint scope. While a sprint runs, the board shows
  // its tasks plus unscheduled ones; tasks of other (usually finished) sprints
  // stay countable here so the board can say where they went (the sidebar
  // counts and the 列表 view include them).
  const unscopedTasks = useMemo(() => {
    let tasks = allTasks;
    if (selectedProjectId) {
      tasks = tasks.filter(t => t.projectId === selectedProjectId);
    } else if (selectedLineId) {
      const lineProjectIdSet = new Set(allProjects.filter(p => p.lineId === selectedLineId).map(p => p.id));
      tasks = tasks.filter(t => lineProjectIdSet.has(t.projectId));
    }
    if (standupMode && standupUserId) {
      tasks = tasks.filter(t => t.assigneeId === standupUserId);
    }
    if (filterDept.length > 0) {
      const deptSet = new Set(filterDept);
      tasks = tasks.filter(t => deptSet.has(taskDepartment(t, userMap) as Department));
    }
    if (filterAssignees.length > 0) { const s = new Set(filterAssignees); tasks = tasks.filter(t => t.assigneeId && s.has(t.assigneeId)); }
    if (filterStatuses.length > 0) { const s = new Set(filterStatuses); tasks = tasks.filter(t => s.has(t.statusId)); }
    if (filterPriorities.length > 0) { const s = new Set(filterPriorities); tasks = tasks.filter(t => s.has(t.priority)); }
    if (filterReviewers.length > 0) { const s = new Set(filterReviewers); tasks = tasks.filter(t => t.reviewerId && s.has(t.reviewerId)); }
    if (filterProjects.length > 0) { const s = new Set(filterProjects); tasks = tasks.filter(t => s.has(t.projectId)); }
    return tasks;
  }, [allTasks, selectedProjectId, selectedLineId, standupMode, standupUserId, filterDept, users, filterAssignees, filterStatuses, filterPriorities, filterReviewers, filterProjects, allProjects]);

  const scopeSprintId = sprintActive && currentSprint ? currentSprint.id : null;
  const filteredTasks = useMemo(() => scopeSprintId
    ? unscopedTasks.filter(t => t.sprintId === scopeSprintId || !t.sprintId)
    : unscopedTasks,
  [unscopedTasks, scopeSprintId]);
  const sortedTasks = useMemo(() => sortBoardTasks(filteredTasks, sort), [filteredTasks, sort]);
  // In nested mode a subtask is shown inside its parent's card; it keeps a card of its own only when its parent is not on the board.
  const nestSubtasks = subtaskDisplayMode === 'nested' && hasFeature('subtasks');
  const boardTasks = useMemo(() => {
    if (!nestSubtasks) return sortedTasks;
    const shown = new Set(sortedTasks.map(task => task.id));
    return sortedTasks.filter(task => !task.parentTaskId || !shown.has(task.parentTaskId));
  }, [sortedTasks, nestSubtasks]);

  /** Tasks the filters match that sit in another sprint, per project. */
  const otherSprintCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (!scopeSprintId) return counts;
    for (const t of unscopedTasks) {
      if (t.sprintId && t.sprintId !== scopeSprintId) counts.set(t.projectId, (counts.get(t.projectId) || 0) + 1);
    }
    return counts;
  }, [unscopedTasks, scopeSprintId]);
  const otherSprintTotal = unscopedTasks.length - filteredTasks.length;

  const visibleProjects = useMemo(() =>
    selectedProjectId
      ? allProjects.filter(p => p.id === selectedProjectId)
      : allProjects.filter(p => filteredTasks.some(t => t.projectId === p.id)),
    [selectedProjectId, allProjects, filteredTasks]
  );

  const totalFiltered = filteredTasks.length;

  const handleDrop = useCallback(async (taskId: string, newStatusId: string) => {
    if (!featureTogglesReady) { toast.error(t('featureToggles.loadFailed')); return; }
    try {
      const task = allTasks.find(t => t.id === taskId);
      if (!task || task.statusId === newStatusId) return;

      const gate = statusGate.check(task, newStatusId);
      const refusal = statusGate.refusal(gate, newStatusId);
      if (refusal) { toast.error(refusal); return; }

      // When requiresApproval is true, ALL status changes go through approval
      const project = allProjects.find(p => p.id === task.projectId);
      if (gate.kind === 'approval') {
        const toStatusName = statuses.find(s => s.id === newStatusId)?.name || '—';
        const confirmPayload = { taskId, fromStatusId: task.statusId, toStatusId: newStatusId, projectId: project?.id || '', toStatusName };
        setApprovalConfirm(confirmPayload);
        return;
      }

      // Advisory: if a matching approval rule exists but task doesn't require approval, warn
      if (approvalsEnabled && !task.requiresApproval && project) {
        try {
          const ruleInfo = await getRuleForTransition(project.id, task.statusId, newStatusId);
          if (ruleInfo) {
            const toStatusName = statuses.find(s => s.id === newStatusId)?.name || '—';
            const confirmPayload = { taskId, fromStatusId: task.statusId, toStatusId: newStatusId, projectId: project.id, toStatusName, advisory: true };
            setApprovalConfirm(confirmPayload);
            return;
          }
        } catch (err) {
          console.error('[LIVO] advisory approval check error:', err);
        }
      }

      const status = statuses.find(s => s.id === newStatusId);
      const oldStatus = statuses.find(s => s.id === task.statusId);
      const updates = statusChangeUpdates(task, statuses, newStatusId);
      const oldStatusId = task.statusId;
      setAllTasks(prev => prev.map(t2 => t2.id !== taskId ? t2 : { ...t2, ...updates }));
      // A refused or failed save is reported and reloaded by updateTaskInDb; nothing to undo or announce.
      if ((await updateTaskInDb(taskId, updates)) === false) return;

      undoStack.push({
        type: 'status_change',
        description: t('undo.statusChanged', { key: task.taskKey, from: oldStatus?.name || '—', to: status?.name || '—' }),
        undo: async () => {
          const revert: Record<string, unknown> = { statusId: oldStatusId };
          if (updates.startedAt && !task.startedAt) revert.startedAt = undefined;
          if ('completedAt' in updates) revert.completedAt = task.completedAt ?? undefined;
          setAllTasks(prev => prev.map(t2 => t2.id !== taskId ? t2 : { ...t2, statusId: oldStatusId }));
          await updateTaskInDb(taskId, revert as Record<string, string | undefined>);
        },
      });

      announceStatusChange(task, oldStatusId, newStatusId, announcements);
    } catch (err) {
      console.error('[LIVO] handleDrop error:', err);
      toast.error(t('error.updateFailed') + String(err));
    }
  }, [approvalsEnabled, featureTogglesReady, getRuleForTransition, setApprovalConfirm, t, allTasks, statuses, setAllTasks, updateTaskInDb, allProjects, statusGate, announcements]);

  /* ── dnd-kit sensors & handlers ── */
  const sensors = useBoardSensors();
  const activeTask = activeId ? allTasks.find(t => t.id === activeId) ?? null : null;
  const handleDragStart = useCallback((event: DragStartEvent) => { setActiveId(event.active.id as string); }, []);
  const handleDndDragEnd = useCallback((event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const taskId = active.id as string;
    const [projectId, statusId] = (over.id as string).split('::');
    // Columns belong to a project row; a card changes project in its details, not by drag.
    const task = allTasks.find(row => row.id === taskId);
    if (task && projectId && task.projectId !== projectId) { toast.info(t('board.dropOtherProject')); return; }
    if (statusId) handleDrop(taskId, statusId).catch(err => console.error('[LIVO] handleDrop unhandled:', err));
  }, [allTasks, handleDrop, t]);
  const handleDragCancel = useCallback(() => { setActiveId(null); }, []);


  const visibleProjectIds = useMemo(() => visibleProjects.map(p => p.id), [visibleProjects]);

  const canEditSprint = currentMember && (currentMember.role === 'admin' || currentMember.role === 'super_admin');

  const handleStartEditSprintName = () => {
    if (currentSprint && canEditSprint) {
      setEditSprintValue(currentSprint.name);
      setEditingSprintName(true);
      setTimeout(() => sprintInputRef.current?.focus(), 50);
    }
  };

  const handleSaveSprintName = async () => {
    if (!currentSprint || !editSprintValue.trim()) return;
    if (editSprintValue.trim() !== currentSprint.name) {
      await renameSprint(currentSprint.id, editSprintValue.trim());
    }
    setEditingSprintName(false);
  };

  const handleSprintAction = sprintFlow.openComplete;

  const doneIds = useMemo(() => statuses.filter(s => s.isDone).map(s => s.id), [statuses]);
  const sprintTasks = useMemo(() => currentSprint ? allTasks.filter(t => t.sprintId === currentSprint.id) : [], [allTasks, currentSprint]);
  const completedCount = useMemo(() => sprintTasks.filter(t => doneIds.includes(t.statusId)).length, [sprintTasks, doneIds]);
  const pendingTasks = useMemo(() => sprintTasks.filter(t => !doneIds.includes(t.statusId)), [sprintTasks, doneIds]);

  const handleStartNewSprint = sprintFlow.openStart;

  const handleStandup = () => {
    if (standupMode) {
      if (sprintActive) {
        window.dispatchEvent(new CustomEvent('standup-exit'));
      } else {
        setStandupMode(false);
      }
    } else if (!hasFeature('standup')) {
      setShowStandupUpgrade(true);
    } else {
      setShowStandupLaunch(true);
    }
  };

  const handleStandupConfirm = () => {
    setShowStandupLaunch(false);
    setSelectedProjectId(null);
    setSelectedLineId(null);
    setCurrentView('board');
    setStandupMode(true);
    if (currentMemberId) {
      logActivity(currentMemberId, 'start_standup', t('activityLog.startStandup'), undefined, undefined, 'system');
    }
  };

  return (
    <DndContext sensors={sensors} collisionDetection={boardCollision} onDragStart={handleDragStart} onDragEnd={handleDndDragEnd} onDragCancel={handleDragCancel}>
    <div className="min-w-0 flex-1 overflow-y-auto bg-board">
      {/* Header */}
      <BoardSprintHeader
        selectedProjectId={selectedProjectId}
        allProjects={allProjects}
        totalFiltered={totalFiltered}
        sprintActive={sprintActive}
        currentSprint={currentSprint}
        isMobile={isMobile}
        standupMode={standupMode}
        canEditSprint={!!canEditSprint}
        editingSprintName={editingSprintName}
        editSprintValue={editSprintValue}
        sprintInputRef={sprintInputRef as React.RefObject<HTMLInputElement>}
        onEditSprintValue={setEditSprintValue}
        onStartEditSprintName={handleStartEditSprintName}
        onSaveSprintName={handleSaveSprintName}
        onCancelEditSprintName={() => setEditingSprintName(false)}
        onSprintAction={handleSprintAction}
        onStartNewSprint={handleStartNewSprint}
        onStandup={handleStandup}
        t={t}
      />

      {/* Filters */}
      <BoardFilters
        users={users}
        statuses={statuses}
        allProjects={scope.projectIds ? allProjects.filter(project => scope.projectIds!.has(project.id)) : allProjects}
        selectedProjectId={selectedProjectId}
        filters={boardFilters} sort={sort} onSortChange={setSort}
        cardFields={cardFields} toggleCardField={toggleCardField}
        subtaskDisplayMode={subtaskDisplayMode} setSubtaskDisplayMode={setSubtaskDisplayMode}
        hasSubtasksFeature={hasFeature('subtasks')}
        customFields={customFields}
        customCardFields={customCardFields} toggleCustomCardField={toggleCustomCardField}
        visibleProjectIds={visibleProjectIds}
      />
      {filteredTasks.length > 0 && <p className="px-3 pb-2 text-xs leading-relaxed text-muted-foreground md:hidden">{t('board.touchHint')}</p>}

      {/* Empty state */}
      {filteredTasks.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center py-20 px-4 text-center">
          {otherSprintTotal > 0 ? (
            <>
              <ClipboardList size={48} className="mb-3 text-muted-foreground/40" />
              <p className="text-sm font-semibold text-foreground mb-1">{t('board.noTasksInSprint')}</p>
              <p className="text-xs text-muted-foreground mb-3 max-w-md">{t('board.tasksInOtherSprints', { count: otherSprintTotal })}</p>
              <button onClick={() => setCurrentView('all-list')} className="text-sm text-primary hover:text-primary/80 font-medium transition-colors">
                {t('board.viewAllInList')}
              </button>
            </>
          ) : hasFilters ? (
            <>
              <Search size={48} className="mb-3 text-muted-foreground/40" />
              <p className="text-sm font-semibold text-foreground mb-1">{t('board.noFilterResults')}</p>
              <p className="text-xs text-muted-foreground mb-3">{t('board.adjustFilters')}</p>
              <button onClick={clearFilters} className="text-sm text-primary hover:text-primary/80 font-medium transition-colors">
                {t('button.clearAllFilters')}
              </button>
            </>
          ) : (
            <>
              <ClipboardList size={48} className="mb-3 text-muted-foreground/40" />
              <p className="text-sm font-semibold text-foreground mb-1">{t('board.noTasks')}</p>
              <p className="text-xs text-muted-foreground mb-4">{t('board.noTasksDesc')}</p>
              <button
                onClick={() => setShowCreateTask(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
              >
                <Plus size={16} />
                {t('common.create')}
              </button>
            </>
          )}
        </div>
      )}

      {/* Project Rows */}
      <div className="px-3 md:px-5 pb-4 space-y-4 md:space-y-5">
        {visibleProjects.map(project => {
          const line = productLines.find(l => l.id === project.lineId);
          const projectTasks = boardTasks.filter(t => t.projectId === project.id);
          const isCollapsed = collapsedProjects.includes(project.id);
          // Pre-group tasks by statusId to avoid O(n²) filtering
          const tasksByStatus = new Map<string, Task[]>();
          for (const t of projectTasks) {
            const arr = tasksByStatus.get(t.statusId);
            if (arr) arr.push(t); else tasksByStatus.set(t.statusId, [t]);
          }

          return (
            <div key={project.id} className="bg-card rounded-xl border border-border/80 shadow-sm overflow-x-clip overflow-y-hidden">
              <div
                className="flex items-center gap-2.5 px-3 md:px-4 py-2.5 md:py-3 cursor-pointer hover:bg-accent/30 transition-colors"
                onClick={() => toggleProject(project.id)}
                style={{ borderLeft: `4px solid ${getProjectColor(project)}` }}
              >
                <span className="text-muted-foreground">
                  {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </span>
                {line && (
                  // On a phone the project name needs the room; the line is shown by the colour bar.
                  <span className="hidden sm:inline text-sm md:text-[15px] px-2 py-0.5 rounded-md font-bold text-white" style={{ backgroundColor: line.color }}>
                    {line.icon} {line.name}
                  </span>
                )}
                <span className="min-w-0 text-sm md:text-[15px] font-bold text-foreground truncate">{project.name}</span>
                <button
                  type="button"
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border/70 bg-muted/40 px-2 text-xs font-medium leading-none text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  aria-label={t('kb.title')} title={t('kb.title')}
                  onClick={event => {
                    event.stopPropagation(); setSelectedProjectId(project.id); setSelectedLineId(null); setCurrentView('knowledge-base');
                  }}
                >
                  <BookOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span className="hidden sm:inline">{t('kb.title')}</span>
                </button>
                {(otherSprintCounts.get(project.id) || 0) > 0 && (
                  <span className="ml-auto flex-shrink-0 text-[12px] text-muted-foreground/70" title={t('board.tasksInOtherSprints', { count: otherSprintCounts.get(project.id) })}>
                    <span className="sm:hidden">+{otherSprintCounts.get(project.id)}</span>
                    <span className="hidden sm:inline">{t('board.otherSprintsShort', { count: otherSprintCounts.get(project.id) })}</span>
                  </span>
                )}
                <span className={`text-[13px] text-muted-foreground font-medium flex-shrink-0 ${(otherSprintCounts.get(project.id) || 0) > 0 ? '' : 'ml-auto'}`}>({projectTasks.length})</span>
              </div>

              {!isCollapsed && (
                <div className={`px-2 md:px-3 pb-3 pt-1.5 overflow-x-auto overscroll-x-contain board-columns ${activeId ? 'snap-none' : 'snap-x snap-proximity md:snap-none'}`} style={{ touchAction: 'pan-x pan-y', WebkitOverflowScrolling: 'touch' }}>
                  <div className="flex gap-3 md:gap-4 min-w-max md:min-w-0">
                    {statuses.map(status => {
                      const statusTasks = tasksByStatus.get(status.id) || [];
                      return (
                        <DroppableColumn key={`${project.id}::${status.id}`} id={`${project.id}::${status.id}`}>
                          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/40">
                            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: status.color }} />
                            <span className="text-sm font-semibold text-foreground truncate">{status.name}</span>
                            <span className="text-xs text-muted-foreground ml-auto">{statusTasks.length}</span>
                          </div>
                          <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-2 space-y-2">
                            {statusTasks.map(task => (
                              <DraggableCard key={task.id} task={task} fields={cardFields} subtaskMode={subtaskDisplayMode} customCardFields={customCardFields} />
                            ))}
                          </div>
                        </DroppableColumn>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Standup launch dialog */}
      <StandupLaunchDialog
        open={showStandupLaunch}
        onOpenChange={setShowStandupLaunch}
        onConfirm={handleStandupConfirm}
      />

      {/* Standup locked → upgrade prompt (standard-tier feature) */}
      {showStandupUpgrade && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowStandupUpgrade(false)}
        >
          <div
            className="bg-card rounded-xl shadow-xl border border-border w-full max-w-md max-h-[90vh] overflow-auto"
            onClick={e => e.stopPropagation()}
          >
            <UpgradePrompt feature="standup" />
          </div>
        </div>
      )}

      {/* Complete Sprint modal with pending task options */}
      {sprintFlow.showCompleteModal && (
        <SprintCompleteModal
          currentSprint={currentSprint}
          completedCount={completedCount}
          pendingTasks={pendingTasks}
          onClose={sprintFlow.closeComplete}
          onComplete={action => void sprintFlow.complete(action)}
        />
      )}

      {/* Start Sprint modal */}
      {sprintFlow.showStartModal && (
        <SprintStartModal
          defaultName={getDefaultSprintName()}
          onClose={sprintFlow.cancelStart}
          onConfirm={(name, includeBacklog) => void sprintFlow.confirmStart(name, includeBacklog)}
          carryOverCount={sprintFlow.carryOverTaskIds.length}
          backlogCount={sprintBacklogTaskIds(allTasks, statuses).length}
        />
      )}

      {/* Approval confirm modal (from drag-and-drop) */}
      {approvalsEnabled && approvalConfirm && (
        <BoardApprovalModal
          approvalConfirm={approvalConfirm}
          onClose={() => setApprovalConfirm(null)}
          onDirectChange={handleApprovalDirectChange}
          onSubmitApproval={handleApprovalSubmit}
          onMandatoryApproval={handleMandatoryApproval}
          t={t}
        />
      )}
    </div>
    <DragOverlay dropAnimation={null}>
      {activeTask ? (
        <div className="rotate-2 shadow-xl w-[260px] md:w-[280px]">
          <TaskCard task={activeTask} fields={cardFields} subtaskMode={subtaskDisplayMode} customCardFields={customCardFields} interactive={false} />
        </div>
      ) : null}
    </DragOverlay>
    </DndContext>
  );
};

export default BoardView;
