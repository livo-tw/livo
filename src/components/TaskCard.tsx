import { deploymentEnvironmentPresentation } from '@/lib/deploymentEnvironments';
import { memo, useMemo, useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useUIContext } from '@/context/UIContext';
import { useMemberContext } from '@/context/MemberContext';
import { useTaskContext } from '@/context/TaskContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useLicense } from '@/context/LicenseContext';
import { useApprovalRules } from '@/hooks/useApprovalRules';
import { useApprovalWorkflow } from '@/hooks/useApprovalWorkflow';
import { useBoardApproval } from '@/components/board/useBoardApproval';
import { useStatusChangeGate } from '@/hooks/useStatusChangeGate';
import { statusChangeUpdates } from '@/lib/taskStatusChange';
import { announceAssignment, announceStatusChange } from '@/lib/taskAnnouncements';
import { formatCustomFieldValue } from '@/lib/customFieldDisplay';
import { useTaskAnnouncements } from '@/hooks/useTaskAnnouncements';
import { toast } from 'sonner';
import BoardApprovalModal from '@/components/board/BoardApprovalModal';
import type { ApprovalConfirmPayload } from '@/components/board/BoardApprovalModal';
import { Task, Priority } from '@/types';
import { GitBranch, MessageSquare, Paperclip, Lock, ListTree, CornerDownRight, AlertTriangle, Calendar, GitMerge, Flag, UserCircle, Circle } from 'lucide-react';
import { taskDepartment, deptColors } from '@/lib/department';
import { priorityConfig } from '@/components/ui/badges';
// CardFieldVisibility lives in fieldRegistry (single source of truth)
import type { CardFieldVisibility } from '@/lib/fieldRegistry';
export type { CardFieldVisibility } from '@/lib/fieldRegistry';

/* ── Inline Quick-Edit Popover (Portal-based to escape overflow clipping) ── */
function QuickPopover({ anchorRef, onClose, children }: { anchorRef: React.RefObject<HTMLButtonElement>; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const popover = ref.current;
    if (!anchor || !popover) return;
    const ar = anchor.getBoundingClientRect();
    const pr = popover.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    // Vertical: prefer above button, flip below if not enough space
    const spaceAbove = ar.top;
    const spaceBelow = vh - ar.bottom;
    const top = spaceAbove >= pr.height + 4
      ? ar.top - pr.height - 4
      : spaceBelow >= pr.height + 4
        ? ar.bottom + 4
        : Math.max(4, Math.min(ar.top - pr.height / 2, vh - pr.height - 4));
    // Horizontal: align right edge with button right edge, but keep in viewport
    const left = Math.max(4, Math.min(ar.right - pr.width, vw - pr.width - 4));
    setStyle({ top, left, visibility: 'visible' });
  }, [anchorRef]);

  useLayoutEffect(() => { reposition(); }, [reposition]);

  useEffect(() => {
    // Re-measure once the popover content is rendered
    const frame = requestAnimationFrame(reposition);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); };
  }, [reposition]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [onClose]);

  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        anchorRef.current?.focus();
        onClose();
      }
    };
    document.addEventListener('keydown', keyHandler);
    return () => document.removeEventListener('keydown', keyHandler);
  }, [anchorRef, onClose]);

  return createPortal(
    <div ref={ref} className="fixed z-[200] bg-popover border border-border rounded-lg shadow-lg py-1 max-h-48 overflow-y-auto min-w-[120px]"
      style={style}
      onPointerDown={e => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
}

const TaskCard = memo(({ task, fields, subtaskMode, customCardFields, interactive }: { task: Task; fields?: CardFieldVisibility; subtaskMode?: 'independent' | 'nested'; customCardFields?: Record<string, boolean>; interactive?: boolean }) => {
  const { t } = useTranslation();
  const { approvalsEnabled, featureTogglesReady, setSelectedTask } = useUIContext();
  const { users } = useMemberContext();
  const { tags, taskDependencies, allTasks, setAllTasks, statuses, customFields, customFieldValues, updateTaskInDb } = useTaskContext();
  const { allProjects } = useProjectContext();
  const { hasFeature } = useLicense();
  const { getRuleForTransition } = useApprovalRules();
  const { requestApproval } = useApprovalWorkflow();
  // Quick edits tell others the same way the task detail does, once saved.
  const announcements = useTaskAnnouncements();
  const announceDirect = useCallback((changed: Task, from: string, to: string) => announceStatusChange(changed, from, to, announcements), [announcements]);
  const {
    approvalConfirm, setApprovalConfirm,
    handleApprovalDirectChange, handleApprovalSubmit, handleMandatoryApproval,
  } = useBoardApproval({ allTasks, statuses, setAllTasks, updateTaskInDb, getRuleForTransition, requestApproval, t, announce: announceDirect });
  const statusGate = useStatusChangeGate();
  const [quickEdit, setQuickEdit] = useState<'priority' | 'assignee' | 'status' | null>(null);
  // Long member lists can be narrowed by typing, as in the shared searchable selects.
  const [assigneeQuery, setAssigneeQuery] = useState('');
  useEffect(() => { if (quickEdit !== 'assignee') setAssigneeQuery(''); }, [quickEdit]);
  const activeUsers = useMemo(() => users.filter(u => u.isActive), [users]);
  const matchingUsers = useMemo(() => {
    const query = assigneeQuery.trim().toLowerCase();
    return query ? activeUsers.filter(u => `${u.name} ${u.jobTitle || ''} ${u.email || ''}`.toLowerCase().includes(query)) : activeUsers;
  }, [activeUsers, assigneeQuery]);
  const quickBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const assignee = users.find(u => u.id === task.assigneeId);
  const reviewer = users.find(u => u.id === task.reviewerId);
  const priority = priorityConfig[task.priority];
  const dept = taskDepartment(task, users);
  const status = statuses.find(s => s.id === task.statusId);
  const f = fields || {
    taskKey: true, commentCount: true, attachmentCount: true, gitlabUrl: true,
    department: true, tags: true, deployments: true, subtaskCount: true,
    status: false, reviewer: false, dependencyCount: true,
  };

  const handleQuickStatusChange = useCallback(async (newStatusId: string) => {
    setQuickEdit(null);
    if (!featureTogglesReady || task.statusId === newStatusId) return;
    const project = allProjects.find(p => p.id === task.projectId);
    const gate = statusGate.check(task, newStatusId);
    const refusal = statusGate.refusal(gate, newStatusId);
    if (refusal) { toast.error(refusal); return; }
    // Mandatory approval: task has requiresApproval flag
    if (gate.kind === 'approval') {
      const toStatusName = statuses.find(s => s.id === newStatusId)?.name || '—';
      setApprovalConfirm({ taskId: task.id, fromStatusId: task.statusId, toStatusId: newStatusId, projectId: project?.id || '', toStatusName });
      return;
    }
    // Advisory: check if an approval rule exists for this transition
    if (approvalsEnabled && project) {
      try {
        const ruleInfo = await getRuleForTransition(project.id, task.statusId, newStatusId);
        if (ruleInfo) {
          const toStatusName = statuses.find(s => s.id === newStatusId)?.name || '—';
          setApprovalConfirm({ taskId: task.id, fromStatusId: task.statusId, toStatusId: newStatusId, projectId: project.id, toStatusName, advisory: true });
          return;
        }
      } catch (err) {
        console.error('[LIVO] quick-edit approval check error:', err);
      }
    }
    // No approval needed — direct update
    const updates = statusChangeUpdates(task, statuses, newStatusId);
    setAllTasks(prev => prev.map(t2 => t2.id === task.id ? { ...t2, ...updates } : t2));
    if ((await updateTaskInDb(task.id, updates)) === false) return;
    announceStatusChange(task, task.statusId, newStatusId, announcements);
  }, [approvalsEnabled, featureTogglesReady, task, allProjects, statuses, setAllTasks, updateTaskInDb, getRuleForTransition, setApprovalConfirm, statusGate, announcements]);

  const quickAssign = useCallback(async (assigneeId: string | null) => {
    setQuickEdit(null);
    if ((assigneeId || null) === (task.assigneeId || null)) return;
    setAllTasks(prev => prev.map(t2 => t2.id === task.id ? { ...t2, assigneeId: assigneeId || undefined } : t2));
    if ((await updateTaskInDb(task.id, { assigneeId } as unknown as Partial<Task>)) === false) return;
    announceAssignment(task, assigneeId, announcements);
  }, [task, setAllTasks, updateTaskInDb, announcements]);

  const subtasks = useMemo(() => {
    if (!hasFeature('subtasks') || subtaskMode !== 'nested') return [];
    return allTasks.filter(t => t.parentTaskId === task.id);
  }, [hasFeature, subtaskMode, allTasks, task.id]);

  const isBlocked = useMemo(() => {
    if (!hasFeature('task-dependencies')) return false;
    const deps = taskDependencies.filter(d => d.taskId === task.id);
    return deps.some(dep => {
      const depTask = allTasks.find(t => t.id === dep.dependsOnTaskId);
      if (!depTask) return false;
      const depStatus = statuses.find(s => s.id === depTask.statusId);
      return depStatus && !depStatus.isDone;
    });
  }, [hasFeature, taskDependencies, task.id, allTasks, statuses]);

  const today = useMemo(() => new Date(), []);
  const isOverdue = task.dueDate && new Date(task.dueDate) < today && !task.completedAt;
  const dueDateStr = task.dueDate
    ? `${new Date(task.dueDate).getMonth() + 1}/${new Date(task.dueDate).getDate()}`
    : null;

  const relativeDue = useMemo(() => {
    if (!task.dueDate || task.completedAt) return null;
    const due = new Date(task.dueDate);
    const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const dueMidnight = new Date(due.getFullYear(), due.getMonth(), due.getDate());
    const diffDays = Math.round((dueMidnight.getTime() - todayMidnight.getTime()) / 86400000);
    if (diffDays === 0) return { text: t('task.dueToday'), color: 'text-orange-500' };
    if (diffDays < 0) return { text: t('task.overdueDays', { days: -diffDays }), color: 'text-destructive' };
    if (diffDays <= 3) return { text: t('task.remainingDays', { days: diffDays }), color: 'text-orange-400' };
    return { text: t('task.remainingDays', { days: diffDays }), color: 'text-muted-foreground' };
  }, [task.dueDate, task.completedAt, today]);

  return (
    <div
      role={interactive !== false ? 'button' : undefined}
      tabIndex={interactive !== false ? 0 : undefined}
      onClick={() => setSelectedTask(task)}
      onKeyDown={interactive !== false ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedTask(task); } }) : undefined}
      aria-label={t('task.ariaLabel', { title: task.title })}
      className={`relative bg-card rounded-lg border border-border/80 p-3 cursor-pointer hover:shadow-md hover:border-primary/20 transition-all group select-none ${isBlocked ? 'border-l-2 border-l-amber-500' : ''}`}
    >
      {/* Subtask indicator */}
      {hasFeature('subtasks') && task.parentTaskId && (
        <div className="flex items-center gap-1 text-[10px] text-blue-600 bg-blue-50 dark:bg-blue-950/40 dark:text-blue-400 rounded px-1.5 py-0.5 mb-1.5">
          <CornerDownRight size={10} />
          <span>{t('task.subtask')}</span>
        </div>
      )}
      {/* Blocked state is now indicated by amber left border on the card */}
      {/* Pending approval indicator */}
      {approvalsEnabled && task.approvalStatus === 'pending_approval' && (
        <div className="flex items-center gap-1 text-[10px] text-purple-600 bg-purple-50 dark:bg-purple-900/20 dark:text-purple-400 rounded px-1.5 py-0.5 mb-1.5">
          <span>⏳</span>
          <span>{t('approval.pending')}</span>
        </div>
      )}
      {/* Status badge (optional) */}
      {f.status && status && (
        <div className="flex items-center gap-1 mb-1.5">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: status.color }} />
          <span className="text-[10.5px] font-semibold" style={{ color: status.color }}>{status.name}</span>
        </div>
      )}
      {/* Row 1: Title (always shown) */}
      <p className="text-sm font-semibold text-foreground leading-snug mb-2 line-clamp-2 break-words">{task.title}</p>
      {/* Row 2: Key, Date (date always shown, key toggleable) */}
      {/* Wraps instead of clipping: a narrow column must still show the whole date and the days left. */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0 mb-2">
        {f.taskKey && <span className="text-xs text-muted-foreground flex-shrink-0 whitespace-nowrap">{task.taskKey}</span>}
        {dueDateStr && !task.completedAt && (
          <span className={`text-xs flex items-center gap-0.5 flex-shrink-0 whitespace-nowrap ${isOverdue ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
            {isOverdue ? <AlertTriangle size={12} /> : <Calendar size={12} />} {dueDateStr}
          </span>
        )}
        {relativeDue && (
          <span className={`text-[10.5px] flex-shrink-0 whitespace-nowrap ${relativeDue.color}`}>
            {relativeDue.text}
          </span>
        )}
      </div>
      {/* Row 3: Priority (always), Comments, Git, Dept, Assignee (always) */}
      <div className="flex items-center justify-between min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`${priority.className} ${priority.bg} w-5 h-5 rounded flex items-center justify-center`}>{priority.icon}</span>
          {f.commentCount && task.commentCount > 0 && (
            <span className="flex items-center gap-0.5 text-muted-foreground">
              <MessageSquare size={14} />
              <span className="text-xs">{task.commentCount}</span>
            </span>
          )}
          {f.attachmentCount && task.attachmentCount > 0 && (
            <span className="flex items-center gap-0.5 text-muted-foreground">
              <Paperclip size={14} />
              <span className="text-xs">{task.attachmentCount}</span>
            </span>
          )}
          {f.gitlabUrl && task.gitlabUrl && <GitBranch size={13} className="text-muted-foreground" />}
        </div>
        <div className="flex items-center gap-1.5">
          {f.department && dept && (
            <span className={`text-xs font-semibold px-1.5 py-0.5 rounded flex-shrink-0 !text-[13px] ${deptColors[dept]}`}>{dept}</span>
          )}
          {assignee && (
            <div className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-[9px] font-bold" style={{ backgroundColor: assignee.color, color: '#fff' }} title={assignee.name}>
              {assignee.avatar}
            </div>
          )}
        </div>
      </div>
      {/* Row 4: Tags */}
      {f.tags && (task.tagIds && task.tagIds.length > 0) && (
        <div className="flex items-center gap-1 flex-wrap mt-1.5">
          {task.tagIds.map(tagId => {
            const tag = tags.find(t => t.id === tagId);
            if (!tag) return null;
            return (
              <span
                key={tag.id}
                className="text-[10.5px] font-medium px-1.5 py-[2px] rounded flex-shrink-0 text-white"
                style={{ backgroundColor: tag.color }}
                title={tag.name}
              >
                {tag.name}
              </span>
            );
          })}
        </div>
      )}
      {/* Row 5: Deployments */}
      {f.deployments && task.deployments.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          {task.deployments.map((d, i) => {
            const { color, abbreviation } = deploymentEnvironmentPresentation(d.environment);
            return (
              <span
                key={i}
                className="text-[11px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
                style={d.status === 'deployed'
                  ? { backgroundColor: color, color: '#fff' }
                  : { border: `1.5px solid ${color}`, color }}
                title={`${d.environment}: ${d.status}`}
              >
                {abbreviation}
              </span>
            );
          })}
        </div>
      )}
      {/* Row 6: Reviewer (optional) */}
      {f.reviewer && reviewer && (
        <div className="flex items-center gap-1 mt-1.5">
          <span className="text-[10px] text-muted-foreground">{t('task.reviewerLabel')}</span>
          <div className="w-4 h-4 rounded-full flex items-center justify-center text-[7px] font-bold" style={{ backgroundColor: reviewer.color, color: '#fff' }} title={reviewer.name}>
            {reviewer.avatar}
          </div>
          <span className="text-[10.5px] text-muted-foreground truncate">{reviewer.name}</span>
        </div>
      )}
      {/* Row 7: Subtask count (independent mode) or nested subtask list */}
      {hasFeature('subtasks') && subtaskMode !== 'nested' && f.subtaskCount && (() => {
        const subs = allTasks.filter(t => t.parentTaskId === task.id);
        if (subs.length === 0) return null;
        const doneCount = subs.filter(t => statuses.find(s => s.id === t.statusId)?.isDone).length;
        return (
          <div className="flex items-center gap-1 mt-1.5 text-muted-foreground">
            <ListTree size={11} />
            <span className="text-[10.5px]">{t('task.subtaskProgress', { done: doneCount, total: subs.length })}</span>
          </div>
        );
      })()}
      {subtaskMode === 'nested' && subtasks.length > 0 && (
        <div className="mt-2 border-t border-border/50 pt-1.5 space-y-1">
          {subtasks.map(sub => {
            const subStatus = statuses.find(s => s.id === sub.statusId);
            return (
              <div
                key={sub.id}
                role="button"
                tabIndex={0}
                onClick={e => { e.stopPropagation(); setSelectedTask(sub); }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setSelectedTask(sub); } }}
                aria-label={t('task.ariaLabel', { title: sub.title })}
                className="flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 py-0.5 transition-colors"
              >
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: subStatus?.color || '#6B778C' }} />
                <span className={`text-[10.5px] truncate ${subStatus?.isDone ? 'line-through text-muted-foreground' : 'text-foreground'}`}>{sub.title}</span>
              </div>
            );
          })}
        </div>
      )}
      {/* Row 8: Dependency count */}
      {hasFeature('task-dependencies') && f.dependencyCount && (() => {
        const deps = taskDependencies.filter(d => d.taskId === task.id);
        if (deps.length === 0) return null;
        const doneCount = deps.filter(dep => {
          const depTask = allTasks.find(t => t.id === dep.dependsOnTaskId);
          return depTask ? statuses.find(s => s.id === depTask.statusId)?.isDone : false;
        }).length;
        const allDone = doneCount === deps.length;
        return (
          <div className={`flex items-center gap-1 mt-1.5 ${allDone ? 'text-green-600' : 'text-amber-600'}`}>
            <GitMerge size={11} />
            <span className="text-[10.5px]">{t('task.dependencyProgress', { done: doneCount, total: deps.length })}</span>
          </div>
        );
      })()}
      {/* Row 9: Custom fields */}
      {customCardFields && Object.keys(customCardFields).length > 0 && customFields.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap mt-1.5">
          {customFields
            .filter(cf => customCardFields[cf.id])
            .map(cf => {
              const text = formatCustomFieldValue(cf, customFieldValues.find(v => v.taskId === task.id && v.fieldId === cf.id), users, t);
              if (!text) return null;
              return (
                <span key={cf.id} className="text-[10px] text-muted-foreground bg-muted rounded px-1.5 py-0.5">
                  {cf.fieldName}: {text}
                </span>
              );
            })}
        </div>
      )}
      {/* Quick-edit buttons: on hover or keyboard focus, and always on touch screens (no hover there). */}
      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
        {(['priority', 'status', 'assignee'] as const).map(type => (
          <div key={type} className="relative">
            <button
              ref={el => { quickBtnRefs.current[type] = el; }}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setQuickEdit(quickEdit === type ? null : type); }}
              className="w-6 h-6 rounded flex items-center justify-center bg-card/90 border border-border/60 shadow-sm hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title={t(`card.quick${type.charAt(0).toUpperCase() + type.slice(1)}`)}
              aria-label={t(`card.quick${type.charAt(0).toUpperCase() + type.slice(1)}`)}
              aria-expanded={quickEdit === type}
            >
              {type === 'priority' && <Flag size={12} />}
              {type === 'status' && <Circle size={12} />}
              {type === 'assignee' && <UserCircle size={12} />}
            </button>
            {quickEdit === type && (
              <QuickPopover anchorRef={{ current: quickBtnRefs.current[type] } as React.RefObject<HTMLButtonElement>} onClose={() => setQuickEdit(null)}>
                {type === 'priority' && (Object.entries(priorityConfig) as [Priority, typeof priorityConfig[Priority]][]).map(([key, cfg]) => (
                  <button key={key} onClick={e => { e.stopPropagation(); setAllTasks(prev => prev.map(t2 => t2.id === task.id ? { ...t2, priority: key } : t2)); updateTaskInDb(task.id, { priority: key } as Partial<Task>); setQuickEdit(null); }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors ${task.priority === key ? 'bg-accent/50 font-semibold' : ''}`}>
                    <span className={`${cfg.className} ${cfg.bg} w-4 h-4 rounded flex items-center justify-center text-[10px]`}>{cfg.icon}</span>
                    {cfg.label}
                  </button>
                ))}
                {type === 'status' && statuses.map(s => (
                  <button key={s.id} onClick={e => { e.stopPropagation(); handleQuickStatusChange(s.id); }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors ${task.statusId === s.id ? 'bg-accent/50 font-semibold' : ''}`}>
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                    {s.name}
                  </button>
                ))}
                {type === 'assignee' && (
                  <>
                    {activeUsers.length > 8 && <input autoFocus value={assigneeQuery} onChange={e => setAssigneeQuery(e.target.value)} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
                      placeholder={t('common.search')} aria-label={t('common.search')} className="mx-2 my-1 w-[calc(100%-1rem)] rounded border border-border bg-card px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary" />}
                    <button onClick={e => { e.stopPropagation(); void quickAssign(null); }}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors ${!task.assigneeId ? 'bg-accent/50 font-semibold' : ''}`}>
                      <UserCircle size={14} className="text-muted-foreground" />
                      {t('common.unassigned')}
                    </button>
                    {matchingUsers.map(u => (
                      <button key={u.id} onClick={e => { e.stopPropagation(); void quickAssign(u.id); }}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors ${task.assigneeId === u.id ? 'bg-accent/50 font-semibold' : ''}`}>
                        <div className="w-4 h-4 rounded-full flex items-center justify-center text-[7px] font-bold flex-shrink-0" style={{ backgroundColor: u.color, color: '#fff' }}>{u.avatar}</div>
                        {u.name}
                      </button>
                    ))}
                  </>
                )}
              </QuickPopover>
            )}
          </div>
        ))}
      </div>
      {/* Approval confirm modal for quick status change */}
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
  );
});

TaskCard.displayName = 'TaskCard';

export default TaskCard;
