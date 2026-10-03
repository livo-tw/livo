import { SearchableSelect } from '@/components/ui/searchable-select';
import { useState, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTaskContext } from '@/context/TaskContext';
import { useMemberContext } from '@/context/MemberContext';
import { useAuthContext } from '@/context/AuthContext';
import { logActivity } from '@/lib/activityLog';
import { deadlineTaskFields } from '@/lib/taskPlanning/client';
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
import { useUndoStack } from '@/hooks/useUndoStack';

interface BulkActionBarProps {
  selectedIds: Set<string>;
  onClearSelection: () => void;
}

export const BulkActionBar = memo(({ selectedIds, onClearSelection }: BulkActionBarProps) => {
  const { t } = useTranslation();
  const { allTasks, statuses, updateTaskInDb, setAllTasks } = useTaskContext();
  const { users } = useMemberContext();
  const { currentMemberId, permissions } = useAuthContext();
  const undoStack = useUndoStack();
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
      await Promise.all(selectedTasks.map(t => updateTaskInDb(t.id, { statusId })));
      const statusName = statuses.find(s => s.id === statusId)?.name || statusId;
      if (currentMemberId) {
        await logActivity(currentMemberId, 'bulk_update_status', t('activity.bulkUpdateStatus', { statusName, count }));
      }
    });
  };

  const handleBulkAssign = async (val: string) => {
    if (!val) return;
    setAssigneeVal('');
    const assigneeId = val === '__clear__' ? undefined : val;
    await runBulk(async () => {
      await Promise.all(selectedTasks.map(t => updateTaskInDb(t.id, { assigneeId })));
      const userName = assigneeId ? (users.find(u => u.id === assigneeId)?.name ?? t('common.unknown')) : t('common.unassigned');
      if (currentMemberId) {
        await logActivity(currentMemberId, 'bulk_assign', t('activity.bulkAssign', { userName, count }));
      }
    });
  };

  const handleBulkPriority = async (priority: string) => {
    if (!priority) return;
    setPriorityVal('');
    await runBulk(async () => {
      await Promise.all(selectedTasks.map(t => updateTaskInDb(t.id, { priority: priority as Priority })));
      const priorityLabel = priorityConfig[priority as Priority]?.label ?? priority;
      if (currentMemberId) {
        await logActivity(currentMemberId, 'bulk_update_priority', t('activity.bulkUpdatePriority', { priorityLabel, count }));
      }
    });
  };

  const handleBulkDeleteConfirm = async () => {
    setDeleteDialogOpen(false);
    const tasksToDelete = [...selectedTasks];
    await runBulk(async () => {
      for (const task of tasksToDelete) {
        if (currentMemberId) {
          await logActivity(currentMemberId, 'delete_task', task.title, task.id, task.taskKey);
        }
      }
      const ids = tasksToDelete.map(t => t.id);
      const { error } = await supabase.from('tasks').delete().in('id', ids);
      if (error) throw error;
      setAllTasks(prev => prev.filter(t => !ids.includes(t.id)));
      undoStack.push({
        type: 'bulk_delete',
        description: t('undo.bulkDeleted', { count: ids.length }),
        undo: async () => {
          const rows = tasksToDelete.map(task => {
            const row: Record<string, unknown> = {
              id: task.id, task_key: task.taskKey,
              project_id: task.projectId, title: task.title,
              status_id: task.statusId, priority: task.priority,
              creator_id: task.creatorId, sort_order: task.sortOrder,
              created_at: task.createdAt,
            };
            if (task.assigneeId) row.assignee_id = task.assigneeId;
            if (task.reviewerId) row.reviewer_id = task.reviewerId;
            if (task.dueDate) row.due_date = task.dueDate;
            row.due_date_kind = task.dueDate ? task.dueDateKind ?? null : null;
            if (task.startedAt) row.started_at = task.startedAt;
            if (task.completedAt) row.completed_at = task.completedAt;
            if (task.sprintId) row.sprint_id = task.sprintId;
            if (task.department) row.department = task.department;
            return row;
          });
          const restored = await supabase.from('tasks').insert(rows).select('id,due_date,due_date_kind,due_date_version,started_at');
          if (restored.error || !restored.data || restored.data.length !== tasksToDelete.length) throw new Error(t('taskPlanning.errors.planning_unavailable'));
          const restoredRows = restored.data;
          setAllTasks(prev => [...prev, ...tasksToDelete.map(task => {
            const saved = restoredRows.find(row => row.id === task.id);
            return saved ? { ...task, ...deadlineTaskFields(saved) } : task;
          })]);
        },
      });
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
            {(Object.entries(priorityConfig) as [Priority, typeof priorityConfig[Priority]][]).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
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
