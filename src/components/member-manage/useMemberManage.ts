import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useMemberContext } from '@/context/MemberContext';
import { useTaskContext } from '@/context/TaskContext';
import { useAuthContext } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { logActivity } from '@/lib/activityLog';
import { selectedMemberRole, selectionRoleLabel, type MemberRoleSelection } from '@/lib/memberRoleSelection';
import { sortUsersByDept } from '@/lib/department';
import { usePresenceLock } from '@/hooks/usePresenceLock';
import { useConfirmDialog } from '@/components/ConfirmDialog';
import type { AccountCredential } from '@/components/AccountCredentialsDialog';
import { callFunction, DEMO_BLOCKED } from '@/lib/callFunction';
import { functionErrorCode } from '@/lib/functionError';

const COLORS = ['#FF5630', '#FF8B00', '#36B37E', '#00B8D9', '#6554C0', '#0065FF', '#6B778C', '#172B4D'];

export function useMemberManage() {
  const { users, refreshUsers } = useMemberContext();
  const { allTasks, comments, statuses } = useTaskContext();
  const { permissions, currentMemberId, currentMember } = useAuthContext();
  const { hasFeature } = useLicense();
  const { viewers, acquireLock, releaseLock, isLockedBy } = usePresenceLock('member-manage-presence', !hasFeature('realtime-collab'));
  const { confirm, ConfirmDialog } = useConfirmDialog();

  const isSuperAdmin = currentMember?.role === 'super_admin';
  const canAddMember = currentMember?.role === 'super_admin' || currentMember?.role === 'admin';
  const canReorder = currentMember && (currentMember.role === 'super_admin' || currentMember.role === 'admin');

  const [showAddModal, setShowAddModal] = useState(false);
  const [addForm, setAddForm] = useState({ email: '', name: '', role: 'member' as MemberRoleSelection, jobTitle: '', password: '' });
  const [addLoading, setAddLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<{ id: string; name: string } | null>(null);
  const [resetForm, setResetForm] = useState({ password: '', confirm: '' });
  const [resetLoading, setResetLoading] = useState(false);
  // 「啟用帳號」: login for a member that only has a name (Jira import)
  const [loginTarget, setLoginTarget] = useState<{ id: string; name: string } | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginCredentials, setLoginCredentials] = useState<AccountCredential[]>([]);
  const [jobTitleOpen, setJobTitleOpen] = useState(false);
  const jobTitleRef = useRef<HTMLDivElement>(null);
  const [jobTitleTarget, setJobTitleTarget] = useState<{ id: string; name: string } | null>(null);
  const [editJobTitle, setEditJobTitle] = useState('');
  const [jobTitleSaving, setJobTitleSaving] = useState(false);
  const [jobTitleError, setJobTitleError] = useState<string | null>(null);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [orderedUsers, setOrderedUsers] = useState(() => sortUsersByDept(users));

  useEffect(() => { setOrderedUsers(sortUsersByDept(users)); }, [users]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (jobTitleRef.current && !jobTitleRef.current.contains(e.target as Node)) setJobTitleOpen(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, []);

  const existingJobTitles = useMemo(() => {
    const titles = users.map(u => u.jobTitle).filter(Boolean);
    return [...new Set(titles)];
  }, [users]);

  const filteredJobTitles = useMemo(() => {
    if (!addForm.jobTitle) return existingJobTitles;
    return existingJobTitles.filter(t => t.toLowerCase().includes(addForm.jobTitle.toLowerCase()));
  }, [existingJobTitles, addForm.jobTitle]);

  const [activityLogs, setActivityLogs] = useState<{ user_id: string; created_at: string }[]>([]);
  useEffect(() => {
    const fetchLogs = async () => {
      const { data } = await supabase
        .from('activity_logs')
        .select('user_id, created_at')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (data) setActivityLogs(data);
    };
    fetchLogs();
  }, []);

  const doneStatusIds = useMemo(() => new Set(statuses.filter(s => s.isDone).map(s => s.id)), [statuses]);

  const memberStats = useMemo(() => {
    return orderedUsers.map(user => {
      const assignedTasks = allTasks.filter(t => t.assigneeId === user.id);
      const userComments = comments.filter(c => c.userId === user.id);
      const userLogs = activityLogs.filter(l => l.user_id === user.id);
      const lastActivity = userLogs.length > 0 ? new Date(userLogs[0].created_at) : null;
      return {
        user,
        assignedCount: assignedTasks.length,
        completedCount: assignedTasks.filter(t => doneStatusIds.has(t.statusId)).length,
        commentCount: userComments.length,
        lastActivity,
      };
    });
  }, [orderedUsers, allTasks, comments, activityLogs, doneStatusIds]);

  const formatDate = (d: Date | null) => {
    if (!d) return '—';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const handleDragStart = (index: number) => { if (canReorder) setDragIndex(index); };
  const handleDragOver = (e: React.DragEvent, index: number) => { e.preventDefault(); setDragOverIndex(index); };
  const handleDragEnd = async () => {
    if (dragIndex === null || dragOverIndex === null || dragIndex === dragOverIndex) {
      setDragIndex(null); setDragOverIndex(null); return;
    }
    const newList = [...orderedUsers];
    const [moved] = newList.splice(dragIndex, 1);
    newList.splice(dragOverIndex, 0, moved);
    setOrderedUsers(newList);
    setDragIndex(null); setDragOverIndex(null);
    const updates = newList.map((u, i) => ({ id: u.id, sort_order: i }));
    for (const up of updates) {
      await supabase.from('members').update({ sort_order: up.sort_order }).eq('id', up.id);
    }
    await refreshUsers();
    toast.success(i18n.t('member.sortUpdated'));
  };

  const touchStartRef = useRef<{ index: number; y: number } | null>(null);
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchActivatedRef = useRef(false);

  const handleTouchStart = (index: number, e: React.TouchEvent) => {
    if (!canReorder) return;
    touchStartRef.current = { index, y: e.touches[0].clientY };
    touchActivatedRef.current = false;
    touchTimerRef.current = setTimeout(() => {
      touchActivatedRef.current = true;
      setDragIndex(index);
      if (navigator.vibrate) navigator.vibrate(50);
    }, 500);
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    if (!touchActivatedRef.current) {
      const dy = Math.abs(e.touches[0].clientY - touchStartRef.current.y);
      if (dy > 10) {
        if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
        touchStartRef.current = null;
      }
      return;
    }
    e.preventDefault();
    const touch = e.touches[0];
    const elements = document.elementsFromPoint(touch.clientX, touch.clientY);
    const row = elements.find(el => el.getAttribute('data-drag-index'));
    if (row) {
      const idx = parseInt(row.getAttribute('data-drag-index')!, 10);
      setDragOverIndex(idx);
    }
  };
  const handleTouchEnd = () => {
    if (touchTimerRef.current) clearTimeout(touchTimerRef.current);
    if (touchActivatedRef.current) handleDragEnd();
    touchStartRef.current = null;
    touchActivatedRef.current = false;
  };

  const handleRoleChange = async (memberId: string, newRole: MemberRoleSelection) => {
    if (memberId === currentMemberId) { toast.error(i18n.t('member.cannotChangeSelfRole')); return; }
    const { acquired, lockerName } = await acquireLock(`member-${memberId}`);
    if (!acquired) { toast.error(i18n.t('member.lockedByOther', { name: lockerName || i18n.t('common.unknown') })); return; }
    try {
      const targetUser = users.find(u => u.id === memberId);
      const { error } = await supabase.from('members').update({ role: newRole === 'qa_admin' ? 'member' : newRole, is_qa_admin: newRole === 'qa_admin' }).eq('id', memberId);
      if (error) toast.error(i18n.t('error.updateFailed') + error.message);
      else {
        toast.success(i18n.t('member.roleUpdated'));
        if (currentMemberId) {
          const oldRoleLabel = selectionRoleLabel(targetUser ? selectedMemberRole(targetUser) : 'member');
          const newRoleLabel = selectionRoleLabel(newRole);
          await logActivity(currentMemberId, 'change_role', i18n.t('activity.changeRole', { name: targetUser?.name || memberId, oldRole: oldRoleLabel, newRole: newRoleLabel }), undefined, undefined, 'member');
        }
        await refreshUsers();
      }
    } finally {
      releaseLock(`member-${memberId}`);
    }
  };

  const openEditJobTitle = (memberId: string) => {
    if (!isSuperAdmin) return;
    const target = users.find(user => user.id === memberId);
    if (!target) return;
    setJobTitleTarget({ id: target.id, name: target.name });
    setEditJobTitle(target.jobTitle || '');
    setJobTitleError(null);
  };

  const closeEditJobTitle = () => {
    if (!jobTitleSaving) setJobTitleTarget(null);
  };

  const handleSaveJobTitle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin || !jobTitleTarget || jobTitleSaving) return;
    const target = jobTitleTarget;
    const jobTitle = editJobTitle.trim();
    if (jobTitle.length > 200) { setJobTitleError(i18n.t('memberJobTitle.tooLong')); return; }
    setJobTitleSaving(true);
    setJobTitleError(null);
    let acquired = false;
    try {
      const lock = await acquireLock(`member-${target.id}`);
      acquired = lock.acquired;
      if (!acquired) {
        setJobTitleError(i18n.t('member.lockedByOther', { name: lock.lockerName || i18n.t('common.unknown') }));
        return;
      }
      const { data, error } = await supabase.from('members').update({ job_title: jobTitle }).eq('id', target.id).select('id').maybeSingle();
      if (error || !data) {
        setJobTitleError(i18n.t('memberJobTitle.saveFailed') + (error?.message || ''));
        return;
      }
      if (currentMemberId) {
        await logActivity(currentMemberId, 'change_job_title', i18n.t('memberJobTitle.activity', { name: target.name, jobTitle: jobTitle || '—' }), undefined, undefined, 'member');
      }
      await refreshUsers();
      setJobTitleTarget(null);
      toast.success(i18n.t('memberJobTitle.saved'));
    } catch (error) {
      setJobTitleError(i18n.t('memberJobTitle.saveFailed') + (error instanceof Error ? error.message : ''));
    } finally {
      if (acquired) releaseLock(`member-${target.id}`);
      setJobTitleSaving(false);
    }
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addForm.email || !addForm.name) { toast.error(i18n.t('member.requiredFields')); return; }
    if (addForm.password && addForm.password.length < 8) { toast.error(i18n.t('member.passwordTooShort')); return; }
    const newRole = isSuperAdmin ? addForm.role : 'member';
    setAddLoading(true);
    const { data, error } = await supabase.functions.invoke('manage-member', {
      // password: the member's initial login password. Empty → the backend
      // generates a random throwaway (member can't log in until reset).
      body: { action: 'create', email: addForm.email, name: addForm.name, role: newRole === 'qa_admin' ? 'member' : newRole, qaAdmin: newRole === 'qa_admin', jobTitle: isSuperAdmin ? addForm.jobTitle.trim() : '', avatar: addForm.name.slice(0, 1).toUpperCase(), color: COLORS[Math.floor(Math.random() * COLORS.length)], ...(addForm.password ? { password: addForm.password } : {}) },
    });
    let body = data as { error?: string; code?: string; message?: string } | null;
    const context = error ? (error as { context?: unknown }).context : undefined;
    if (!body && context instanceof Response) {
      try { body = await context.json(); } catch { /* no JSON body */ }
    }
    if (body?.error === 'email_taken') { toast.error(i18n.t('member.addEmailTaken')); }
    else if (body?.code === 'member_exists') { toast.error(i18n.t('member.addDuplicate')); }
    else if (error || body?.error) { toast.error(i18n.t('member.addFailed') + (body?.message || body?.error || error?.message)); }
    else {
      toast.success(i18n.t('member.added'));
      if (currentMemberId) {
        await logActivity(currentMemberId, 'add_member', i18n.t('activity.addMember', { name: addForm.name, email: addForm.email, role: selectionRoleLabel(newRole) }), undefined, undefined, 'member');
      }
      setShowAddModal(false);
      setAddForm({ email: '', name: '', role: 'member', jobTitle: '', password: '' });
      await refreshUsers();
    }
    setAddLoading(false);
  };

  const handleToggleActive = async (memberId: string, currentActive: boolean) => {
    if (memberId === currentMemberId) { toast.error(i18n.t('member.cannotDeactivateSelf')); return; }
    const actionLabel = currentActive ? i18n.t('member.deactivate') : i18n.t('member.activate');
    const targetUser = users.find(u => u.id === memberId);
    // Say who and what happens: deactivating ends the login but keeps the member's tasks and records.
    if (!(await confirm({ description: i18n.t(currentActive ? 'member.deactivateConfirm' : 'member.activateConfirm', { name: targetUser?.name || memberId }), title: actionLabel, destructive: currentActive }))) return;
    setActionLoading(memberId);
    const { data, error } = await supabase.functions.invoke('manage-member', { body: { action: 'toggle_active', memberId, isActive: !currentActive } });
    if (error || data?.error) toast.error(i18n.t('member.toggleFailed', { action: actionLabel }) + (data?.error || error?.message));
    else {
      toast.success(i18n.t('member.toggled', { action: actionLabel }));
      if (currentMemberId) {
        await logActivity(currentMemberId, 'toggle_member', i18n.t('activity.toggleMember', { action: actionLabel, name: targetUser?.name || memberId, transition: currentActive ? i18n.t('member.activeToInactive') : i18n.t('member.inactiveToActive') }), undefined, undefined, 'member');
      }
      await refreshUsers();
    }
    setActionLoading(null);
  };

  const openResetPassword = (memberId: string, memberName: string) => {
    setResetForm({ password: '', confirm: '' });
    setResetTarget({ id: memberId, name: memberName });
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTarget) return;
    if (resetForm.password.length < 8) { toast.error(i18n.t('member.passwordTooShort')); return; }
    if (resetForm.password !== resetForm.confirm) { toast.error(i18n.t('member.passwordMismatch')); return; }
    setResetLoading(true);
    const { data, error } = await supabase.functions.invoke('manage-member', { body: { action: 'reset_password', memberId: resetTarget.id, newPassword: resetForm.password } });
    let body = data as { success?: boolean; error?: string; message?: string } | null;
    // supabase-js keeps a non-2xx answer's body on error.context.
    const context = error ? (error as { context?: unknown }).context : undefined;
    if (!body && context instanceof Response) {
      try { body = await context.json(); } catch { /* no JSON body */ }
    }
    if (body?.error === 'email_taken') {
      toast.error(i18n.t('member.resetPasswordEmailTaken'));
    } else if (error || body?.error) {
      // Worker failures carry the zh human text in `message` (cfClient also
      // surfaces it via error.message); fall back to the raw error code.
      toast.error(i18n.t('member.resetPasswordFailed') + (body?.message || body?.error || error?.message));
    } else {
      toast.success(i18n.t('member.passwordResetDone', { name: resetTarget.name }));
      if (currentMemberId) {
        await logActivity(currentMemberId, 'reset_password', i18n.t('activity.resetPassword', { name: resetTarget.name }), undefined, undefined, 'member');
      }
      setResetTarget(null);
      setResetForm({ password: '', confirm: '' });
    }
    setResetLoading(false);
  };

  const openCreateLogin = (memberId: string, memberName: string) => {
    setLoginEmail('');
    setLoginError(null);
    setLoginTarget({ id: memberId, name: memberName });
  };

  const createLoginErrorText = (data: { error?: string; message?: string; memberName?: string } | null): string => {
    switch (data?.error) {
      case DEMO_BLOCKED: return i18n.t('member.createLoginDemoBlocked');
      case 'invalid_email': return i18n.t('member.createLoginInvalidEmail');
      case 'email_taken':
        return data.memberName
          ? i18n.t('member.createLoginEmailTakenBy', { name: data.memberName })
          : i18n.t('member.createLoginEmailTaken');
      case 'email_in_other_workspace': return i18n.t('member.createLoginEmailOtherWorkspace');
      case 'already_has_login': return i18n.t('member.createLoginAlreadyHasLogin');
      case 'member_inactive': return i18n.t('member.createLoginInactive');
      case 'requires_super_admin': return i18n.t('member.createLoginRequiresSuperAdmin');
      default: return i18n.t('member.createLoginFailed') + (data?.message || data?.error || '');
    }
  };

  const handleCreateLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginTarget) return;
    const target = loginTarget;
    const email = loginEmail.trim();
    if (!email) { setLoginError(i18n.t('member.createLoginInvalidEmail')); return; }
    setLoginLoading(true);
    setLoginError(null);
    try {
      const res = await callFunction<{
        success?: boolean; error?: string; message?: string; memberName?: string;
        email?: string; method?: 'invite' | 'temp_password'; tempPassword?: string; inviteFailed?: boolean;
      }>('manage-member', { action: 'create_login', memberId: target.id, email });
      const data = res.data;
      if (!res.ok || !data?.success) { setLoginError(createLoginErrorText(data)); return; }
      const finalEmail = data.email || email;
      setLoginTarget(null);
      if (data.method === 'invite') {
        toast.success(i18n.t('member.createLoginInvited', { email: finalEmail }));
      } else {
        toast.success(i18n.t('member.createLoginDone', { name: target.name }));
        setLoginCredentials([{ name: target.name, email: finalEmail, password: data.tempPassword || '', inviteFailed: data.inviteFailed }]);
      }
      if (currentMemberId) {
        await logActivity(currentMemberId, 'create_login', i18n.t('activity.createLogin', { name: target.name, email: finalEmail }), undefined, undefined, 'member');
      }
      await refreshUsers();
    } catch (err) {
      setLoginError(i18n.t('member.createLoginFailed') + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoginLoading(false);
    }
  };

  const handleDeleteMember = async (memberId: string, memberName: string) => {
    if (memberId === currentMemberId) { toast.error(i18n.t('member.cannotDeleteSelf')); return; }
    if (!(await confirm({ description: i18n.t('member.deleteConfirm', { name: memberName }), title: i18n.t('confirm.defaultTitle'), destructive: true }))) return;
    setActionLoading(memberId);
    const { data, error } = await supabase.functions.invoke('manage-member', { body: { action: 'delete', memberId } });
    if (error || data?.error) {
      // A member with history can only be deactivated; say so instead of a database error.
      if ((await functionErrorCode(error, data)) === 'member_has_history') toast.error(i18n.t('member.deleteHasHistory', { name: memberName }), { duration: 10000 });
      else toast.error(i18n.t('member.deleteFailed') + (data?.error || error?.message));
    }
    else {
      toast.success(i18n.t('member.deleted'));
      if (currentMemberId) {
        await logActivity(currentMemberId, 'delete_member', i18n.t('activity.deleteMember', { name: memberName }), undefined, undefined, 'member');
      }
      await refreshUsers();
    }
    setActionLoading(null);
  };

  return {
    users, permissions, currentMemberId, currentMember,
    isSuperAdmin, canAddMember, canReorder,
    viewers, isLockedBy,
    memberStats, formatDate,
    dragIndex, dragOverIndex,
    showAddModal, setShowAddModal,
    addForm, setAddForm,
    addLoading,
    actionLoading,
    jobTitleOpen, setJobTitleOpen,
    jobTitleRef,
    filteredJobTitles,
    existingJobTitles, jobTitleTarget, editJobTitle, setEditJobTitle,
    jobTitleSaving, jobTitleError, openEditJobTitle, closeEditJobTitle, handleSaveJobTitle,
    resetTarget, setResetTarget,
    resetForm, setResetForm,
    resetLoading,
    handleDragStart, handleDragOver, handleDragEnd,
    handleTouchStart, handleTouchMove, handleTouchEnd,
    handleRoleChange, handleAddMember, handleToggleActive, handleDeleteMember,
    openResetPassword, handleResetPassword,
    loginTarget, setLoginTarget,
    loginEmail, setLoginEmail,
    loginError, loginLoading,
    loginCredentials, setLoginCredentials,
    openCreateLogin, handleCreateLogin,
    ConfirmDialog,
  };
}
