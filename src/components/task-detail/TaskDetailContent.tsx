import { RecordViewModeButtons } from '@/components/ui/record-view-mode-buttons';
import { useProjectColor } from '@/hooks/useProjectColor';
import { FileText, MessageSquare, Clock, Timer, History, Link2, Copy, Trash2, X, ListTree, CornerDownRight, GitMerge, ChevronDown, ChevronRight, Plus, Lock, type LucideIcon } from 'lucide-react';
import { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useTaskDetail } from './hooks/useTaskDetail';
import TaskSpecTab from './TaskSpecTab';
import TaskCommentsTab from './TaskCommentsTab';
import TaskMetricsTab from './TaskMetricsTab';
import TaskActivityTab from './TaskActivityTab';
import TaskSubtasksTab from './TaskSubtasksTab';
import TaskTimeTab from './TaskTimeTab';
import TaskSidebarFields from './TaskSidebarFields';
import { useUIContext } from '@/context/UIContext';
import { canDeleteTaskRecord } from '@/lib/permissions';
import RelatedKnowledge from '@/components/knowledge/RelatedKnowledge';

type Props = { onClose: () => void };

const TaskDetailContent = ({ onClose }: Props) => {
  const getProjectColor = useProjectColor();
  const { approvalsEnabled } = useUIContext();
  const { t } = useTranslation();
  const detail = useTaskDetail();
  const {
    task, line, project, allTasks, statuses,
    otherViewers,
    activeTab, setActiveTab,
    showSaveTemplate, setShowSaveTemplate,
    templateName, setTemplateName,
    templateScope, setTemplateScope,
    taskComments, taskActivityLogs,
    currentMember,
    taskDisplayMode, setTaskDisplayMode,
    hasFeature, isMobile,
    handleDelete, handleCopyLink, handleSaveAsTemplate, handleUnlinkParent,
    setSelectedTask,
    updateTask,
  } = detail;

  if (!task) return null;

  return (
    <div className="bg-card flex min-w-0 flex-col h-full min-h-0">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-3 md:px-5 py-2 md:py-3 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-1.5 md:gap-2 min-w-0 overflow-x-auto scrollbar-hide">
          {line && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold flex-shrink-0" style={{ color: line.color, backgroundColor: line.color + '18' }}>
              {line.icon} {line.name}
            </span>
          )}
          {project && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold flex-shrink-0" style={{ color: getProjectColor(project), backgroundColor: getProjectColor(project) + '18' }}>
              {project.name}
            </span>
          )}
          <span className="text-sm font-bold text-primary flex-shrink-0">{task.taskKey}</span>
          {otherViewers.length > 0 && (
            <div className="flex items-center gap-1 flex-shrink-0 ml-1">
              <div className="flex -space-x-1.5">
                {otherViewers.slice(0, 5).map(v => (
                  <div key={v.memberId} title={t('task.viewerStatus', { name: v.name })} className="relative">
                    <div className="w-5 h-5 rounded-full border-2 border-card ring-2 ring-green-400 flex items-center justify-center text-[8px] font-bold text-white" style={{ backgroundColor: v.color }}>
                      {v.avatar}
                    </div>
                    <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-green-500 rounded-full border border-card" />
                  </div>
                ))}
              </div>
              <span className="text-[10px] text-green-600 font-medium whitespace-nowrap">
                {otherViewers.length === 1 ? t('task.viewerStatus', { name: otherViewers[0].name }) : t('task.multipleViewers', { count: otherViewers.length })}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {!isMobile && <RecordViewModeButtons value={taskDisplayMode} onChange={setTaskDisplayMode} />}
          {!isMobile && <div className="w-px h-4 bg-border mx-0.5 md:mx-1" />}
          <button onClick={handleCopyLink} title={t('task.copyLink')} aria-label={t('task.copyLink')} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors inline-flex items-center justify-center [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11">
            <Link2 size={15} />
          </button>
          {/* Save as Template */}
          <div className="relative">
            <button onClick={() => setShowSaveTemplate(v => !v)} className="p-1.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors inline-flex items-center justify-center [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11" title={t('task.saveTemplate')} aria-label={t('task.saveTemplate')} aria-expanded={showSaveTemplate}>
              <Copy size={15} />
            </button>
            {showSaveTemplate && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-lg p-3 w-[min(256px,calc(100vw-24px))]">
                <p className="text-xs font-semibold text-foreground mb-2">{t('task.saveTemplate')}</p>
                <input type="text" value={templateName} onChange={e => setTemplateName(e.target.value)}
                  placeholder={t('task.templateName')} autoFocus
                  className="w-full border border-border rounded px-2 py-1 text-xs bg-background text-foreground outline-none focus:ring-1 focus:ring-primary mb-2" />
                <div className="flex items-center gap-2 mb-2">
                  <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
                    <input type="radio" name="tmplScope" checked={templateScope === 'project'} onChange={() => setTemplateScope('project')} className="accent-primary" />
                    {t('task.projectTemplate')}
                  </label>
                  <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
                    <input type="radio" name="tmplScope" checked={templateScope === 'global'} onChange={() => setTemplateScope('global')} className="accent-primary" />
                    {t('task.globalTemplate')}
                  </label>
                </div>
                <div className="flex justify-end gap-1.5">
                  <button onClick={() => setShowSaveTemplate(false)} className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-accent">{t('button.cancel')}</button>
                  <button onClick={handleSaveAsTemplate} disabled={!templateName.trim()}
                    className="px-2 py-1 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40">{t('button.save')}</button>
                </div>
              </div>
            )}
          </div>
          {canDeleteTaskRecord(task, currentMember, statuses) && (
            // One confirmation dialog, which states that deleting cannot be undone.
            <button onClick={() => void handleDelete()} title={t('task.deleteTitle')} aria-label={t('task.deleteTitle')} className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors inline-flex items-center justify-center [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11">
              <Trash2 size={15} />
            </button>
          )}
          {/* Kept apart from delete so a tap meant for close cannot hit it. */}
          <div className="w-px h-4 bg-border mx-1" aria-hidden="true" />
          <button onClick={onClose} title={t('common.close')} aria-label={t('common.close')} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors inline-flex items-center justify-center [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* ── Parent task banner ── */}
      {hasFeature('subtasks') && task.parentTaskId && (() => {
        const parentTask = allTasks.find(t => t.id === task.parentTaskId);
        if (!parentTask) return null;
        return (
          <div className="flex items-center gap-2 px-3 md:px-5 py-2 border-b border-border flex-shrink-0 bg-blue-50/80 dark:bg-blue-950/30">
            <CornerDownRight size={13} className="text-blue-500 dark:text-blue-400 flex-shrink-0" />
            <span className="text-xs font-semibold text-blue-600 dark:text-blue-400 flex-shrink-0 whitespace-nowrap">{t('task.parentTaskLabel')}</span>
            <button type="button" onClick={() => setSelectedTask(parentTask)}
              className="text-xs text-foreground hover:text-blue-600 dark:hover:text-blue-400 hover:underline font-medium flex items-center gap-1.5 min-w-0"
              title={t('task.returnToParent', { key: parentTask.taskKey, title: parentTask.title })}>
              <span className="font-bold text-blue-600 dark:text-blue-400 flex-shrink-0">{parentTask.taskKey}</span>
              <span className="break-words">{parentTask.title}</span>
            </button>
            <button type="button" onClick={handleUnlinkParent}
              className="ml-auto text-[10px] text-muted-foreground hover:text-destructive transition-colors flex-shrink-0 px-1.5 py-0.5 rounded hover:bg-destructive/10"
              title={t('task.unlinkParent')}>
              {t('task.unlinkParentButton')}
            </button>
          </div>
        );
      })()}

      {/* ── Title ── */}
      <div className="px-3 md:px-5 py-2 md:py-3 flex-shrink-0">
        <input
          type="text"
          defaultValue={task.title}
          key={task.id}
          onBlur={e => {
            const val = e.target.value.trim();
            // A task needs a title: an emptied one goes back to the saved title, and says so.
            if (!val) { e.target.value = task.title; toast.info(t('taskDetail.titleRequired')); return; }
            if (val !== task.title) updateTask({ title: val });
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') { (e.target as HTMLInputElement).value = task.title; (e.target as HTMLInputElement).blur(); }
          }}
          className="w-full text-foreground text-base md:text-lg font-semibold leading-snug bg-transparent border-0 outline-none focus:ring-1 focus:ring-primary/30 rounded px-0 py-0"
        />
      </div>

      {/* ── Dependencies inline ── */}
      {hasFeature('task-dependencies') && <TaskDependencyInline detail={detail} />}

      {/* ── Body ── */}
      <div className={`flex flex-1 overflow-hidden min-h-0 ${isMobile ? 'flex-col' : ''}`}>
        {/* Left: Tabs */}
        <div className={`flex-1 flex flex-col ${isMobile ? '' : 'border-r border-border'} overflow-hidden min-w-0`}>
          {/* Tab bar */}
          <div className="flex px-3 md:px-5 flex-shrink-0 overflow-x-auto overscroll-x-contain border-b border-border">
            {([
              { id: 'spec' as const,     label: t('task.tabs.spec'), icon: FileText,       count: 0 },
              { id: 'comments' as const, label: t('task.tabs.comments'),     icon: MessageSquare,  count: taskComments.length },
              { id: 'metrics' as const,  label: t('task.tabs.metrics'),     icon: Clock,          count: 0 },
              { id: 'time' as const,     label: t('task.tabs.time'),     icon: Timer,          count: 0 },
              { id: 'activity' as const, label: t('task.tabs.activity'), icon: History,        count: taskActivityLogs.length },
              ...(hasFeature('subtasks') && !task.parentTaskId
                ? [{ id: 'subtasks' as const, label: t('task.tabs.subtasks'), icon: ListTree, count: allTasks.filter(t => t.parentTaskId === task.id).length }]
                : []),
            ] as Array<{ id: typeof activeTab; label: string; icon: LucideIcon; count: number }>).map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1 px-2.5 md:px-3 py-2 md:py-2.5 text-xs md:text-sm font-medium transition-colors relative -mb-px whitespace-nowrap flex-shrink-0 border-b-2 ${activeTab === tab.id ? 'text-primary border-primary' : 'text-muted-foreground hover:text-foreground border-transparent'}`}>
                <tab.icon size={13} />
                {tab.label}
                {tab.count > 0 && <span className="ml-0.5 text-xs text-muted-foreground">({tab.count})</span>}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-3 pb-[max(12px,env(safe-area-inset-bottom))] md:p-5">
            {activeTab === 'spec'      && <><TaskSpecTab detail={detail} /><RelatedKnowledge targetKind="task" targetId={task.id} /></>}
            {activeTab === 'comments'  && <TaskCommentsTab detail={detail} />}
            {activeTab === 'metrics'   && <TaskMetricsTab  detail={detail} />}
            {activeTab === 'time'      && <TaskTimeTab     detail={detail} />}
            {activeTab === 'activity'  && <TaskActivityTab detail={detail} />}
            {activeTab === 'subtasks'  && <TaskSubtasksTab detail={detail} />}
          </div>
        </div>

        {/* Right: Sidebar (desktop only) */}
        {!isMobile && (
          <div className={`flex-shrink-0 p-4 overflow-y-auto ${taskDisplayMode === 'page' ? 'w-[320px]' : 'w-[300px]'}`}>
            <TaskSidebarFields detail={detail} />
          </div>
        )}
      </div>
      {detail.ConfirmDialog}

      {/* Advisory approval 3-button dialog — portal to body */}
      {approvalsEnabled && detail.advisoryState && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={() => detail.setAdvisoryState(null)}>
          <div role="dialog" aria-modal="true" className="bg-card rounded-xl shadow-xl border border-border p-5 w-full max-w-sm mx-4 animate-in fade-in zoom-in-95 duration-150" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-foreground mb-2">{t('approval.advisoryTitle')}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t('approval.advisoryDesc', { statusName: detail.advisoryState.toStatusName })}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => detail.setAdvisoryState(null)}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">{t('common.cancel')}</button>
              <button onClick={detail.handleAdvisoryDirectChange}
                className="px-3 py-1.5 text-sm font-medium border border-border text-foreground rounded-lg hover:bg-accent transition-colors">{t('approval.directChange')}</button>
              <button onClick={detail.handleAdvisorySubmitApproval}
                className="px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">{t('approval.submitForApproval')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Approval confirm dialog (requiresApproval tasks) — portal to body */}
      {approvalsEnabled && detail.approvalConfirmState && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={() => detail.setApprovalConfirmState(null)}>
          <div role="dialog" aria-modal="true" className="bg-card rounded-xl shadow-xl border border-border p-5 w-full max-w-sm mx-4 animate-in fade-in zoom-in-95 duration-150" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-foreground mb-2">{t('taskDetail.approvalNeeded')}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t('taskDetail.approvalNeededDesc', { statusName: detail.approvalConfirmState.toStatusName })}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => detail.setApprovalConfirmState(null)}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">{t('common.cancel')}</button>
              <button onClick={detail.handleApprovalConfirm}
                className="px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">{t('button.submitApproval')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

/* ── Inline dependency block (lives between title & tabs) ── */
const TaskDependencyInline = ({ detail }: { detail: ReturnType<typeof useTaskDetail> }) => {
  const { t: tr } = useTranslation();
  const {
    task, allTasks, statuses,
    taskDependencies, addTaskDependency, removeTaskDependency,
    setSelectedTask,
  } = detail;

  const [expanded, setExpanded] = useState(false);
  const [addMode, setAddMode] = useState<'pre' | 'suc' | null>(null);
  const [searchQ, setSearchQ] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!addMode) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setAddMode(null);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [addMode]);

  if (!task) return null;

  const deps = taskDependencies.filter(d => d.taskId === task.id);
  const successors = taskDependencies.filter(d => d.dependsOnTaskId === task.id);
  const hasDeps = deps.length > 0 || successors.length > 0;

  // Predecessor stats
  const depsFinished = deps.filter(dep => {
    const dt = allTasks.find(t => t.id === dep.dependsOnTaskId);
    const ds = dt ? statuses.find(s => s.id === dt.statusId) : null;
    return ds?.isDone;
  }).length;
  const hasUnfinished = deps.length > 0 && depsFinished < deps.length;
  const allDepsFinished = deps.length > 0 && depsFinished === deps.length;

  // Always render so users can add dependencies even when none exist

  // ── Expanded: one row per task ──
  const renderTaskRow = (depId: string, linkedTaskId: string) => {
    const t = allTasks.find(x => x.id === linkedTaskId);
    if (!t) return null;
    const s = statuses.find(st => st.id === t.statusId);
    const done = s?.isDone ?? false;
    return (
      <div key={depId} className="flex items-center gap-2 py-1 group/row hover:bg-accent/30 rounded px-1.5 -mx-1.5 transition-colors">
        {/* Status badge */}
        <span
          className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0 whitespace-nowrap"
          style={{ backgroundColor: `${s?.color || '#6B778C'}18`, color: s?.color || '#6B778C' }}
        >
          {done && <span>✓</span>}
          {s?.name || tr('common.unknown')}
        </span>
        {/* Task key + title */}
        <button type="button" onClick={() => setSelectedTask(t)}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left hover:underline"
          title={`${t.taskKey}: ${t.title}`}
        >
          <span className="text-[11px] font-semibold text-primary flex-shrink-0">{t.taskKey}</span>
          <span className={`text-[11px] truncate ${done ? 'line-through text-muted-foreground' : 'text-foreground/80'}`}>{t.title}</span>
        </button>
        {/* Remove */}
        <button type="button" onClick={() => removeTaskDependency(depId)}
          className="opacity-0 group-hover/row:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 text-muted-foreground hover:text-destructive transition-opacity flex-shrink-0 p-0.5"
          title={tr('taskDetail.dependency.removeTitle')} aria-label={tr('taskDetail.dependency.removeTitle')}>
          <X size={12} />
        </button>
      </div>
    );
  };

  // ── Search dropdown ──
  const renderAddDropdown = (mode: 'pre' | 'suc') => {
    const existingIds = mode === 'pre'
      ? deps.map(d => d.dependsOnTaskId)
      : successors.map(d => d.taskId);
    const q = searchQ.toLowerCase();
    const candidates = allTasks
      .filter(t => t.id !== task.id && !existingIds.includes(t.id))
      .filter(t => !q || t.taskKey.toLowerCase().includes(q) || t.title.toLowerCase().includes(q))
      .sort((a, b) => {
        const sa = statuses.find(s => s.id === a.statusId);
        const sb = statuses.find(s => s.id === b.statusId);
        const aDone = sa?.isDone ?? false;
        const bDone = sb?.isDone ?? false;
        if (aDone !== bDone) return aDone ? 1 : -1; // non-done first
        return 0;
      })
      .slice(0, 15);

    return (
      <div className="absolute left-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-lg w-80 max-h-60 overflow-hidden">
        <div className="px-2.5 py-2 border-b border-border">
          <input type="text" value={searchQ} onChange={e => setSearchQ(e.target.value)}
            placeholder={tr('taskDetail.dependency.searchPlaceholder')} autoFocus
            className="w-full text-xs border border-border rounded px-2 py-1.5 bg-background text-foreground outline-none focus:ring-1 focus:ring-primary" />
        </div>
        <div className="overflow-y-auto max-h-48">
          {candidates.length === 0
            ? <p className="text-xs text-muted-foreground px-2.5 py-2">{tr('taskDetail.dependency.noAvailableTasks')}</p>
            : candidates.map(t => {
              const s = statuses.find(st => st.id === t.statusId);
              const done = s?.isDone ?? false;
              return (
                <button key={t.id} type="button"
                  onClick={async () => {
                    const ok = mode === 'pre'
                      ? await addTaskDependency(task.id, t.id)
                      : await addTaskDependency(t.id, task.id);
                    if (ok) { setAddMode(null); setSearchQ(''); }
                  }}
                  className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 hover:bg-accent transition-colors">
                  <span
                    className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: `${s?.color || '#6B778C'}18`, color: s?.color || '#6B778C' }}
                  >
                    {done && <span className="mr-0.5">✓</span>}{s?.name || tr('common.unknown')}
                  </span>
                  <span className="font-medium text-muted-foreground flex-shrink-0">{t.taskKey}</span>
                  <span className={`truncate ${done ? 'text-muted-foreground line-through' : ''}`}>{t.title}</span>
                </button>
              );
            })
          }
        </div>
      </div>
    );
  };

  return (
    <div className="px-3 md:px-5 pb-1 flex-shrink-0">
      <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
        {/* ── Collapsed header ── */}
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <GitMerge size={12} />
          </button>

          {!expanded && hasDeps ? (
            <div className="flex items-center gap-2 flex-1 min-w-0 text-[11px]">
              {/* Predecessor summary */}
              {deps.length > 0 && (
                <span className={`flex items-center gap-1 ${hasUnfinished ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}>
                  {hasUnfinished ? <Lock size={11} /> : <span>✓</span>}
                  <span>{tr('taskDetail.dependency.predecessorStatus', { done: depsFinished, total: deps.length })}</span>
                </span>
              )}
              {/* Separator */}
              {deps.length > 0 && successors.length > 0 && (
                <span className="text-border">·</span>
              )}
              {/* Successor summary */}
              {successors.length > 0 && (
                <span className="text-muted-foreground">
                  {tr('taskDetail.dependency.successorCount', { count: successors.length })}
                </span>
              )}
            </div>
          ) : !expanded ? (
            <span className="text-[11px] text-muted-foreground/60">{tr('taskDetail.dependency.noDependencies')}</span>
          ) : (
            <span className="text-xs text-muted-foreground">{tr('taskDetail.dependency.sectionTitle')}</span>
          )}
        </div>

        {/* ── Expanded: full list ── */}
        {expanded && (
          <div className="mt-2 space-y-3" ref={dropdownRef}>
            {/* ─ Predecessors ─ */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                  {tr('taskDetail.dependency.predecessors')}
                  {deps.length > 0 && (
                    <span className={`text-[10px] normal-case tracking-normal ${hasUnfinished ? 'text-amber-600' : 'text-green-600'}`}>
                      ({depsFinished}/{deps.length})
                    </span>
                  )}
                </span>
                <button type="button"
                  onClick={() => { setAddMode(addMode === 'pre' ? null : 'pre'); setSearchQ(''); }}
                  className={`text-[10px] transition-colors flex items-center gap-0.5 ${addMode === 'pre' ? 'text-primary' : 'text-muted-foreground hover:text-primary'}`}
                  title={tr('taskDetail.dependency.addPredecessor')}>
                  <Plus size={11} /><span>{tr('common.add')}</span>
                </button>
              </div>
              {deps.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/50 py-0.5">{tr('taskDetail.dependency.noPredecessors')}</p>
              ) : (
                <div>{deps.map(d => renderTaskRow(d.id, d.dependsOnTaskId))}</div>
              )}
              {hasUnfinished && (
                <div className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 mt-1 px-1.5">
                  <Lock size={10} /><span>{tr('taskDetail.dependency.blocked')}</span>
                </div>
              )}
              <div className="relative">
                {addMode === 'pre' && renderAddDropdown('pre')}
              </div>
            </div>

            {/* ─ Successors ─ */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                  {tr('taskDetail.dependency.successors')}
                  {successors.length > 0 && (
                    <span className="text-[10px] normal-case tracking-normal text-muted-foreground">({successors.length})</span>
                  )}
                </span>
                <button type="button"
                  onClick={() => { setAddMode(addMode === 'suc' ? null : 'suc'); setSearchQ(''); }}
                  className={`text-[10px] transition-colors flex items-center gap-0.5 ${addMode === 'suc' ? 'text-primary' : 'text-muted-foreground hover:text-primary'}`}
                  title={tr('taskDetail.dependency.addSuccessor')}>
                  <Plus size={11} /><span>{tr('common.add')}</span>
                </button>
              </div>
              {successors.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/50 py-0.5">{tr('taskDetail.dependency.noSuccessors')}</p>
              ) : (
                <div>{successors.map(d => renderTaskRow(d.id, d.taskId))}</div>
              )}
              <div className="relative">
                {addMode === 'suc' && renderAddDropdown('suc')}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TaskDetailContent;
