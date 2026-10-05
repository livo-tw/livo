import { SearchableSelect } from '@/components/ui/searchable-select';
import { useState, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTaskContext } from '@/context/TaskContext';
import { useMemberContext } from '@/context/MemberContext';
import { useAuthContext } from '@/context/AuthContext';
import { logActivity } from '@/lib/activityLog';
import { priorityConfig } from '@/components/ui/badges';
import { supabase } from '@/integrations/supabase/client';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { Priority, Task } from '@/types';
import { useStatusChangeGate } from '@/hooks/useStatusChangeGate';
import { statusChangeUpdates } from '@/lib/taskStatusChange';
import { announceAssignment } from '@/lib/taskAnnouncements';
import { useTaskAnnouncements } from '@/hooks/useTaskAnnouncements';

interface BulkActionBarProps {
  selectedIds: Set<string>;
  onClearSelection: () => void;
}

export const BulkActionBar = memo(({ selectedIds, onClearSelection }: BulkActionBarProps) => {
  const { t } = useTranslation();
  const { allTasks, statuses, updateTaskInDb, setAllTasks } = useTaskContext();
  const { users } = useMemberContext();
  const { currentMemberId, permissions } = useAuthContext();
  const statusGate = useStatusChangeGate();
  const announcements = useTaskAnnouncements();
  const [isLoading, setIsLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [statusVal, setStatusVal] = useState('');
  const [assigneeVal, setAssigneeVal] = useState('');
  const [priorityVal, setPriorityVal] = useState('');

  const count = selectedIds.size;
  if (count === 0) return null;

  const selectedTasks = allTasks.filter(t => selectedIds.has(t.id));

  const runBulk = async (fn: () => Promise<void>) => {
    setIsLoading(true);
    try {
      await fn();
      onClearSelection();
    } catch {
      toast.error(t('error.operationFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleBulkStatus = async (statusId: string) => {
    if (!statusId) return;
    setStatusVal('');
    await runBulk(async () => {
      // Each task follows the same rules as a single change; ones that need approval,
      // have one pending, or miss a required status are left for the user to open.
      const changes = selectedTasks.map(task => ({ task, gate: statusGate.check(task, statusId) }));
      const direct = changes.filter(change => change.gate.kind === 'direct').map(change => change.task);
      const skipped = changes.filter(change => change.gate.kind !== 'direct' && change.gate.kind !== 'same').length;
      const results = await Promise.all(direct.map(task => updateTaskInDb(task.id, statusChangeUpdates(task, statuses, statusId))));
      const failed = results.filter(result => result === false).length;
      if (skipped) toast.warning(t('bulkAction.statusSkipped', { count: skipped }), { duration: 10000 });
      if (failed) toast.error(t('bulkAction.statusPartialFailed', { count: failed }));
      const statusName = statuses.find(s => s.id === statusId)?.name || statusId;
      if (currentMemberId && direct.length > failed) {
        await logActivity(currentMemberId, 'bulk_update_status', t('activity.bulkUpdateStatus', { statusName, count: direct.length - failed }));
      }
    });
  };

  const handleBulkAssign = async (val: string) => {
    if (!val) return;
    setAssigneeVal('');
    const assigneeId = val === '__clear__' ? undefined : val;
    await runBulk(async () => {
      const results = await Promise.all(selectedTasks.map(task => updateTaskInDb(task.id, { assigneeId })));
      const failed = results.filter(result => result === false).length;
      if (failed) toast.error(t('bulkAction.partialFailed', { count: failed }));
      // The new assignee hears about each saved task in their inbox; Slack is skipped so one action does not flood the channel.
      selectedTasks.forEach((task, index) => { if (results[index] !== false) announceAssignment(task, assigneeId, announcements, { slack: false }); });
      const userName = assigneeId ? (users.find(u => u.id === assigneeId)?.name ?? t('common.unknown')) : t('common.unassigned');
      if (currentMemberId && count > failed) {
        await logActivity(currentMemberId, 'bulk_assign', t('activity.bulkAssign', { userName, count: count - failed }));
      }
    });
  };

  const handleBulkPriority = async (priority: string) => {
    if (!priority) return;
    setPriorityVal('');
    await runBulk(async () => {
      const results = await Promise.all(selectedTasks.map(task => updateTaskInDb(task.id, { priority: priority as Priority })));
      const failed = results.filter(result => result === false).length;
      if (failed) toast.error(t('bulkAction.partialFailed', { count: failed }));
      const priorityLabel = t(`priority.${priority}`);
      if (currentMemberId && count > failed) {
        await logActivity(currentMemberId, 'bulk_update_priority', t('activity.bulkUpdatePriority', { priorityLabel, count: count - failed }));
      }
    });
  };

  // Deleting is permanent: comments, attachments and specs go with the task, so no
  // undo is offered (a re-created row would come back without them).
  const handleBulkDeleteConfirm = async () => {
    setDeleteDialogOpen(false);
    const tasksToDelete = [...selectedTasks];
    await runBulk(async () => {
      const ids = tasksToDelete.map(t => t.id);
      const { error } = await supabase.from('tasks').delete().in('id', ids);
      if (error) throw error;
      setAllTasks(prev => prev.filter(t => !ids.includes(t.id)).map(t => t.parentTaskId && ids.includes(t.parentTaskId) ? { ...t, parentTaskId: undefined } : t));
      if (currentMemberId) for (const task of tasksToDelete) await logActivity(currentMemberId, 'delete_task', task.title, task.id, task.taskKey);
      toast.success(t('bulkAction.deletedCount', { count: ids.length }));
    });
  };

  const selectCls = 'text-[13px] border border-border rounded px-2 py-1 bg-white dark:bg-card focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 cursor-pointer';

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap px-3 py-2 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg">
        {isLoading && <Loader2 size={14} className="animate-spin text-blue-600 flex-shrink-0" />}
        <span className="text-[13px] font-semibold text-blue-700 dark:text-blue-300 flex-shrink-0">
          {t('bulkAction.selectedCount', { count })}
        </span>

        <div className="flex items-center gap-1.5 flex-wrap">
          <SearchableSelect
            value={statusVal}
            onChange={e => handleBulkStatus(e.target.value)}
            disabled={isLoading}
            className={selectCls}
          >
            <option value="" disabled>{t('bulkAction.changeStatus')}</option>
            {statuses.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </SearchableSelect>

          <SearchableSelect
            value={assigneeVal}
            onChange={e => handleBulkAssign(e.target.value)}
            disabled={isLoading}
            className={selectCls}
          >
            <option value="" disabled>{t('bulkAction.assignOwner')}</option>
            <option value="__clear__">{t('bulkAction.clearAssignee')}</option>
            {users.filter(u => u.isActive).map(u => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </SearchableSelect>

          <SearchableSelect
            value={priorityVal}
            onChange={e => handleBulkPriority(e.target.value)}
            disabled={isLoading}
            className={selectCls}
          >
            <option value="" disabled>{t('bulkAction.changePriority')}</option>
            {(Object.keys(priorityConfig) as Priority[]).map(k => (
              <option key={k} value={k}>{t(`priority.${k}`)}</option>
            ))}
          </SearchableSelect>

          {permissions.canDeleteTask && (
            <button
              onClick={() => setDeleteDialogOpen(true)}
              disabled={isLoading}
              className="flex items-center gap-1 text-[13px] px-2 py-1 rounded text-destructive border border-destructive/40 hover:bg-destructive/10 transition-colors disabled:opacity-50"
            >
              <Trash2 size={13} />
              {t('common.delete')}
            </button>
          )}
        </div>

        <button
          onClick={onClearSelection}
          className="ml-auto flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
        >
          <X size={14} />
          {t('bulkAction.deselectAll')}
        </button>
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('bulkAction.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('bulkAction.deleteConfirmMessage', { count })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('button.confirmDelete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
});

BulkActionBar.displayName = 'BulkActionBar';

export default BulkActionBar;
