import { HardDrive, Paperclip, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import CommentAttachmentPicker from '@/components/comments/CommentAttachmentPicker';
import RichTextEditor from '@/components/RichTextEditorLazy';
import { COMMENT_FILE_COUNT } from '@/lib/taskCommentAttachmentCore';
import type { TaskDetailState } from './hooks/useTaskDetail';

export default function TaskCommentComposer({ detail }: { detail: TaskDetailState }) {
  const { t } = useTranslation();
  const {
    task, users, currentMemberId, newComment, setNewComment,
    commentFile, setCommentFile, commentFileUploading, addComment,
    commentFiles, commentRejected, addCommentFiles, removeCommentFile, retryCommentUpload,
    commentMediaBusy, commentCommandPending, commentAttachments,
    editingCommentId, setEditingCommentId, editingCommentContent, setEditingCommentContent, saveEditComment,
    editCommentFiles, editCommentRejected, addEditCommentFiles, removeEditCommentFile, retryEditCommentUpload,
    editCommentBusy, editCommentPending, storageUsed, STORAGE_LIMIT,
  } = detail;
  const editing = editingCommentId !== null;
  const content = editing ? editingCommentContent : newComment;
  const files = editing ? editCommentFiles : commentFiles;
  const busy = editing ? editCommentBusy : commentMediaBusy || commentFileUploading;
  const pending = editing ? editCommentPending : commentCommandPending;
  const placeholder = t(editing ? 'taskDetail.comments.editPlaceholder' : 'taskDetail.comments.newPlaceholder');
  const existingFileCount = editing ? commentAttachments.filter(file => file.commentId === editingCommentId).length : 0;
  const canSubmit = !!(content.trim() && (editing || content !== '<p></p>')) || !!files.length || (!editing && !!commentFile) || pending;
  const composerKey = `${task?.id}:${currentMemberId}:${editingCommentId ?? 'new'}`;

  return (
    <div className="comment-composer">
      {editing && <p className="shrink-0 text-xs font-medium text-primary">{placeholder}</p>}
      <div className="flex min-h-16 flex-col">
        <RichTextEditor
          key={composerKey}
          content={content}
          onChange={editing ? setEditingCommentContent : setNewComment}
          placeholder={placeholder}
          members={users}
          editable={!busy && !pending}
          allowImageUpload={false}
          compact
        />
      </div>
      {pending && <p role="status" className="shrink-0 text-xs text-muted-foreground">{t('commentAttachments.pendingReceipt')}</p>}
      {!editing && commentFile && (
        <div className="flex shrink-0 items-center gap-2 rounded border border-border bg-muted px-2 py-1 text-xs">
          <Paperclip size={12} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{commentFile.name}</span>
          <button type="button" disabled={busy} onClick={() => setCommentFile(null)} aria-label={t('commentAttachments.remove', { name: commentFile.name })}><X size={14} aria-hidden="true" /></button>
        </div>
      )}
      <CommentAttachmentPicker
        key={composerKey}
        files={files}
        rejected={editing ? editCommentRejected : commentRejected}
        busy={busy || pending}
        maxFiles={Math.max(0, COMMENT_FILE_COUNT - existingFileCount)}
        onFiles={editing ? addEditCommentFiles : addCommentFiles}
        onRemove={editing ? removeEditCommentFile : removeCommentFile}
        onRetry={editing ? retryEditCommentUpload : retryCommentUpload}
        actions={<>
          <button type="button" onClick={editing ? saveEditComment : addComment} disabled={busy || !canSubmit}
            className="shrink-0 rounded bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:bg-muted disabled:text-muted-foreground sm:text-sm">
            {busy ? t('common.uploading') : pending ? t('qa.retryUpload') : t('button.save')}
          </button>
          {editing && <button type="button" onClick={() => setEditingCommentId(null)} disabled={busy || pending}
            className="shrink-0 rounded border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50 sm:text-sm">
            {t('button.cancel')}
          </button>}
          {!editing && storageUsed !== null && (
            <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <HardDrive size={12} aria-hidden="true" />
              {STORAGE_LIMIT !== null && (
                <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted md:block">
                  <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, (storageUsed / STORAGE_LIMIT) * 100)}%`, backgroundColor: storageUsed / STORAGE_LIMIT > 0.9 ? '#FF5630' : storageUsed / STORAGE_LIMIT > 0.7 ? '#FF8B00' : '#36B37E' }} />
                </div>
              )}
              <span>{storageUsed >= 1024 * 1024 ? `${(storageUsed / 1024 / 1024).toFixed(1)} MB` : `${(storageUsed / 1024).toFixed(0)} KB`}{STORAGE_LIMIT !== null && ` / ${STORAGE_LIMIT >= 1024 * 1024 * 1024 ? `${(STORAGE_LIMIT / 1024 / 1024 / 1024).toFixed(0)} GB` : `${(STORAGE_LIMIT / 1024 / 1024).toFixed(0)} MB`}`}</span>
            </div>
          )}
        </>}
      />
    </div>
  );
}
