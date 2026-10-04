import { safeLinkHref } from '@/lib/safeLink';
import RichTextEditor from '@/components/RichTextEditorLazy';
import { Paperclip, Download, HardDrive, X, FileText } from 'lucide-react';
import { getDepartment, deptColors } from '@/lib/department';
import { useTranslation } from 'react-i18next';
import type { TaskDetailState } from './hooks/useTaskDetail';
import { fixHtml } from './utils';
import TaskSidebarFields from './TaskSidebarFields';
import { toast } from 'sonner';

type Props = { detail: TaskDetailState };

const TaskCommentsTab = ({ detail }: Props) => {
  const { t } = useTranslation();
  const {
    task, users, currentMember, currentMemberId,
    taskComments, newComment, setNewComment,
    commentFile, setCommentFile, commentFileUploading,
    commentFileRef,
    editingCommentId, setEditingCommentId,
    editingCommentContent, setEditingCommentContent,
    addComment, deleteComment, startEditComment, saveEditComment,
    storageUsed, STORAGE_LIMIT, MAX_FILE_SIZE,
    isMobile,
  } = detail;

  if (!task) return null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 space-y-3">
        {taskComments.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">{t('taskDetail.comments.empty')}</p>}
        {taskComments.map(comment => {
          const user = users.find(u => u.id === comment.userId);
          const date = new Date(comment.createdAt);
          const isOwner = comment.userId === currentMemberId;
          const isEditing = editingCommentId === comment.id;
          return (
            <div key={comment.id} className="flex gap-2 group">
              <div className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-[9px] font-bold text-white" style={{ backgroundColor: user?.color }}>
                {user?.avatar}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                  <span className="text-sm font-semibold text-foreground">{user?.name}</span>
                  {user && (() => {
                    const dept = getDepartment(user);
                    return (
                      <span className="flex items-center gap-1">
                        {dept && <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${deptColors[dept]}`}>{dept}</span>}
                        <span className="text-[10px] text-muted-foreground">{user.jobTitle}</span>
                      </span>
                    );
                  })()}
                  <span className="text-xs text-muted-foreground">
                    {String(date.getMonth() + 1).padStart(2, '0')}/{String(date.getDate()).padStart(2, '0')} {String(date.getHours()).padStart(2, '0')}:{String(date.getMinutes()).padStart(2, '0')}
                  </span>
                  {isOwner && !isEditing && (
                    <div className={`${isMobile ? '' : 'opacity-0 group-hover:opacity-100'} flex items-center gap-1 transition-opacity`}>
                      <button onClick={() => startEditComment(comment)} className="text-xs text-muted-foreground hover:text-primary">{t('taskDetail.comments.editButton')}</button>
                      <button onClick={() => deleteComment(comment.id)} className="text-xs text-muted-foreground hover:text-destructive">{t('taskDetail.comments.deleteButton')}</button>
                    </div>
                  )}
                </div>
                {isEditing ? (
                  <div>
                    <RichTextEditor content={editingCommentContent} onChange={setEditingCommentContent} placeholder={t('taskDetail.comments.editPlaceholder')} members={users} />
                    <div className="flex gap-1.5 mt-1.5">
                      <button onClick={saveEditComment} className="px-2.5 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90">{t('button.save')}</button>
                      <button onClick={() => setEditingCommentId(null)} className="px-2.5 py-1 text-xs rounded border border-border text-muted-foreground hover:bg-accent">{t('button.cancel')}</button>
                    </div>
                  </div>
                ) : (
                  <>
                    {comment.content && (
                      <div className="text-sm leading-relaxed px-3 py-2 rich-content bg-muted text-foreground" style={{ borderRadius: '0 8px 8px 8px' }} dangerouslySetInnerHTML={{ __html: fixHtml(comment.content) }} />
                    )}
                    {safeLinkHref(comment.attachmentUrl) && (
                      <a href={safeLinkHref(comment.attachmentUrl)!} target="_blank" rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs bg-muted hover:bg-accent transition-colors border border-border">
                        <Paperclip size={12} className="text-muted-foreground" />
                        <span className="text-foreground truncate max-w-[200px]">{comment.attachmentName || t('taskDetail.comments.attachment')}</span>
                        {comment.attachmentSize && <span className="text-muted-foreground">({(comment.attachmentSize / 1024).toFixed(0)} KB)</span>}
                        <Download size={12} className="text-muted-foreground" />
                      </a>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* New comment input */}
      <div className="flex gap-2 mt-4 pt-3 border-t border-border">
        <div className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-[9px] font-bold text-white" style={{ backgroundColor: currentMember?.color || '#00B8D9' }}>
          {currentMember?.avatar || '?'}
        </div>
        <div className="flex-1">
          <RichTextEditor content={newComment} onChange={setNewComment} placeholder={t('taskDetail.comments.newPlaceholder')} members={users} />
          {commentFile && (
            <div className="mt-1.5 flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-muted border border-border">
              <Paperclip size={12} className="text-muted-foreground flex-shrink-0" />
              <span className="text-xs text-foreground truncate flex-1">{commentFile.name}</span>
              <span className="text-xs text-muted-foreground flex-shrink-0">({(commentFile.size / 1024).toFixed(0)} KB)</span>
              <button onClick={() => setCommentFile(null)} className="text-muted-foreground hover:text-destructive flex-shrink-0"><X size={12} /></button>
            </div>
          )}
          <div className="flex items-center gap-2 mt-1.5">
            <button
              onClick={addComment}
              disabled={commentFileUploading || (!newComment.trim() && !commentFile) || (newComment === '<p></p>' && !commentFile)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${(newComment.trim() && newComment !== '<p></p>') || commentFile ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-muted text-muted-foreground cursor-not-allowed'}`}
            >
              {commentFileUploading ? t('common.uploading') : t('button.save')}
            </button>
            <input
              ref={commentFileRef}
              type="file"
              className="hidden"
              accept={isMobile ? '*/*' : undefined}
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) {
                  if (file.size > MAX_FILE_SIZE) {
                    toast.error(t('taskDetail.comments.fileSizeError', { size: MAX_FILE_SIZE / 1024 / 1024 }));
                    return;
                  }
                  setCommentFile(file);
                }
                e.target.value = '';
              }}
            />
            <button onClick={() => commentFileRef.current?.click()} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" title={t('taskDetail.comments.attachFileTitle', { size: MAX_FILE_SIZE / 1024 / 1024 })}>
              <Paperclip size={15} />
            </button>
            {storageUsed !== null && (
              <div className="flex items-center gap-1.5 ml-auto text-xs text-muted-foreground">
                <HardDrive size={12} />
                <div className="flex items-center gap-1">
                  {STORAGE_LIMIT !== null && (
                    <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, (storageUsed / STORAGE_LIMIT) * 100)}%`, backgroundColor: storageUsed / STORAGE_LIMIT > 0.9 ? '#FF5630' : storageUsed / STORAGE_LIMIT > 0.7 ? '#FF8B00' : '#36B37E' }} />
                    </div>
                  )}
                  <span>{storageUsed >= 1024 * 1024 ? `${(storageUsed / 1024 / 1024).toFixed(1)} MB` : `${(storageUsed / 1024).toFixed(0)} KB`}{STORAGE_LIMIT !== null && ` / ${STORAGE_LIMIT >= 1024 * 1024 * 1024 ? `${(STORAGE_LIMIT / 1024 / 1024 / 1024).toFixed(0)} GB` : `${(STORAGE_LIMIT / 1024 / 1024).toFixed(0)} MB`}`}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Mobile: Sidebar fields */}
      {isMobile && (
        <div className="border-t border-border pt-4 mt-4">
          <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1"><FileText size={16} /> {t('task.properties')}</h4>
          <TaskSidebarFields detail={detail} />
        </div>
      )}
    </div>
  );
};

export default TaskCommentsTab;
