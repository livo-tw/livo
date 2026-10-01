import { useState, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { logActivity } from '@/lib/activityLog';
import { getWorkspaceStorageLimitBytes } from '@/lib/workspaceQuota';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from '@/lib/uploadLimits';
import { toast } from 'sonner';
import i18n from '@/i18n';
import type { Task } from '@/types';
import type { Tables } from '@/integrations/supabase/types';

const MAX_FILE_SIZE = MAX_UPLOAD_BYTES;

type Deps = {
  task: Task | null;
  currentMemberId: string;
  allTasks: Task[];
  setAllTasks: (tasks: Task[]) => void;
};

export const useTaskAttachments = ({ task, currentMemberId, allTasks, setAllTasks }: Deps) => {
  const [attachments, setAttachments] = useState<Tables<'task_attachments'>[]>([]);
  const [fileUploading, setFileUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [storageUsed, setStorageUsed] = useState<number | null>(null);
  // Cloud-beta workspaces have a real quota (500MB). Everywhere else there is no
  // quota, so the limit stays null and the meter shows usage only.
  const [storageLimit, setStorageLimit] = useState<number | null>(null);
  useEffect(() => {
    getWorkspaceStorageLimitBytes().then((v) => { if (v) setStorageLimit(v); });
  }, []);

  const loadAttachments = async (taskId: string) => {
    const { data } = await supabase
      .from('task_attachments')
      .select('*')
      .eq('task_id', taskId)
      .order('created_at', { ascending: false });
    setAttachments(data || []);
  };

  const loadStorageUsage = async () => {
    const { data: attachData } = await supabase.from('task_attachments').select('file_size');
    const { data: commentData } = await supabase.from('comments').select('attachment_size');
    const attachTotal = (attachData || []).reduce((sum, row) => sum + (Number(row.file_size) || 0), 0);
    const commentTotal = (commentData || []).reduce((sum, row) => sum + (Number(row.attachment_size) || 0), 0);
    setStorageUsed(attachTotal + commentTotal);
  };

  // Load initial storage usage
  useEffect(() => { loadStorageUsage(); }, []);

  // Subscribe to attachment realtime changes for current task
  useEffect(() => {
    if (!task) return;
    const taskId = task.id;
    const channel = supabase
      .channel(`task-attachments-${taskId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_attachments', filter: `task_id=eq.${taskId}` }, () => {
        loadAttachments(taskId);
      })
      .subscribe();
    loadAttachments(taskId);
    return () => { supabase.removeChannel(channel); };
  }, [task?.id]);

  const handleFileUpload = async (files: FileList) => {
    if (!task || files.length === 0) return;
    const oversized = Array.from(files).filter(f => f.size > MAX_FILE_SIZE);
    if (oversized.length > 0) {
      toast.error(i18n.t('taskDetail.attachments.fileSizeExceeded', { files: oversized.map(f => f.name).join(', '), size: MAX_UPLOAD_MB }));
      return;
    }
    setFileUploading(true);
    const failedFiles: string[] = [];
    let firstErrMsg = '';
    let successCount = 0;
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop() || '';
      const storagePath = `${task.id}/${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
      // Store the SERVER's effective path — cloud workspaces get a ws/ prefix.
      const { data: up, error } = await supabase.storage.from('task-images').upload(storagePath, file);
      if (error) {
        if (!firstErrMsg && error.message) firstErrMsg = error.message; // e.g. beta 空間已滿
        failedFiles.push(file.name);
        continue;
      }
      await supabase.from('task_attachments').insert({
        task_id: task.id, file_name: file.name, file_size: file.size,
        file_type: file.type, storage_path: up?.path || storagePath, uploaded_by: currentMemberId,
      });
      successCount++;
    }
    await loadAttachments(task.id);
    await loadStorageUsage();
    setAllTasks(prev => prev.map(t => t.id === task.id ? { ...t, attachmentCount: t.attachmentCount + successCount } : t));
    setFileUploading(false);
    if (failedFiles.length > 0) {
      toast.error(
        i18n.t('taskDetail.attachments.uploadFailed', { files: failedFiles.join(', ') }) +
          (firstErrMsg ? `（${firstErrMsg}）` : '')
      );
    }
    if (successCount > 0) {
      logActivity(currentMemberId, 'upload_file', Array.from(files).filter(f => !failedFiles.includes(f.name)).map(f => f.name).join(', '), task.id, task.taskKey);
      toast.success(i18n.t('taskDetail.attachments.uploadSuccess', { count: successCount }));
    }
  };

  const deleteAttachment = async (att: Tables<'task_attachments'>) => {
    if (!task) return;
    await supabase.storage.from('task-images').remove([att.storage_path]);
    await supabase.from('task_attachments').delete().eq('id', att.id);
    setAttachments(prev => prev.filter(a => a.id !== att.id));
    const newAttCount = Math.max(0, task.attachmentCount - 1);
    setAllTasks(prev => prev.map(t => t.id === task.id ? { ...t, attachmentCount: newAttCount } : t));
    await loadStorageUsage();
    logActivity(currentMemberId, 'delete_file', att.file_name, task.id, task.taskKey);
    toast.success(i18n.t('taskDetail.attachments.deleted'));
  };

  const getPublicUrl = (path: string) => {
    const { data } = supabase.storage.from('task-images').getPublicUrl(path);
    return data.publicUrl;
  };

  return {
    attachments,
    fileUploading,
    fileInputRef,
    storageUsed,
    STORAGE_LIMIT: storageLimit,
    MAX_FILE_SIZE,
    loadAttachments,
    loadStorageUsage,
    handleFileUpload,
    deleteAttachment,
    getPublicUrl,
  };
};
