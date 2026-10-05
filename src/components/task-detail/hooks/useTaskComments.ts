import { useState, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { generateId } from '@/lib/generateId';
import { logActivity } from '@/lib/activityLog';
import { sendSlackNotify } from '@/lib/slackNotify';
import { createNotification } from '../utils';
import { toast } from 'sonner';
import i18n from '@/i18n';
import type { Comment, Task, User, Project, Status } from '@/types';

type Deps = {
  task: Task | null;
  currentMemberId: string;
  currentMember: User | null;
  users: User[];
  allTasks: Task[];
  setAllTasks: (tasks: Task[]) => void;
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

  // Sync comments from global realtime
  useEffect(() => {
    if (!task) return;
    setTaskComments(globalComments.filter(c => c.taskId === task.id));
  }, [globalComments, task?.id]);

  const addComment = async () => {
    if (!task) return;
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
    const mentionRegex = /data-id="([^"]+)"/g;
    const dmTargets: { email: string; name?: string; reason: string }[] = [];
    const mentionedIds = new Set<string>();
    let match;
    while ((match = mentionRegex.exec(newComment)) !== null) {
      const mentionedUser = users.find(u => u.id === match![1]);
      if (mentionedUser && mentionedUser.id !== currentMemberId) {
        dmTargets.push({ email: mentionedUser.email, name: mentionedUser.name, reason: i18n.t('taskDetail.comments.mentionNotification') });
        mentionedIds.add(mentionedUser.id);
        createNotification(mentionedUser.id, currentMemberId, 'mention', task.id, plainText.slice(0, 100));
        logActivity(currentMemberId, 'mention', `@${mentionedUser.name}`, task.id, task.taskKey);
      }
    }
    const commentPreview = plainText.slice(0, 100);
    if (task.assigneeId && task.assigneeId !== currentMemberId && !mentionedIds.has(task.assigneeId))
      createNotification(task.assigneeId, currentMemberId, 'comment', task.id, commentPreview);
    if (task.reviewerId && task.reviewerId !== currentMemberId && !mentionedIds.has(task.reviewerId))
      createNotification(task.reviewerId, currentMemberId, 'comment', task.id, commentPreview);
    sendSlackNotify({
      type: 'comment_added', taskKey: task.taskKey, taskTitle: task.title, taskId: task.id,
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
    setAllTasks(prev => prev.map(t => t.id === task.id ? { ...t, commentCount: newCount, attachmentCount: newAttCount } : t));
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
    setTaskComments(prev =>
      prev.map(c => c.id === editingCommentId ? { ...c, content: editingCommentContent } : c)
    );
    await supabase.from('comments').update({ content: editingCommentContent }).eq('id', editingCommentId);
    const editPlain = editingCommentContent.replace(/<[^>]*>/g, '').trim();
    logActivity(currentMemberId, 'edit_comment', editPlain.slice(0, 100), task?.id, task?.taskKey);
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
    editingCommentId, setEditingCommentId,
    editingCommentContent, setEditingCommentContent,
    addComment, deleteComment, startEditComment, saveEditComment,
  };
};
