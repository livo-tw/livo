import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TaskDetailState } from './hooks/useTaskDetail';
import TaskSidebarFields from './TaskSidebarFields';

const ACTION_KEYS: Record<string, string> = {
  create_task: 'activity.createTask', update_title: 'activity.updateTitle', update_status: 'activity.updateStatus',
  update_priority: 'activity.updatePriority', update_assignee: 'activity.updateAssignee', update_reviewer: 'activity.updateReviewer',
  update_project: 'activity.updateProject', update_due_date: 'activity.updateDueDate', update_department: 'activity.updateDepartment',
  update_spec: 'activity.updateSpec', add_comment: 'activity.addComment', delete_comment: 'activity.deleteComment',
  add_check: 'activity.addCheck', toggle_check: 'activity.toggleCheck', delete_check: 'activity.deleteCheck',
  add_todo: 'activity.addTodo', toggle_todo: 'activity.toggleTodo', delete_todo: 'activity.deleteTodo',
  upload_file: 'activity.uploadFile', delete_file: 'activity.deleteFile', delete_task: 'activity.deleteTask',
  update_deploy: 'activity.updateDeploy',
};

type Props = { detail: TaskDetailState };

const TaskActivityTab = ({ detail }: Props) => {
  const { t } = useTranslation();
  const { taskActivityLogs, users, isMobile } = detail;

  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    <div className="space-y-1">
      {taskActivityLogs.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">{t('activity.noLogs')}</p>
      ) : (
        taskActivityLogs.map(log => {
          const user = users.find(u => u.id === log.user_id);
          const actionKey = ACTION_KEYS[log.action];
          const actionLabel = actionKey ? t(actionKey) : log.action;
          const d = new Date(log.created_at);
          const timeStr = isNaN(d.getTime())
            ? log.created_at
            : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
          return (
            <div key={log.id} className="flex items-start gap-2.5 py-2 border-b border-border last:border-0">
              <div className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[8px] font-bold text-white mt-0.5" style={{ backgroundColor: user?.color || '#6B778C' }}>
                {user?.avatar || '?'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm font-medium text-foreground">{user?.name || log.user_id}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">{actionLabel}</span>
                </div>
                {log.detail && <p className="text-xs text-muted-foreground mt-0.5">{log.detail}</p>}
                <span className="text-[10px] text-muted-foreground/60">{timeStr}</span>
              </div>
            </div>
          );
        })
      )}

      {isMobile && (
        <div className="border-t border-border pt-4 mt-4">
          <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1"><FileText size={16} /> {t('task.properties')}</h4>
          <TaskSidebarFields detail={detail} />
        </div>
      )}
    </div>
  );
};

export default TaskActivityTab;
