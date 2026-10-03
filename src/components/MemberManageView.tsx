import { Plus, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '@/hooks/use-mobile';
import { useMemberManage } from './member-manage/useMemberManage';
import MemberTableDesktop from './member-manage/MemberTableDesktop';
import MemberCardsMobile from './member-manage/MemberCardsMobile';
import AddMemberModal from './member-manage/AddMemberModal';
import ResetPasswordModal from './member-manage/ResetPasswordModal';
import CreateLoginModal from './member-manage/CreateLoginModal';
import EditJobTitleModal from './member-manage/EditJobTitleModal';
import AccountCredentialsDialog from './AccountCredentialsDialog';

const MemberManageView = ({ embedded }: { embedded?: boolean }) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const {
    users, currentMemberId,
    isSuperAdmin, canAddMember, canReorder,
    viewers, isLockedBy,
    memberStats, formatDate,
    dragIndex, dragOverIndex,
    showAddModal, setShowAddModal,
    addForm, setAddForm,
    addLoading, actionLoading,
    jobTitleOpen, setJobTitleOpen,
    jobTitleRef, filteredJobTitles,
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
    existingJobTitles, jobTitleTarget, editJobTitle, setEditJobTitle,
    jobTitleSaving, jobTitleError, openEditJobTitle, closeEditJobTitle, handleSaveJobTitle,
    ConfirmDialog,
  } = useMemberManage();

  const sharedTableProps = {
    memberStats, currentMemberId, isSuperAdmin, canReorder,
    dragIndex, dragOverIndex, actionLoading, isLockedBy, formatDate,
    onDragStart: handleDragStart, onDragOver: handleDragOver, onDragEnd: handleDragEnd,
    onRoleChange: handleRoleChange, onToggleActive: handleToggleActive, onDelete: handleDeleteMember,
    onResetPassword: openResetPassword,
    onCreateLogin: openCreateLogin,
    onEditJobTitle: openEditJobTitle,
  };

  return (
    <div className={embedded ? '' : 'flex-1 overflow-y-auto'}>
      <div className={embedded ? '' : 'px-4 py-6 md:px-6'}>
      <div className={embedded ? '' : 'max-w-5xl mx-auto'}>
        <div className="flex items-center justify-between mb-4 md:mb-6">
          <div className="flex items-center gap-2">
            <Users size={20} className="text-primary" />
            <h1 className="text-xl md:text-2xl font-bold text-foreground">{t('member.title')}</h1>
            <span className="text-xs text-muted-foreground ml-1">{t('member.totalCount', { count: users.length })}</span>
            {canReorder && <span className="text-[10px] text-muted-foreground ml-1">· {t('member.dragToReorder')}</span>}
            {viewers.length > 0 && (
              <div className="flex items-center gap-1 ml-2">
                {viewers.map(v => (
                  <div key={v.memberId} className="w-6 h-6 rounded-full flex items-center justify-center text-[8px] font-bold text-white border-2 border-card -ml-1 first:ml-0" style={{ backgroundColor: v.color }} title={t('presence.viewing', { name: v.name })}>
                    {v.avatar}
                  </div>
                ))}
                <span className="text-xs text-muted-foreground ml-1">{t('statusManage.viewing')}</span>
              </div>
            )}
          </div>
          {canAddMember && (
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs md:text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Plus size={14} /> {t('member.addMember')}
            </button>
          )}
        </div>

        {isSuperAdmin && (
          <div className="mb-4 p-3 md:p-4 bg-muted/50 rounded-lg text-sm text-muted-foreground space-y-1">
            <p><strong className="text-foreground">{t('role.superAdmin')}</strong>：{t('role.superAdminDesc')}</p>
            <p><strong className="text-foreground">{t('role.admin')}</strong>：{t('role.adminDesc')}</p>
            <p><strong className="text-foreground">{t('role.qaAdmin')}</strong>：{t('role.qaAdminDesc')}</p>
            <p><strong className="text-foreground">{t('role.member')}</strong>：{t('role.memberDesc')}</p>
          </div>
        )}

        {isMobile ? (
          <MemberCardsMobile
            {...sharedTableProps}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          />
        ) : (
          <MemberTableDesktop {...sharedTableProps} />
        )}
      </div>

      <AddMemberModal
        show={showAddModal}
        onClose={() => setShowAddModal(false)}
        form={addForm}
        setForm={setAddForm}
        jobTitleRef={jobTitleRef}
        jobTitleOpen={jobTitleOpen}
        setJobTitleOpen={setJobTitleOpen}
        filteredJobTitles={filteredJobTitles}
        onSubmit={handleAddMember}
        loading={addLoading}
        canEditJobTitle={isSuperAdmin}
      />
      <ResetPasswordModal
        target={resetTarget}
        onClose={() => setResetTarget(null)}
        form={resetForm}
        setForm={setResetForm}
        onSubmit={handleResetPassword}
        loading={resetLoading}
      />
      <CreateLoginModal
        target={loginTarget}
        email={loginEmail}
        setEmail={setLoginEmail}
        error={loginError}
        onClose={() => setLoginTarget(null)}
        onSubmit={handleCreateLogin}
        loading={loginLoading}
      />
      <AccountCredentialsDialog credentials={loginCredentials} onClose={() => setLoginCredentials([])} />
      <EditJobTitleModal
        target={isSuperAdmin ? jobTitleTarget : null}
        value={editJobTitle}
        onChange={setEditJobTitle}
        existingTitles={existingJobTitles}
        loading={jobTitleSaving}
        error={jobTitleError}
        onClose={closeEditJobTitle}
        onSubmit={handleSaveJobTitle}
      />
      {ConfirmDialog}
      </div>
    </div>
  );
};

export default MemberManageView;
