import { useState, useEffect, useCallback } from 'react';
import { Clock, CheckCheck, X, CornerUpLeft, Filter } from 'lucide-react';
import { useApprovalWorkflow } from '@/hooks/useApprovalWorkflow';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useTaskContext } from '@/context/TaskContext';
import { useMemberContext } from '@/context/MemberContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useUIContext } from '@/context/UIContext';
import type { ApprovalRequest } from '@/lib/approvalQueries';
import { useTranslation } from 'react-i18next';

interface ActionDialogState {
  request: ApprovalRequest;
  action: 'approve' | 'reject' | 'return';
}

function formatWaitTime(createdAt: string): string {
  const diff = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export default function PendingApprovalList({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  const { pendingApprovals, loading, fetchPendingApprovals, performAction } = useApprovalWorkflow();
  const { statuses, allTasks, setAllTasks } = useTaskContext();
  const { users } = useMemberContext();
  const { allProjects } = useProjectContext();
  const { setSelectedTask } = useUIContext();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterProject, setFilterProject] = useState('');
  const [actionDialog, setActionDialog] = useState<ActionDialogState | null>(null);
  const [comment, setComment] = useState('');
  const [actioning, setActioning] = useState(false);

  const actionDialogRef = useFocusTrap(actionDialog !== null);

  useEffect(() => { fetchPendingApprovals(); }, [fetchPendingApprovals]);

  const getStatusName = (id: string) => statuses.find(s => s.id === id)?.name ?? id;
  const getUserName = (id: string) => users.find(u => u.id === id)?.name ?? id;
  const getTask = (taskId: string) => allTasks.find(t => t.id === taskId);
  const getProjectName = (taskId: string) => {
    const task = getTask(taskId);
    return task ? (allProjects.find(p => p.id === task.projectId)?.name ?? '') : '';
  };

  const filtered = pendingApprovals.filter(r =>
    !filterProject || getTask(r.task_id)?.projectId === filterProject
  );

  const toggleSelect = (id: string) => {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const toggleAll = () => {
    setSelected(prev => prev.size === filtered.length ? new Set() : new Set(filtered.map(r => r.id)));
  };

  const applyApprovalResult = (result: { ok: boolean; approvedToStatus?: string; taskId?: string }) => {
    if (result.approvedToStatus && result.taskId) {
      const toStatus = statuses.find(s => s.id === result.approvedToStatus);
      const task = allTasks.find(t => t.id === result.taskId);
      if (task) {
        const oldStatus = statuses.find(s => s.id === task.statusId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const updates: Record<string, any> = {
          statusId: result.approvedToStatus,
          approvalStatus: undefined,
          currentApprovalId: undefined,
        };
        if (toStatus?.autoStart && !task.startedAt) updates.startedAt = new Date().toISOString().split('T')[0];
        if (toStatus?.isDone && !oldStatus?.isDone) updates.completedAt = new Date().toISOString();
        if (!toStatus?.isDone && oldStatus?.isDone) updates.completedAt = undefined;
        setAllTasks(prev => prev.map(t => t.id === result.taskId ? { ...t, ...updates } : t));
      }
    }
  };

  const handleBulkApprove = async () => {
    for (const id of selected) {
      const result = await performAction(id, 'approve');
      applyApprovalResult(result);
    }
    setSelected(new Set());
    fetchPendingApprovals();
  };

  const openActionDialog = (request: ApprovalRequest, action: 'approve' | 'reject' | 'return') => {
    setActionDialog({ request, action });
    setComment('');
  };

  const handleConfirmAction = useCallback(async () => {
    if (!actionDialog) return;
    setActioning(true);
    const result = await performAction(actionDialog.request.id, actionDialog.action, comment || undefined);
    applyApprovalResult(result);
    setActioning(false);
    setActionDialog(null);
    fetchPendingApprovals();
  }, [actionDialog, comment, performAction, fetchPendingApprovals]);

  const handleClickTask = (taskId: string) => {
    const task = getTask(taskId);
    if (task) { setSelectedTask(task); onClose?.(); }
  };

  const projectOptions = Array.from(new Set(pendingApprovals.map(r => getTask(r.task_id)?.projectId).filter(Boolean))) as string[];

  const actionLabels = { approve: t('approval.approve'), reject: t('approval.reject'), return: t('approval.returnAction') };
  const actionColors = { approve: 'bg-green-600 hover:bg-green-700', reject: 'bg-destructive hover:bg-destructive/90', return: 'bg-amber-600 hover:bg-amber-700' };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 pb-3 border-b border-border flex-wrap">
        {projectOptions.length > 1 && (
          <div className="flex items-center gap-1.5">
            <Filter size={12} className="text-muted-foreground" />
            <select
              value={filterProject}
              onChange={e => setFilterProject(e.target.value)}
              className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            >
              <option value="">{t('pendingApproval.allProjects')}</option>
              {projectOptions.map(pid => (
                <option key={pid} value={pid}>{allProjects.find(p => p.id === pid)?.name ?? pid}</option>
              ))}
            </select>
          </div>
        )}
        {selected.size > 0 && (
          <button
            onClick={handleBulkApprove}
            className="ml-auto flex items-center gap-1.5 text-xs bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-lg transition-colors"
          >
            <CheckCheck size={12} />
            {t('pendingApproval.bulkApprove')} ({selected.size})
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">{t('common.loading')}</div>
      ) : filtered.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">{t('pendingApproval.noItems')}</div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="py-2 pr-3 text-left">
                  <input type="checkbox" checked={selected.size === filtered.length && filtered.length > 0} onChange={toggleAll} aria-label={t('button.selectAll')} />
                </th>
                <th className="py-2 pr-3 text-left text-xs font-medium text-muted-foreground">{t('pendingApproval.taskHeader')}</th>
                <th className="py-2 pr-3 text-left text-xs font-medium text-muted-foreground">{t('pendingApproval.projectHeader')}</th>
                <th className="py-2 pr-3 text-left text-xs font-medium text-muted-foreground">{t('pendingApproval.requesterHeader')}</th>
                <th className="py-2 pr-3 text-left text-xs font-medium text-muted-foreground">{t('pendingApproval.statusTransitionHeader')}</th>
                <th className="py-2 pr-3 text-left text-xs font-medium text-muted-foreground">
                  <Clock size={11} className="inline mr-1" />{t('pendingApproval.waitHeader')}
                </th>
                <th className="py-2 text-left text-xs font-medium text-muted-foreground">{t('pendingApproval.actionHeader')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(req => {
                const task = getTask(req.task_id);
                return (
                  <tr key={req.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                    <td className="py-2 pr-3">
                      <input type="checkbox" checked={selected.has(req.id)} onChange={() => toggleSelect(req.id)} />
                    </td>
                    <td className="py-2 pr-3">
                      <button
                        onClick={() => handleClickTask(req.task_id)}
                        className="text-left hover:text-primary transition-colors"
                        disabled={!task}
                      >
                        <div className="font-medium text-foreground truncate max-w-[180px]">
                          {task?.title ?? t('pendingApproval.taskNotInProject')}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {task?.taskKey ?? `${req.task_id.slice(0, 8)}…`}
                        </div>
                      </button>
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">{getProjectName(req.task_id)}</td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">{getUserName(req.requested_by)}</td>
                    <td className="py-2 pr-3">
                      <span className="text-xs text-muted-foreground">{getStatusName(req.from_status)}</span>
                      <span className="text-xs text-muted-foreground mx-1">→</span>
                      <span className="text-xs font-medium text-foreground">{getStatusName(req.to_status)}</span>
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">{formatWaitTime(req.created_at)}</td>
                    <td className="py-2">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openActionDialog(req, 'approve')}
                          title={t('approval.approve')}
                          aria-label={t('approval.approve')}
                          className="p-1.5 rounded text-green-600 hover:bg-green-100 dark:hover:bg-green-900/20 transition-colors"
                        >
                          <CheckCheck size={13} />
                        </button>
                        <button
                          onClick={() => openActionDialog(req, 'return')}
                          title={t('approval.returnAction')}
                          aria-label={t('approval.returnAction')}
                          className="p-1.5 rounded text-amber-600 hover:bg-amber-100 dark:hover:bg-amber-900/20 transition-colors"
                        >
                          <CornerUpLeft size={13} />
                        </button>
                        <button
                          onClick={() => openActionDialog(req, 'reject')}
                          title={t('approval.reject')}
                          aria-label={t('approval.reject')}
                          className="p-1.5 rounded text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Action dialog */}
      {actionDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div ref={actionDialogRef} role="dialog" aria-modal="true" aria-labelledby="pending-approval-action-title" className="bg-card border border-border rounded-xl shadow-xl w-full max-w-sm mx-4 p-5 space-y-4">
            <h3 id="pending-approval-action-title" className="text-base font-semibold text-foreground">
              {actionLabels[actionDialog.action]}{t('pendingApproval.approvalSuffix')}
            </h3>
            <p className="text-sm text-muted-foreground">
              {actionDialog.action !== 'approve' ? t('pendingApproval.fillNote') : t('pendingApproval.optionalNote')}{t('pendingApproval.noteDesc')}
            </p>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder={t('pendingApproval.notePlaceholder')}
              rows={3}
              className="w-full text-sm bg-muted border border-border rounded-lg px-3 py-2 text-foreground resize-none"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setActionDialog(null)}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleConfirmAction}
                disabled={actioning}
                className={`px-4 py-1.5 text-sm text-white rounded-lg transition-colors disabled:opacity-50 ${actionColors[actionDialog.action]}`}
              >
                {actioning ? t('common.processing') : actionLabels[actionDialog.action]}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
