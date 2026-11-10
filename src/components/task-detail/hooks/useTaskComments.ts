import { useState, useRef, useEffect, type Dispatch, type SetStateAction } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { generateId } from '@/lib/generateId';
import { logActivity } from '@/lib/activityLog';
import { sendSlackNotify } from '@/lib/slackNotify';
import { createNotification } from '../utils';
import { mentionedMembers } from '@/lib/mentions';
import { toast } from 'sonner';
import i18n from '@/i18n';
import type { Comment, Task, User, Project, Status } from '@/types';
import { useTaskCommentMedia } from './useTaskCommentMedia';
import { taskCommentClient, type TaskAttachmentSummary } from '@/lib/taskCommentClient';

type Deps = {
  task: Task | null;
  currentMemberId: string;
  currentMember: User | null;
  users: User[];
  allTasks: Task[];
  setAllTasks: Dispatch<SetStateAction<Task[]>>;
  globalComments: Comment[];
  project: Project | null;
  status: Status | null;
  assignee: User | null;
  MAX_FILE_SIZE: number;
  loadStorageUsage: () => void;
  /** Asks before something is deleted for good. */
  confirm?: (options: { title?: string; description: string; destructive?: boolean }) => Promise<boolean>;
};

export const useTaskComments = ({
  task, currentMemberId, currentMember, users, allTasks, setAllTasks,
  globalComments, project, status, assignee, MAX_FILE_SIZE, loadStorageUsage, confirm,
}: Deps) => {
  const [taskComments, setTaskComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [commentFile, setCommentFile] = useState<File | null>(null);
  const [commentFileUploading, setCommentFileUploading] = useState(false);
  const commentFileRef = useRef<HTMLInputElement>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentContent, setEditingCommentContent] = useState('');
  const media = useTaskCommentMedia(task?.id, currentMemberId, error => toast.error(i18n.t('taskDetail.comments.sendFailed') + (error instanceof Error ? error.message : '')));
  const activeScope = useRef('');
  activeScope.current = `${currentMemberId}:${task?.id || ''}`;

  // Sync comments from global realtime
  useEffect(() => {
    if (!task) return;
    setTaskComments(globalComments.filter(c => c.taskId === task.id));
    // Other users' new comments must bring their private attachment metadata too.
    void media.refresh().catch((): void => undefined);
  }, [globalComments, task?.id]);

  const addComment = async () => {
    if (!task) return;
    if (media.files.length || media.pending) {
      const scope = activeScope.current;
      const mentioned = mentionedMembers(newComment, users).filter(person => person.id !== currentMemberId);
      try {
        const result = await media.publish(newComment, mentioned.map(person => person.id));
        if (activeScope.current !== scope) return;
        const row = result.comment;
        const comment: Comment = { id: row.id, taskId: row.task_id, userId: row.user_id, content: row.content, createdAt: row.created_at };
        setTaskComments(previous => [...previous.filter(item => item.id !== comment.id), comment]);
        setAllTasks(previous => previous.map(item => item.id === task.id ? { ...item, commentCount: result.commentCount,attachmentCount:result.attachmentCount??item.attachmentCount,attachmentSummaryKnown:typeof result.attachmentCount==='number' } : item));
        // The transaction owns recipient deduplication and counters. The existing
        // Slack endpoint derives destinations from this same stored comment ID.
        const plain = row.content.replace(/<[^>]*>/g, '').trim();
        sendSlackNotify({ type: 'comment_added', commentId: row.id, taskKey: task.taskKey, taskTitle: task.title, taskId: task.id,
          projectName: project?.name, actorName: currentMember?.name || i18n.t('common.unknown'),
          assigneeName: assignee?.name, statusName: status?.name, priority: task.priority,
          commentPreview: plain.slice(0, 200), dmTargets: mentioned.map(person => ({email:person.email,name:person.name,reason:i18n.t('taskDetail.comments.mentionNotification')})) });
        logActivity(currentMemberId, 'add_comment', plain.slice(0,100), task.id, task.taskKey);
        setNewComment(''); loadStorageUsage();
      } catch (error) { if (activeScope.current === scope && (error as Error)?.name !== 'AbortError') toast.error(i18n.t('taskDetail.comments.sendFailed') + (error instanceof Error ? error.message : '')); }
      return;
    }
    if (!newComment.trim() && !commentFile) return;
    setCommentFileUploading(true);
    let attachmentUrl: string | undefined;
    let attachmentName: string | undefined;
    let attachmentSize: number | undefined;
    if (commentFile) {
      if (commentFile.size > MAX_FILE_SIZE) {
        toast.error(i18n.t('taskDetail.comments.fileSizeExceeded', { size: MAX_FILE_SIZE / 1024 / 1024 }));
        setCommentFileUploading(false);
        return;
      }
      const path = `comment-files/${task.id}/${Date.now()}_${commentFile.name}`;
      // Build the URL from the SERVER's effective path (cloud ws/ prefix).
      const { data: up, error: uploadError } = await supabase.storage.from('task-images').upload(path, commentFile);
      if (uploadError) {
        toast.error(i18n.t('taskDetail.comments.attachmentUploadFailed') + uploadError.message);
        setCommentFileUploading(false);
        return;
      }
      const { data: urlData } = supabase.storage.from('task-images').getPublicUrl(up?.path || path);
      attachmentUrl = urlData.publicUrl;
      attachmentName = commentFile.name;
      attachmentSize = commentFile.size;
    }
    const comment: Comment = {
      id: generateId('c'), taskId: task.id, userId: currentMemberId,
      content: newComment.trim() || '', createdAt: new Date().toISOString(),
      attachmentUrl, attachmentName, attachmentSize,
    };
    setTaskComments(prev => [...prev, comment]);
    const newCount = task.commentCount + 1;
    const newAttCount = attachmentUrl ? task.attachmentCount + 1 : task.attachmentCount;
    setAllTasks(prev => prev.map(t => t.id === task.id ? { ...t, commentCount: newCount, attachmentCount: newAttCount } : t));
    const { error: insertError } = await supabase.from('comments').insert({
      id: comment.id, task_id: comment.taskId, user_id: comment.userId,
      content: comment.content, created_at: comment.createdAt,
      attachment_url: attachmentUrl || null,
      attachment_name: attachmentName || null,
      attachment_size: attachmentSize || 0,
    });
    if (insertError) {
      toast.error(i18n.t('taskDetail.comments.sendFailed') + insertError.message);
      setTaskComments(prev => prev.filter(c => c.id !== comment.id));
      setAllTasks(prev => prev.map(t => t.id === task.id ? { ...t, commentCount: task.commentCount, attachmentCount: task.attachmentCount } : t));
      setCommentFileUploading(false);
      return;
    }
    await supabase.from('tasks').update({ comment_count: newCount }).eq('id', task.id);
    const plainText = newComment.replace(/<[^>]*>/g, '').trim();
    // Picked from the @ list or typed as "@Name": both reach the person.
    const mentioned = mentionedMembers(newComment, users).filter(person => person.id !== currentMemberId);
    const dmTargets = mentioned.map(person => ({ email: person.email, name: person.name, reason: i18n.t('taskDetail.comments.mentionNotification') }));
    const mentionedIds = new Set(mentioned.map(person => person.id));
    for (const person of mentioned) {
      createNotification(person.id, currentMemberId, 'mention', task.id, plainText.slice(0, 100));
      logActivity(currentMemberId, 'mention', `@${person.name}`, task.id, task.taskKey);
    }
    const commentPreview = plainText.slice(0, 100);
    for (const recipientId of new Set([task.assigneeId, task.reviewerId])) {
      if (recipientId && recipientId !== currentMemberId && !mentionedIds.has(recipientId))
        createNotification(recipientId, currentMemberId, 'comment', task.id, commentPreview);
    }
    sendSlackNotify({
      type: 'comment_added', commentId: comment.id, taskKey: task.taskKey, taskTitle: task.title, taskId: task.id,
      projectName: project?.name, actorName: currentMember?.name || i18n.t('common.unknown'),
      assigneeName: assignee?.name, statusName: status?.name, priority: task.priority,
      commentPreview: plainText.length > 200 ? plainText.slice(0, 200) + '...' : plainText,
      dmTargets: dmTargets.length > 0 ? dmTargets : undefined,
    });
    logActivity(currentMemberId, 'add_comment', plainText.slice(0, 100), task.id, task.taskKey);
    setNewComment('');
    setCommentFile(null);
    setCommentFileUploading(false);
    loadStorageUsage();
  };

  const deleteComment = async (commentId: string) => {
    if (!task) return;
    if (confirm && !(await confirm({ title: i18n.t('taskDetail.comments.deleteTitle'), description: i18n.t('taskDetail.comments.deleteConfirm'), destructive: true }))) return;
    const deletedComment = taskComments.find(c => c.id === commentId);
    // Remove it here only once the server has deleted it.
    const { error } = await supabase.from('comments').delete().eq('id', commentId);
    if (error) { toast.error(i18n.t('error.deleteFailed') + error.message); return; }
    setTaskComments(prev => prev.filter(c => c.id !== commentId));
    const newCount = Math.max(0, task.commentCount - 1);
    const newAttCount = deletedComment?.attachmentUrl
      ? Math.max(0, task.attachmentCount - 1)
      : task.attachmentCount;
    let summary:TaskAttachmentSummary|null=null;
    try{summary=await taskCommentClient.summary([task.id]);}catch{/* Deleted content stays deleted; only its aggregate is unknown. */}
    setAllTasks(prev => prev.map(t => t.id === task.id ? { ...t, commentCount: newCount, attachmentCount: summary?.counts[task.id]??newAttCount,attachmentSummaryKnown:Object.prototype.hasOwnProperty.call(summary?.counts||{},task.id) } : t));
    await supabase.from('tasks').update({ comment_count: newCount }).eq('id', task.id);
    logActivity(currentMemberId, 'delete_comment', '', task.id, task.taskKey);
    toast.success(i18n.t('taskDetail.comments.deleted'));
  };

  const startEditComment = (comment: Comment) => {
    setEditingCommentId(comment.id);
    setEditingCommentContent(comment.content);
  };

  const saveEditComment = async () => {
    if (!editingCommentId || !editingCommentContent.trim()) return;
    const before = taskComments.find(c => c.id === editingCommentId)?.content ?? '';
    setTaskComments(prev =>
      prev.map(c => c.id === editingCommentId ? { ...c, content: editingCommentContent } : c)
    );
    const { error } = await supabase.from('comments').update({ content: editingCommentContent }).eq('id', editingCommentId);
    if (error) {
      setTaskComments(prev => prev.map(c => c.id === editingCommentId ? { ...c, content: before } : c));
      toast.error(i18n.t('taskDetail.comments.updateFailed') + error.message);
      return;
    }
    const editPlain = editingCommentContent.replace(/<[^>]*>/g, '').trim();
    logActivity(currentMemberId, 'edit_comment', editPlain.slice(0, 100), task?.id, task?.taskKey);
    // Only people added by this edit are told; those already mentioned were told when it was posted.
    if (task) {
      const already = new Set(mentionedMembers(before, users).map(person => person.id));
      for (const person of mentionedMembers(editingCommentContent, users)) {
        if (person.id === currentMemberId || already.has(person.id)) continue;
        createNotification(person.id, currentMemberId, 'mention', task.id, editPlain.slice(0, 100));
        logActivity(currentMemberId, 'mention', `@${person.name}`, task.id, task.taskKey);
      }
    }
    setEditingCommentId(null);
    setEditingCommentContent('');
    toast.success(i18n.t('taskDetail.comments.updated'));
  };

  return {
    taskComments,
    newComment, setNewComment,
    commentFile, setCommentFile,
    commentFileUploading,
    commentFileRef,
    commentFiles: media.files,
    commentRejected: media.rejected,
    addCommentFiles: media.add,
    removeCommentFile: media.remove,
    retryCommentUpload: media.retryUpload,
    commentMediaBusy: media.busy,
    commentCommandPending: media.pending,
    commentAttachments: media.attachments,
    downloadCommentAttachment: media.download,
    commentAttachmentScope: media.scopeKey,
    editingCommentId, setEditingCommentId,
    editingCommentContent, setEditingCommentContent,
    addComment, deleteComment, startEditComment, saveEditComment,
  };
};
