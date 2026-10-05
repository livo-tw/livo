import { Plus, Trash2, FileText } from 'lucide-react';
import { ColoredStatusSelect } from '@/components/ui/colored-status-select';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { usePortalConfirmDialog } from '@/components/PortalConfirmDialog';
import type { TaskDetailState } from './hooks/useTaskDetail';
import TaskSidebarFields from './TaskSidebarFields';
import { useStatusChangeGate } from '@/hooks/useStatusChangeGate';
import { statusChangeUpdates } from '@/lib/taskStatusChange';
import { announceStatusChange } from '@/lib/taskAnnouncements';
import { useTaskAnnouncements } from '@/hooks/useTaskAnnouncements';
import type { Task } from '@/types';
import { canDeleteTaskRecord } from '@/lib/permissions';

type Props = { detail: TaskDetailState };

const TaskSubtasksTab = ({ detail }: Props) => {
  const { t } = useTranslation();
  const { confirm, ConfirmDialog } = usePortalConfirmDialog();
  const statusGate = useStatusChangeGate();
  const announcements = useTaskAnnouncements();
  const {
    task, allTasks, setAllTasks, statuses, users,
    newSubtaskTitle, setNewSubtaskTitle,
    subtaskInputRef, subtaskStatusPickerId, setSubtaskStatusPickerId,
    handleCreateSubtask, setSelectedTask,
    updateTaskInDb, isMobile, currentMember,
  } = detail;

  if (!task) return null;

  // Same rules as the board and the detail view; a sub-task that needs approval is opened to submit it there.
  const changeSubtaskStatus = async (sub: Task, statusId: string) => {
    setSubtaskStatusPickerId(null);
    const gate = statusGate.check(sub, statusId);
    if (gate.kind === 'same') return;
    const refusal = statusGate.refusal(gate, statusId);
    if (refusal) { toast.error(refusal); return; }
    if (gate.kind === 'approval') { toast.info(t('taskDetail.subtasks.approvalInDetail')); setSelectedTask(sub); return; }
    const updates = statusChangeUpdates(sub, statuses, statusId);
    setAllTasks(prev => prev.map(item => item.id === sub.id ? { ...item, ...updates } : item));
    if ((await updateTaskInDb(sub.id, updates)) === false) return;
    announceStatusChange(sub, sub.statusId, statusId, announcements);
  };

  const subtasks = allTasks.filter(t => t.parentTaskId === task.id);
  const doneCount = subtasks.filter(t => statuses.find(s => s.id === t.statusId)?.isDone).length;

  return (
    <div>
      {subtasks.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-medium text-foreground">{t('taskDetail.subtasks.progress')}</span>
            <span className="text-sm text-muted-foreground">{t('taskDetail.subtasks.completion', { done: doneCount, total: subtasks.length })}</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2">
            <div className="bg-primary h-2 rounded-full transition-all" style={{ width: `${(doneCount / subtasks.length) * 100}%` }} />
          </div>
        </div>
      )}

      {subtasks.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">{t('taskDetail.subtasks.empty')}</p>
      )}

      <div className="space-y-1.5 mb-4">
        {subtasks.map(sub => {
          const subStatus = statuses.find(s => s.id === sub.statusId);
          const subAssignee = users.find(u => u.id === sub.assigneeId);
          const isDone = subStatus?.isDone ?? false;
          const isStatusPickerOpen = subtaskStatusPickerId === sub.id;
          const isSubOverdue = sub.dueDate && new Date(sub.dueDate) < new Date() && !sub.completedAt;
          return (
            <div
              key={sub.id}
              onClick={() => setSelectedTask(sub)}
              className="relative flex items-center gap-2 p-2 rounded border border-border hover:border-primary hover:bg-accent/50 transition-all group cursor-pointer"
            >
              <div className="relative flex-shrink-0" data-subtask-status-picker onClick={e => e.stopPropagation()}>
                {statuses.length > 5 ? <ColoredStatusSelect variant="dot" label={t('taskDetail.subtasks.changeStatus')}
                  value={sub.statusId} options={statuses.map(item => ({ value: item.id, label: item.name, color: item.color }))}
                  onValueChange={statusId => changeSubtaskStatus(sub, statusId)} /> : <>
                <button
                  type="button"
                  onClick={() => setSubtaskStatusPickerId(isStatusPickerOpen ? null : sub.id)}
                  className="w-2.5 h-2.5 rounded-full block hover:opacity-75 transition-opacity"
                  style={{ backgroundColor: subStatus?.color || '#6B778C' }}
                  title={t('taskDetail.subtasks.changeStatus')}
                />
                {isStatusPickerOpen && (
                  <div className="absolute left-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-lg py-1 min-w-[130px]" data-subtask-status-picker>
                    {statuses.map(s => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => changeSubtaskStatus(sub, s.id)}
                        className={`w-full text-left px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 hover:bg-accent transition-colors ${s.id === sub.statusId ? 'bg-accent' : ''}`}
                      >
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                        <span style={{ color: s.color }}>{s.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                </>}
              </div>
              <div
                className={`text-sm flex-1 text-left truncate transition-colors ${isDone ? 'line-through text-muted-foreground' : 'text-foreground group-hover:text-primary'}`}
                title={`${sub.taskKey}: ${sub.title}`}
              >
                <span className="text-xs text-muted-foreground mr-1.5">{sub.taskKey}</span>
                {sub.title}
              </div>
              {sub.dueDate && (
                <span className={`text-[10px] flex-shrink-0 ${isSubOverdue ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
                  {new Date(sub.dueDate).getMonth() + 1}/{new Date(sub.dueDate).getDate()}
                </span>
              )}
              {subAssignee && (
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0" style={{ backgroundColor: subAssignee.color, color: '#fff' }} title={subAssignee.name}>
                  {subAssignee.avatar}
                </div>
              )}
              {canDeleteTaskRecord(sub, currentMember, statuses) && (
                <button
                  type="button"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!(await confirm({ description: t('taskDetail.subtasks.deleteConfirm', { title: sub.title }), title: t('taskDetail.subtasks.deleteTitle'), destructive: true }))) return;
                    const { data, error } = await supabase.from('tasks').delete().eq('id', sub.id).select('id');
                    if (error) { toast.error(t('error.deleteFailed') + error.message); return; }
                    // The server deletes nothing when the creator's task has meanwhile been picked up.
                    if (!data?.length) { toast.error(t('task.deleteNotAllowed')); return; }
                    setAllTasks(prev => prev.filter(t => t.id !== sub.id));
                    toast.success(t('task.deleted'));
                  }}
                  className="opacity-0 group-hover:opacity-100 flex-shrink-0 text-muted-foreground hover:text-destructive transition-all"
                  title={t('taskDetail.subtasks.deleteTitle')}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex gap-1.5">
        <input
          ref={subtaskInputRef}
          type="text"
          value={newSubtaskTitle}
          onChange={e => setNewSubtaskTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleCreateSubtask(); if (e.key === 'Escape') setNewSubtaskTitle(''); }}
          placeholder={t('taskDetail.subtasks.newPlaceholder')}
          className="flex-1 text-sm border border-border rounded px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-primary bg-card text-foreground placeholder:text-muted-foreground/50"
        />
        <button
          type="button"
          onClick={handleCreateSubtask}
          disabled={!newSubtaskTitle.trim()}
          className={`px-3 py-1.5 rounded text-sm font-medium transition-colors flex-shrink-0 ${newSubtaskTitle.trim() ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-muted text-muted-foreground cursor-not-allowed'}`}
        >
          <Plus size={14} />
        </button>
      </div>

      {isMobile && (
        <div className="border-t border-border pt-4 mt-4">
          <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1"><FileText size={16} /> {t('task.properties')}</h4>
          <TaskSidebarFields detail={detail} />
        </div>
      )}
      {ConfirmDialog}
    </div>
  );
};

export default TaskSubtasksTab;
