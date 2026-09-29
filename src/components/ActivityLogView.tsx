import { useState, useEffect, useMemo, useCallback } from 'react';
import { useMemberContext } from '@/context/MemberContext';
import { useTaskContext } from '@/context/TaskContext';
import { useUIContext } from '@/context/UIContext';
import { supabase } from '@/integrations/supabase/client';
import { Clock, User, List, ExternalLink, ClipboardList } from 'lucide-react';
import type { ActivityLog } from '@/lib/activityLog';
import { useTranslation } from 'react-i18next';

const ACTION_LABEL_KEYS: Record<string, string> = {
  create_task: 'activity.createTask',
  update_title: 'activity.updateTitle',
  update_status: 'activity.updateStatus',
  update_priority: 'activity.updatePriority',
  update_assignee: 'activity.updateAssignee',
  update_reviewer: 'activity.updateReviewer',
  update_project: 'activity.updateProject',
  update_due_date: 'activity.updateDueDate',
  update_department: 'activity.updateDepartment',
  update_spec: 'activity.updateSpec',
  add_comment: 'activity.addComment',
  delete_comment: 'activity.deleteComment',
  add_check: 'activity.addCheck',
  toggle_check: 'activity.toggleCheck',
  delete_check: 'activity.deleteCheck',
  add_todo: 'activity.addTodo',
  toggle_todo: 'activity.toggleTodo',
  delete_todo: 'activity.deleteTodo',
  upload_file: 'activity.uploadFile',
  delete_file: 'activity.deleteFile',
  delete_task: 'activity.deleteTask',
  login: 'activity.login',
  logout: 'activity.logout',
  update_deploy: 'activity.updateDeploy',
  complete_sprint: 'activityLog.completeSprint',
  start_sprint: 'activityLog.startSprint',
  start_standup: 'activityLog.startStandup',
  gantt_date_change: 'activityLog.ganttDateChange',
  cleanup_logs: 'activityLog.cleanupLogs',
  manual_backup: 'activityLog.manualBackup',
  import_jira: 'activityLog.importJira',
  restore_backup: 'activityLog.restoreBackup',
  add_member: 'activityLog.addMember',
  delete_member: 'activityLog.deleteMember',
  change_role: 'activityLog.changeRole',
  toggle_member: 'activityLog.toggleMember',
  reset_password: 'activityLog.resetPassword',
  add_status: 'activityLog.addStatus',
  update_status_name: 'activityLog.updateStatusName',
  delete_status: 'activityLog.deleteStatus',
  add_product_line: 'activityLog.addProductLine',
  update_product_line: 'activityLog.updateProductLine',
  add_project: 'activityLog.addProject',
  update_project_info: 'activityLog.updateProjectInfo',
  delete_project: 'activityLog.deleteProject',
  update_team_intro: 'activityLog.updateTeamIntro',
};

const formatTime = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const ActivityLogView = () => {
  const { t } = useTranslation();
  const { users } = useMemberContext();
  const { allTasks } = useTaskContext();
  const { setSelectedTask } = useUIContext();
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [viewMode, setViewMode] = useState<'timeline' | 'by-user'>('timeline');
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadLogs = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('activity_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1000);
    setLogs((data as ActivityLog[]) || []);
    setLoading(false);
  };

  useEffect(() => {
    loadLogs();
    const channel = supabase
      .channel('activity-logs-admin')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_logs' }, () => {
        loadLogs();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  // Group logs by user, max 50 per user
  const logsByUser = useMemo(() => {
    const map: Record<string, ActivityLog[]> = {};
    logs.forEach(log => {
      if (!map[log.user_id]) map[log.user_id] = [];
      if (map[log.user_id].length < 50) {
        map[log.user_id].push(log);
      }
    });
    return map;
  }, [logs]);

  const activeUsers = useMemo(() => {
    const userIds = Object.keys(logsByUser);
    return users.filter(u => userIds.includes(u.id)).sort((a, b) => a.sortOrder - b.sortOrder);
  }, [logsByUser, users]);

  // Timeline: all logs, limited to latest 200
  const timelineLogs = useMemo(() => logs.slice(0, 200), [logs]);

  const displayLogs = viewMode === 'timeline'
    ? timelineLogs
    : selectedUserId
      ? (logsByUser[selectedUserId] || [])
      : [];

  const handleOpenTask = useCallback((taskId: string) => {
    const task = allTasks.find(t => t.id === taskId);
    if (task) setSelectedTask(task);
  }, [allTasks, setSelectedTask]);

  const renderLogItem = (log: ActivityLog) => {
    const user = users.find(u => u.id === log.user_id);
    const actionLabelKey = ACTION_LABEL_KEYS[log.action];
    const actionLabel = actionLabelKey ? t(actionLabelKey) : log.action;
    return (
      <div key={log.id} className="flex items-start gap-3 py-2.5 border-b border-border last:border-0">
        <div
          className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-[9px] font-bold text-white mt-0.5"
          style={{ backgroundColor: user?.color || '#6B778C' }}
        >
          {user?.avatar || '?'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground">{user?.name || log.user_id}</span>
            <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">{actionLabel}</span>
            {log.task_key && log.task_id && (
              <button
                onClick={() => handleOpenTask(log.task_id!)}
                className="text-xs font-bold text-primary hover:underline cursor-pointer inline-flex items-center gap-0.5"
                title={t('activityLog.openCard')}
              >
                {log.task_key}
                <ExternalLink size={10} />
              </button>
            )}
            {log.task_key && !log.task_id && (
              <span className="text-xs font-bold text-primary">{log.task_key}</span>
            )}
          </div>
          {log.detail && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{log.detail}</p>
          )}
          <span className="text-[10px] text-muted-foreground/60">{formatTime(log.created_at)}</span>
        </div>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border flex-shrink-0">
        <h2 className="text-lg font-bold text-foreground flex items-center gap-2"><ClipboardList size={20} /> {t('activityLog.pageTitle')}</h2>
        <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
          <button
            onClick={() => setViewMode('timeline')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              viewMode === 'timeline' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Clock size={14} />
            {t('activityLog.timelineMode')}
          </button>
          <button
            onClick={() => setViewMode('by-user')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              viewMode === 'by-user' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <User size={14} />
            {t('activityLog.byUserMode')}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex">
        {/* User list sidebar for by-user mode */}
        {viewMode === 'by-user' && (
          <div className="w-[200px] border-r border-border overflow-y-auto flex-shrink-0">
            <div className="p-2">
              {activeUsers.map(user => (
                <button
                  key={user.id}
                  onClick={() => setSelectedUserId(user.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                    selectedUserId === user.id
                      ? 'bg-primary/10 text-primary font-semibold'
                      : 'text-foreground hover:bg-accent'
                  }`}
                >
                  <div
                    className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[8px] font-bold text-white"
                    style={{ backgroundColor: user.color }}
                  >
                    {user.avatar}
                  </div>
                  <span className="truncate">{user.name}</span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {logsByUser[user.id]?.length || 0}
                  </span>
                </button>
              ))}
              {activeUsers.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">{t('activityLog.noRecords')}</p>
              )}
            </div>
          </div>
        )}

        {/* Log list */}
        <div className="flex-1 overflow-y-auto px-5 py-2">
          {loading ? (
            <p className="text-sm text-muted-foreground text-center py-8">{t('common.loading')}</p>
          ) : displayLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {viewMode === 'by-user' && !selectedUserId ? t('activityLog.selectAccount') : t('activity.noLogs')}
            </p>
          ) : (
            displayLogs.map(renderLogItem)
          )}
        </div>
      </div>
    </div>
  );
};

export default ActivityLogView;
