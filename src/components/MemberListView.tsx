import { useMemberContext } from '@/context/MemberContext';
import { useTaskContext } from '@/context/TaskContext';
import { useAuthContext } from '@/context/AuthContext';
import { getRoleLabel, getRoleColor, type MemberRole } from '@/lib/permissions';
import { Users } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { sortUsersByDept } from '@/lib/department';
import { useTranslation } from 'react-i18next';

const MemberListView = () => {
  const { t } = useTranslation();
  const { users } = useMemberContext();
  const { allTasks, comments, statusLogs } = useTaskContext();
  const { permissions } = useAuthContext();
  const isMobile = useIsMobile();

  if (!permissions.canViewMemberList) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground">{t('error.noPermission')}</div>;
  }

  const memberStats = sortUsersByDept(users).map(user => {
    const assignedTasks = allTasks.filter(t => t.assigneeId === user.id);
    const userComments = comments.filter(c => c.userId === user.id);
    const userStatusChanges = statusLogs.filter(l => l.changedBy === user.id);
    const commentDates = userComments.map(c => new Date(c.createdAt).getTime());
    const statusDates = userStatusChanges.map(l => new Date(l.changedAt).getTime());
    const allDates = [...commentDates, ...statusDates];
    const lastActivity = allDates.length > 0 ? new Date(Math.max(...allDates)) : null;
    return {
      user,
      assignedCount: assignedTasks.length,
      completedCount: assignedTasks.filter(t => t.completedAt).length,
      commentCount: userComments.length,
      lastActivity,
    };
  });

  const formatDate = (d: Date | null) => {
    if (!d) return '—';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-4 py-6 md:px-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-2 mb-4 md:mb-6">
          <Users size={20} className="text-primary" />
          <h1 className="text-xl md:text-2xl font-bold text-foreground">{t('memberList.title')}</h1>
          <span className="text-xs text-muted-foreground ml-2">{t('memberList.totalCount', { count: users.length })}</span>
        </div>

        {isMobile ? (
          <div className="space-y-2">
            {memberStats.map(({ user, assignedCount, completedCount, commentCount, lastActivity }) => (
              <div key={user.id} className="border border-border rounded-lg p-3 bg-card">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-bold text-white" style={{ backgroundColor: user.color }}>{user.avatar}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">{user.name}</div>
                    <div className="text-[10px] text-muted-foreground">{user.jobTitle || '—'}</div>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium text-white" style={{ backgroundColor: getRoleColor(user.role as MemberRole) }}>
                    {getRoleLabel(user.role as MemberRole)}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                  <span>{t('memberList.assigned')} <strong className="text-foreground">{assignedCount}</strong></span>
                  <span>{t('memberList.completed')} <strong className={completedCount > 0 ? 'text-emerald-500' : undefined}>{completedCount}</strong></span>
                  <span>{t('memberList.comments')} <strong className="text-foreground">{commentCount}</strong></span>
                  <span className="ml-auto">{formatDate(lastActivity)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="border border-border rounded-lg shadow-sm overflow-hidden bg-card">
            <table className="w-full">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">{t('memberList.memberHeader')}</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">{t('memberList.emailHeader')}</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">{t('memberList.jobTitleHeader')}</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">{t('memberList.roleHeader')}</th>
                  <th className="text-center text-xs font-medium text-muted-foreground px-4 py-3">{t('memberList.assignedHeader')}</th>
                  <th className="text-center text-xs font-medium text-muted-foreground px-4 py-3">{t('memberList.completedHeader')}</th>
                  <th className="text-center text-xs font-medium text-muted-foreground px-4 py-3">{t('memberList.commentsHeader')}</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-3">{t('memberList.lastActivityHeader')}</th>
                </tr>
              </thead>
              <tbody>
                {memberStats.map(({ user, assignedCount, completedCount, commentCount, lastActivity }) => (
                  <tr key={user.id} className="border-t border-border hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-bold text-white" style={{ backgroundColor: user.color }}>{user.avatar}</div>
                        <span className="text-sm font-medium text-foreground">{user.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{user.email || '—'}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{user.jobTitle || '—'}</td>
                    <td className="px-4 py-3">
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-medium text-white" style={{ backgroundColor: getRoleColor(user.role as MemberRole) }}>
                        {getRoleLabel(user.role as MemberRole)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center text-xs text-foreground">{assignedCount}</td>
                    <td className="px-4 py-3 text-center text-xs text-foreground">
                      <span className={completedCount > 0 ? 'text-emerald-500' : undefined}>{completedCount}</span>
                    </td>
                    <td className="px-4 py-3 text-center text-xs text-foreground">{commentCount}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{lastActivity ? `${lastActivity.getFullYear()}-${String(lastActivity.getMonth() + 1).padStart(2, '0')}-${String(lastActivity.getDate()).padStart(2, '0')} ${String(lastActivity.getHours()).padStart(2, '0')}:${String(lastActivity.getMinutes()).padStart(2, '0')}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </div>
    </div>
  );
};

export default MemberListView;
