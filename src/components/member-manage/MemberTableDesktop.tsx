import { GripVertical, UserMinus, UserCheck, Trash2, Lock, KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getRoleLabel, getRoleColor, type MemberRole } from '@/lib/permissions';

interface StatusNode { id: string; name: string; }

interface MemberStat {
  user: {
    id: string; name: string; avatar: string; color: string;
    email?: string; jobTitle?: string; role: string; isActive?: boolean;
  };
  assignedCount: number;
  completedCount: number;
  commentCount: number;
  lastActivity: Date | null;
}

interface MemberTableDesktopProps {
  memberStats: MemberStat[];
  currentMemberId: string;
  isSuperAdmin: boolean;
  canReorder: boolean;
  dragIndex: number | null;
  dragOverIndex: number | null;
  actionLoading: string | null;
  isLockedBy: (key: string) => { name: string } | null;
  formatDate: (d: Date | null) => string;
  onDragStart: (index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDragEnd: () => void;
  onRoleChange: (memberId: string, role: MemberRole) => void;
  onToggleActive: (memberId: string, currentActive: boolean) => void;
  onDelete: (memberId: string, name: string) => void;
  onResetPassword: (memberId: string, name: string) => void;
}

const ROLES: MemberRole[] = ['super_admin', 'admin', 'member'];

const MemberTableDesktop = ({
  memberStats, currentMemberId, isSuperAdmin, canReorder,
  dragIndex, dragOverIndex, actionLoading, isLockedBy, formatDate,
  onDragStart, onDragOver, onDragEnd, onRoleChange, onToggleActive, onDelete, onResetPassword,
}: MemberTableDesktopProps) => {
  const { t } = useTranslation();
  return (
  <div className="border border-border rounded-lg overflow-x-auto">
    <table className="w-full text-sm">
      <thead>
        <tr className="bg-muted/50">
          {canReorder && <th className="w-8"></th>}
          <th className="text-left font-medium text-muted-foreground px-4 py-3 whitespace-nowrap">{t('memberList.memberHeader')}</th>
          <th className="text-left font-medium text-muted-foreground px-4 py-3 whitespace-nowrap max-w-[180px]">Email</th>
          <th className="text-left font-medium text-muted-foreground px-4 py-3 whitespace-nowrap">{t('memberList.jobTitleHeader')}</th>
          <th className="text-left font-medium text-muted-foreground px-4 py-3 whitespace-nowrap min-w-[90px]">{t('memberList.roleHeader')}</th>
          <th className="text-center font-medium text-muted-foreground px-2 py-3 whitespace-nowrap w-14">{t('memberList.assignedHeader')}</th>
          <th className="text-center font-medium text-muted-foreground px-2 py-3 whitespace-nowrap w-14">{t('memberList.completedHeader')}</th>
          <th className="text-center font-medium text-muted-foreground px-2 py-3 whitespace-nowrap w-14">{t('memberList.commentsHeader')}</th>
          <th className="text-left font-medium text-muted-foreground px-3 py-3 whitespace-nowrap">{t('memberList.lastActivityHeader')}</th>
          {isSuperAdmin && (
            <>
              <th className="text-left font-medium text-muted-foreground px-3 py-3 whitespace-nowrap min-w-[64px]">{t('memberList.statusHeader')}</th>
              <th className="text-left font-medium text-muted-foreground px-3 py-3 whitespace-nowrap min-w-[120px]">{t('memberList.changeRoleHeader')}</th>
              <th className="text-center font-medium text-muted-foreground px-3 py-3 whitespace-nowrap w-20">{t('memberList.actionsHeader')}</th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {memberStats.map(({ user, assignedCount, completedCount, commentCount, lastActivity }, index) => {
          const isActive = user.isActive !== false;
          return (
            <tr
              key={user.id}
              data-drag-index={index}
              draggable={!!canReorder}
              onDragStart={() => onDragStart(index)}
              onDragOver={e => onDragOver(e, index)}
              onDragEnd={onDragEnd}
              className={`border-t border-border hover:bg-muted/20 transition-colors ${!isActive ? 'opacity-50' : ''} ${dragIndex === index ? 'opacity-40' : ''} ${dragOverIndex === index && dragIndex !== index ? 'bg-primary/10' : ''}`}
            >
              {canReorder && (
                <td className="px-2 py-3">
                  <GripVertical size={14} className="text-muted-foreground cursor-grab" />
                </td>
              )}
              <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0" style={{ backgroundColor: user.color }}>{user.avatar}</div>
                  <div>
                    <span className="text-sm font-medium text-foreground">{user.name}</span>
                    {user.id === currentMemberId && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">{t('memberList.youBadge')}</span>}
                    {(() => { const locker = isLockedBy(`member-${user.id}`); return locker ? <span className="ml-1.5 text-xs text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded animate-pulse flex items-center gap-1 inline-flex"><Lock size={12} /> {locker.name} {t('memberList.operating')}</span> : null; })()}
                  </div>
                </div>
              </td>
              <td className="px-4 py-3 text-muted-foreground max-w-[180px] truncate">{user.email || '—'}</td>
              <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{user.jobTitle || '—'}</td>
              <td className="px-4 py-3 whitespace-nowrap">
                <span className="text-xs px-2 py-0.5 rounded-full font-medium text-white" style={{ backgroundColor: getRoleColor(user.role as MemberRole) }}>
                  {getRoleLabel(user.role as MemberRole)}
                </span>
              </td>
              <td className="px-2 py-3 text-center text-foreground">{assignedCount}</td>
              <td className="px-2 py-3 text-center text-foreground">
                <span className={completedCount > 0 ? 'text-emerald-500' : undefined}>{completedCount}</span>
              </td>
              <td className="px-2 py-3 text-center text-foreground">{commentCount}</td>
              <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">{lastActivity ? formatDate(lastActivity) : '—'}</td>
              {isSuperAdmin && (
                <>
                  <td className="px-3 py-3 whitespace-nowrap">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${isActive ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>
                      {isActive ? t('memberList.statusActive') : t('memberList.statusInactive')}
                    </span>
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">
                    <select
                      value={user.role}
                      onChange={e => onRoleChange(user.id, e.target.value as MemberRole)}
                      disabled={user.id === currentMemberId}
                      className="text-xs border border-border rounded px-2 py-1 bg-card text-foreground outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 min-w-[100px]"
                    >
                      {ROLES.map(r => <option key={r} value={r}>{getRoleLabel(r)}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center justify-center gap-1">
                      {user.id !== currentMemberId && (
                        <>
                          <button
                            onClick={() => onToggleActive(user.id, isActive)}
                            disabled={actionLoading === user.id}
                            className={`p-1.5 rounded transition-colors ${isActive ? 'hover:bg-orange-100 dark:hover:bg-orange-900/30 text-orange-600' : 'hover:bg-green-100 dark:hover:bg-green-900/30 text-green-600'}`}
                          >
                            {isActive ? <UserMinus size={14} /> : <UserCheck size={14} />}
                          </button>
                          <button
                            onClick={() => onResetPassword(user.id, user.name)}
                            disabled={actionLoading === user.id}
                            title={t('member.resetPassword')}
                            className="p-1.5 rounded hover:bg-blue-100 dark:hover:bg-blue-900/30 text-blue-600 transition-colors"
                          >
                            <KeyRound size={14} />
                          </button>
                          <button
                            onClick={() => onDelete(user.id, user.name)}
                            disabled={actionLoading === user.id}
                            className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-destructive transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
  );
};

export default MemberTableDesktop;
