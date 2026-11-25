import { useMemo } from 'react';
import { sortComments } from '@/lib/commentOrdering';
import { useCommentOrder } from '@/hooks/useCommentOrder';
import { CommentOrderSelect } from '@/components/CommentOrderSelect';
import { safeLinkHref } from '@/lib/safeLink';
import { Paperclip, Download, FileText } from 'lucide-react';
import { getDepartment, deptColors } from '@/lib/department';
import { useTranslation } from 'react-i18next';
import type { TaskDetailState } from './hooks/useTaskDetail';
import { fixHtml } from './utils';
import TaskSidebarFields from './TaskSidebarFields';
import { toast } from 'sonner';
import CommentAttachmentList from '@/components/comments/CommentAttachmentList';
import type { CommentMedia } from '@/lib/taskCommentAttachmentCore';

type Props = { detail: TaskDetailState };
const emptyAttachments: readonly CommentMedia[] = [];

const TaskCommentsTab = ({ detail }: Props) => {
  const { t } = useTranslation();
  const {
    task, users, currentMemberId, taskComments,
    editingCommentId, deleteComment, startEditComment, isMobile,
    commentAttachments = emptyAttachments, downloadCommentAttachment, commentAttachmentScope,
    editCommentBusy, editCommentPending, commentMediaBusy, commentCommandPending, commentFileUploading,
  } = detail;

  const [commentOrder, setCommentOrder] = useCommentOrder(currentMemberId);
  const sortedComments = useMemo(() => sortComments(taskComments, commentOrder), [taskComments, commentOrder]);
  const commentHtml = useMemo(
    () => new Map(taskComments.map(comment => [comment.id, fixHtml(comment.content)])),
    [taskComments],
  );
  const attachmentsByComment = useMemo(() => {
    const grouped = new Map<string, CommentMedia[]>();
    for (const file of commentAttachments) {
      if (!file.commentId) continue;
      const files = grouped.get(file.commentId);
      if (files) files.push(file);
      else grouped.set(file.commentId, [file]);
    }
    return grouped;
  }, [commentAttachments]);

  if (!task) return null;

  return (
    <div className="space-y-3">
      <CommentOrderSelect order={commentOrder} onChange={setCommentOrder} />
      {taskComments.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">{t('taskDetail.comments.empty')}</p>}
      {sortedComments.map(comment => {
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
                {isEditing && <span className="text-xs font-medium text-primary">{t('taskDetail.comments.editPlaceholder')}</span>}
                {isOwner && !isEditing && (
                  <div className={`${isMobile ? '' : 'opacity-0 group-hover:opacity-100'} flex items-center gap-1 transition-opacity`}>
                    <button onClick={() => startEditComment(comment)} disabled={!!editingCommentId || editCommentBusy || editCommentPending || commentMediaBusy || commentCommandPending || commentFileUploading} className="text-xs text-muted-foreground hover:text-primary focus-visible:opacity-100 disabled:opacity-50">{t('taskDetail.comments.editButton')}</button>
                    <button onClick={() => deleteComment(comment.id)} className="text-xs text-muted-foreground hover:text-destructive focus-visible:opacity-100">{t('taskDetail.comments.deleteButton')}</button>
                  </div>
                )}
              </div>
              {comment.content && (
                <div className="text-sm leading-relaxed px-3 py-2 rich-content bg-muted text-foreground" style={{ borderRadius: '0 8px 8px 8px' }} dangerouslySetInnerHTML={{ __html: commentHtml.get(comment.id) ?? '' }} />
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
              <CommentAttachmentList attachments={attachmentsByComment.get(comment.id) ?? emptyAttachments} download={downloadCommentAttachment} scopeKey={`${commentAttachmentScope}:${comment.id}`} onError={error => toast.error(error instanceof Error ? error.message : t('taskDetail.comments.attachmentUploadFailed'))} />
            </div>
          </div>
        );
      })}

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
