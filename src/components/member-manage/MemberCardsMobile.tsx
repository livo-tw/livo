import { GripVertical, UserMinus, UserCheck, Trash2, Lock, KeyRound, LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getRoleLabel, getRoleColor, type MemberRole } from '@/lib/permissions';
import { isPlaceholderEmail } from '@/lib/memberEmail';

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

interface MemberCardsMobileProps {
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
  onTouchStart: (index: number, e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  onRoleChange: (memberId: string, role: MemberRole) => void;
  onToggleActive: (memberId: string, currentActive: boolean) => void;
  onDelete: (memberId: string, name: string) => void;
  onResetPassword: (memberId: string, name: string) => void;
  /** 「啟用帳號」 for a member that only has a name (Jira import). */
  onCreateLogin: (memberId: string, name: string) => void;
}

const ROLES: MemberRole[] = ['super_admin', 'admin', 'member'];

const MemberCardsMobile = ({
  memberStats, currentMemberId, isSuperAdmin, canReorder,
  dragIndex, dragOverIndex, actionLoading, isLockedBy, formatDate,
  onDragStart, onDragOver, onDragEnd, onTouchStart, onTouchMove, onTouchEnd,
  onRoleChange, onToggleActive, onDelete, onResetPassword, onCreateLogin,
}: MemberCardsMobileProps) => {
  const { t } = useTranslation();
  return (
  <div className="space-y-2">
    {memberStats.map(({ user, assignedCount, completedCount, commentCount, lastActivity }, index) => {
      const isActive = user.isActive !== false;
      return (
        <div
          key={user.id}
          data-drag-index={index}
          draggable={!!canReorder}
          onDragStart={() => onDragStart(index)}
          onDragOver={e => onDragOver(e, index)}
          onDragEnd={onDragEnd}
          onTouchStart={e => onTouchStart(index, e)}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          className={`border border-border rounded-lg p-3 bg-card ${!isActive ? 'opacity-50' : ''} ${dragIndex === index ? 'opacity-40' : ''} ${dragOverIndex === index && dragIndex !== index ? 'border-primary border-2' : ''} transition-all`}
        >
          <div className="flex items-center gap-2 mb-2">
            {canReorder && <GripVertical size={14} className="text-muted-foreground cursor-grab flex-shrink-0" />}
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-bold text-white" style={{ backgroundColor: user.color }}>{user.avatar}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1">
                <span className="text-sm font-medium text-foreground truncate">{user.name}</span>
                {user.id === currentMemberId && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">{t('memberList.youBadge')}</span>}
                {(() => { const locker = isLockedBy(`member-${user.id}`); return locker ? <span className="text-xs text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded animate-pulse flex items-center gap-1"><Lock size={12} /> {locker.name} {t('memberList.operating')}</span> : null; })()}
              </div>
              <div className="text-[10px] text-muted-foreground truncate">{user.jobTitle || '—'} · {isPlaceholderEmail(user.email) ? t('memberList.noLogin') : user.email}</div>
            </div>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium text-white" style={{ backgroundColor: getRoleColor(user.role as MemberRole) }}>
              {getRoleLabel(user.role as MemberRole)}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            <span>{t('memberList.assigned')} <strong className="text-foreground">{assignedCount}</strong></span>
            <span>{t('memberList.completed')} <strong className={completedCount > 0 ? 'text-emerald-500' : undefined}>{completedCount}</strong></span>
            <span>{t('memberList.comments')} <strong className="text-foreground">{commentCount}</strong></span>
            <span className="ml-auto text-[10px]">{lastActivity ? formatDate(lastActivity) : '—'}</span>
          </div>
          {isSuperAdmin && (
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
              <div className="flex items-center gap-2">
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${isActive ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                  {isActive ? t('memberList.statusActive') : t('memberList.statusInactive')}
                </span>
                <select
                  value={user.role}
                  onChange={e => onRoleChange(user.id, e.target.value as MemberRole)}
                  disabled={user.id === currentMemberId}
                  className="text-xs border border-border rounded px-1.5 py-0.5 bg-card text-foreground outline-none disabled:opacity-50"
                >
                  {ROLES.map(r => <option key={r} value={r}>{getRoleLabel(r)}</option>)}
                </select>
              </div>
              {user.id !== currentMemberId && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onToggleActive(user.id, isActive)}
                    disabled={actionLoading === user.id}
                    className={`p-1.5 rounded transition-colors ${isActive ? 'hover:bg-orange-100 text-orange-600' : 'hover:bg-green-100 text-green-600'}`}
                  >
                    {isActive ? <UserMinus size={14} /> : <UserCheck size={14} />}
                  </button>
                  {isPlaceholderEmail(user.email) ? (
                    <button
                      onClick={() => onCreateLogin(user.id, user.name)}
                      disabled={actionLoading === user.id}
                      title={t('member.createLogin')}
                      aria-label={t('member.createLogin')}
                      className="p-1.5 rounded hover:bg-teal-100 text-teal-600 transition-colors"
                    >
                      <LogIn size={14} />
                    </button>
                  ) : (
                    <button
                      onClick={() => onResetPassword(user.id, user.name)}
                      disabled={actionLoading === user.id}
                      title={t('member.resetPassword')}
                      className="p-1.5 rounded hover:bg-blue-100 text-blue-600 transition-colors"
                    >
                      <KeyRound size={14} />
                    </button>
                  )}
                  <button
                    onClick={() => onDelete(user.id, user.name)}
                    disabled={actionLoading === user.id}
                    className="p-1.5 rounded hover:bg-red-100 text-destructive transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      );
    })}
  </div>
  );
};

export default MemberCardsMobile;
