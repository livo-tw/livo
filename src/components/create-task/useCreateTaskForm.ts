import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAuthContext } from '@/context/AuthContext';
import { useMemberContext } from '@/context/MemberContext';
import { useUIContext } from '@/context/UIContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useTaskContext } from '@/context/TaskContext';
import { useSprintContext } from '@/context/SprintContext';
import { useLicense } from '@/context/LicenseContext';
import { useConfirmDialog } from '@/components/ConfirmDialog';
import { sendSlackNotify } from '@/lib/slackNotify';
import { logActivity } from '@/lib/activityLog';
import { supabase } from '@/integrations/supabase/client';
import { Task, Priority, TaskDeployment } from '@/types';
import { format } from 'date-fns';
import { toast } from 'sonner';

interface PendingFile {
  file: File;
  preview?: string;
  id: string;
}

export function useCreateTaskForm() {
  const { t } = useTranslation();
  const { currentMemberId, currentMember } = useAuthContext();
  const { users } = useMemberContext();
  const { showCreateTask, setShowCreateTask, requiredFields } = useUIContext();
  const { selectedProjectId, allProjects, productLines } = useProjectContext();
  const { allTasks, setAllTasks, statuses, tags, refreshTags, createTaskInDb, createSubtask, refreshTaskSpecs, refreshTaskChecks, refreshTaskTodos, refreshStatusLogs, taskTemplates } = useTaskContext();
  const { currentSprint } = useSprintContext();
  const { hasFeature } = useLicense();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const isMobile = useIsMobile();

  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [statusId, setStatusId] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [assigneeId, setAssigneeId] = useState<string>('');
  const [reviewerId, setReviewerId] = useState<string>('');
  const [dueDate, setDueDate] = useState<Date | undefined>();
  const [startDate, setStartDate] = useState<Date | undefined>();
  const [background, setBackground] = useState('');
  const [requirement, setRequirement] = useState('');
  const [notes, setNotes] = useState('');
  const [gitlabUrl, setGitlabUrl] = useState('');
  const [checkItems, setCheckItems] = useState<string[]>([]);
  const [newCheckText, setNewCheckText] = useState('');
  const [todoItems, setTodoItems] = useState<string[]>([]);
  const [newTodoText, setNewTodoText] = useState('');
  const [deployments, setDeployments] = useState<TaskDeployment[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [subtaskItems, setSubtaskItems] = useState<string[]>([]);
  const [newSubtaskText, setNewSubtaskText] = useState('');
  const [showValidationErrors, setShowValidationErrors] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const tagPickerRef = useRef<HTMLDivElement>(null);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#6554C0');
  const [tagManageMode, setTagManageMode] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null); const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (tagPickerRef.current && !tagPickerRef.current.contains(e.target as Node)) setTagPickerOpen(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, []);

  useEffect(() => {
    if (showCreateTask) {
      const defaultProject = selectedProjectId || allProjects[0]?.id || '';
      setProjectId(defaultProject);
      setTitle(''); setStatusId(statuses[0]?.id || ''); setPriority('medium');
      setAssigneeId(''); setReviewerId('');
      setDueDate(undefined); setStartDate(undefined);
      setBackground(''); setRequirement(''); setNotes(''); setGitlabUrl('');
      setCheckItems([]); setNewCheckText(''); setTodoItems([]); setNewTodoText('');
      setDeployments([]); setPendingFiles([]); setSelectedTagIds([]);
      setTagPickerOpen(false); setNewTagName(''); setTagManageMode(false);
      setSubtaskItems([]); setNewSubtaskText('');
      setTimeout(() => titleRef.current?.focus(), 100);
    }
  }, [showCreateTask, selectedProjectId, allProjects]);

  const applyTemplate = (templateId: string) => {
    const tmpl = taskTemplates.find(t => t.id === templateId);
    if (!tmpl) return;
    if (tmpl.projectId) setProjectId(tmpl.projectId);
    if (tmpl.defaultPriority) setPriority(tmpl.defaultPriority);
    if (tmpl.defaultTagIds.length > 0) setSelectedTagIds(tmpl.defaultTagIds);
    if (tmpl.defaultSpecBackground) setBackground(tmpl.defaultSpecBackground);
    if (tmpl.defaultSpecRequirement) setRequirement(tmpl.defaultSpecRequirement);
    if (tmpl.defaultSpecNotes) setNotes(tmpl.defaultSpecNotes);
    if (tmpl.defaultCheckItems && tmpl.defaultCheckItems.length > 0) {
      setCheckItems(tmpl.defaultCheckItems);
    }
    if (tmpl.defaultTodoItems && tmpl.defaultTodoItems.length > 0) {
      setTodoItems(tmpl.defaultTodoItems);
    }
  };

  const isValid = (() => {
    if (!title.trim() || !projectId) return false;
    if (requiredFields.dueDate && !dueDate) return false;
    if (requiredFields.startDate && !startDate) return false;
    if (requiredFields.assignee && !assigneeId) return false;
    if (requiredFields.reviewer && !reviewerId) return false;
    if (requiredFields.tags && selectedTagIds.length === 0) return false;
    if (requiredFields.background && !background.trim()) return false;
    if (requiredFields.requirement && !requirement.trim()) return false;
    if (requiredFields.notes && !notes.trim()) return false;
    if (requiredFields.checks && checkItems.length === 0) return false;
    if (requiredFields.todos && todoItems.length === 0) return false;
    if (requiredFields.gitlabUrl && !gitlabUrl.trim()) return false;
    if (requiredFields.deployments && deployments.length === 0) return false;
    return true;
  })();

  const generateTaskKey = () => {
    const project = allProjects.find(p => p.id === projectId);
    if (!project) return 'TASK-1';
    const projectTasks = allTasks.filter(t => t.projectId === projectId);
    const maxNum = projectTasks.reduce((max, t) => {
      const parts = t.taskKey.split('-');
      const num = parseInt(parts[parts.length - 1], 10);
      return isNaN(num) ? max : Math.max(max, num);
    }, 0);
    return `${project.key}-${maxNum + 1}`;
  };

  const addCheck = () => { if (!newCheckText.trim()) return; setCheckItems(prev => [...prev, newCheckText.trim()]); setNewCheckText(''); };
  const removeCheck = (idx: number) => setCheckItems(prev => prev.filter((_, i) => i !== idx));
  const addTodo = () => { if (!newTodoText.trim()) return; setTodoItems(prev => [...prev, newTodoText.trim()]); setNewTodoText(''); };
  const removeTodo = (idx: number) => setTodoItems(prev => prev.filter((_, i) => i !== idx));

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const newFiles: PendingFile[] = Array.from(files).map(f => ({
      file: f, id: `pf_${crypto.randomUUID()}`,
      preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
    }));
    setPendingFiles(prev => [...prev, ...newFiles]);
    e.target.value = '';
  };

  const removePendingFile = (id: string) => {
    setPendingFiles(prev => {
      const f = prev.find(p => p.id === id);
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return prev.filter(p => p.id !== id);
    });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (!files.length) return;
    const newFiles: PendingFile[] = Array.from(files).map(f => ({
      file: f, id: `pf_${crypto.randomUUID()}`,
      preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
    }));
    setPendingFiles(prev => [...prev, ...newFiles]);
  };

  const uploadFiles = async (taskId: string) => {
    if (pendingFiles.length === 0) return;
    const rows: { task_id: string; file_name: string; file_size: number; file_type: string; storage_path: string; uploaded_by: string }[] = [];
    const failed: { name: string; message: string }[] = [];
    for (const pf of pendingFiles) {
      const ext = pf.file.name.split('.').pop() || '';
      const storagePath = `${taskId}/${crypto.randomUUID()}.${ext}`;
      // Store the SERVER's effective path — cloud workspaces get a ws/ prefix.
      const { data: up, error } = await supabase.storage.from('task-images').upload(storagePath, pf.file);
      if (error) {
        console.error('Upload error:', error);
        failed.push({ name: pf.file.name, message: error.message });
        continue;
      }
      rows.push({ task_id: taskId, file_name: pf.file.name, file_size: pf.file.size, file_type: pf.file.type, storage_path: up?.path || storagePath, uploaded_by: currentMemberId });
    }
    if (rows.length > 0) await supabase.from('task_attachments').insert(rows);
    // The task itself was created — but silently dropping attachments (e.g.
    // beta 空間已滿 413) reads as data loss. Surface the server's reason.
    if (failed.length > 0) {
      toast.error(`${failed[0].message}（${failed.map((f) => f.name).join('、')}）`);
    }
  };

  const handleSubmitAttempt = () => {
    if (isSubmitting) return;
    if (isValid) { setShowValidationErrors(false); handleSubmit(); return; }
    setShowValidationErrors(true);
    const missing: string[] = [];
    if (!title.trim()) missing.push(t('taskCreate.fields.title'));
    if (!projectId) missing.push(t('taskCreate.fields.project'));
    if (requiredFields.dueDate && !dueDate) missing.push(t('taskCreate.fields.dueDate'));
    if (requiredFields.startDate && !startDate) missing.push(t('taskCreate.fields.startDate'));
    if (requiredFields.assignee && !assigneeId) missing.push(t('taskCreate.fields.assignee'));
    if (requiredFields.reviewer && !reviewerId) missing.push(t('taskCreate.fields.reviewer'));
    if (requiredFields.tags && selectedTagIds.length === 0) missing.push(t('taskCreate.fields.tags'));
    if (requiredFields.background && !background.trim()) missing.push(t('taskCreate.fields.background'));
    if (requiredFields.requirement && !requirement.trim()) missing.push(t('taskCreate.fields.requirement'));
    if (requiredFields.notes && !notes.trim()) missing.push(t('taskCreate.fields.notes'));
    if (requiredFields.checks && checkItems.length === 0) missing.push(t('taskCreate.fields.checks'));
    if (requiredFields.todos && todoItems.length === 0) missing.push(t('taskCreate.fields.todos'));
    if (requiredFields.gitlabUrl && !gitlabUrl.trim()) missing.push(t('taskCreate.fields.gitlabUrl'));
    if (requiredFields.deployments && deployments.length === 0) missing.push(t('taskCreate.fields.deployments'));
    toast.error(t('taskCreate.missingRequiredFields', { fields: missing.join('、') }));
  };

  const handleSubmit = async () => {
    if (!isValid || isSubmitting) return;
    setIsSubmitting(true);
    const status = statuses.find(s => s.id === statusId);
    const now = new Date().toISOString().split('T')[0];
    const taskKey = generateTaskKey();
    const taskId = `t_${crypto.randomUUID()}`;
    const newTask: Task = {
      id: taskId, taskKey, projectId, title: title.trim(), statusId, priority,
      creatorId: currentMemberId,
      assigneeId: assigneeId || undefined, reviewerId: reviewerId || undefined,
      dueDate: dueDate ? format(dueDate, 'yyyy-MM-dd') : undefined,
      startedAt: startDate ? format(startDate, 'yyyy-MM-dd') : (status?.autoStart ? now : undefined),
      completedAt: status?.autoDone ? now : undefined,
      gitlabUrl: gitlabUrl.trim() || undefined,
      sortOrder: 0, createdAt: now, commentCount: 0, attachmentCount: 0,
      deployments, sprintId: currentSprint?.id || undefined,
      tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
    };
    try {
      setAllTasks(prev => [...prev, newTask]);
      await createTaskInDb(newTask);
      await logActivity(currentMemberId, 'create_task', title.trim(), taskId, taskKey);
      const proj = allProjects.find(p => p.id === projectId);
      sendSlackNotify({
        type: 'task_created', taskKey, taskTitle: title.trim(), taskId,
        projectName: proj?.name, actorName: currentMember?.name || t('common.unknown'),
        priority, assigneeName: assigneeId ? users.find(u => u.id === assigneeId)?.name : undefined,
        statusName: statuses.find(s => s.id === statusId)?.name,
        dueDate: dueDate ? format(dueDate, 'yyyy-MM-dd') : undefined,
      });
      if (background || requirement || notes) {
        await supabase.from('task_specs').insert({ id: `ts_${crypto.randomUUID()}`, task_id: taskId, background, requirement, notes });
      }
      if (checkItems.length > 0) {
        await supabase.from('task_checks').insert(checkItems.map((text, i) => ({ id: `tc_${crypto.randomUUID()}`, task_id: taskId, text, is_done: false, sort_order: i + 1 })));
      }
      if (todoItems.length > 0) {
        await supabase.from('task_todos').insert(todoItems.map((text, i) => ({ id: `td_${crypto.randomUUID()}`, task_id: taskId, text, is_done: false, sort_order: i + 1 })));
      }
      if (deployments.length > 0) {
        await supabase.from('task_deployments').insert(deployments.map(d => ({ task_id: taskId, environment: d.environment, status: d.status, deploy_date: d.deployDate || null })));
      }
      if (pendingFiles.length > 0) { setUploading(true); await uploadFiles(taskId); setUploading(false); }
      await supabase.from('status_logs').insert({ id: `sl_${crypto.randomUUID()}`, task_id: taskId, from_status_id: null, to_status_id: statusId, changed_by: currentMemberId });
      if (selectedTagIds.length > 0) {
        await supabase.from('task_tags').insert(selectedTagIds.map(tagId => ({ id: `tt_${crypto.randomUUID()}`, task_id: taskId, tag_id: tagId })) as unknown as Record<string, unknown>[]);
      }
      if (subtaskItems.length > 0) {
        for (const subtaskTitle of subtaskItems) {
          await createSubtask(taskId, subtaskTitle, projectId, statusId, newTask);
        }
      }
      toast.success(t('task.created'));
      setShowCreateTask(false);
      await Promise.all([refreshTaskSpecs(), refreshTaskChecks(), refreshTaskTodos(), refreshStatusLogs()]);
    } catch (err) {
      // Rollback optimistic update on failure
      setAllTasks(prev => prev.filter(t => t.id !== newTask.id));
      toast.error(t('task.createFailed') + (err instanceof Error ? err.message : t('error.unexpectedError')));
    } finally {
      setIsSubmitting(false);
    }
  };

  const groupedProjects = productLines
    .map(line => ({ line, projects: allProjects.filter(p => p.lineId === line.id && !p.isArchived) }))
    .filter(g => g.projects.length > 0);

  const fieldsProps = {
    projectId, setProjectId, statusId, setStatusId, priority, setPriority,
    assigneeId, setAssigneeId, reviewerId, setReviewerId,
    startDate, setStartDate, dueDate, setDueDate,
    gitlabUrl, setGitlabUrl, deployments, setDeployments,
    selectedTagIds, setSelectedTagIds, tags, refreshTags,
    showValidationErrors, setShowValidationErrors, requiredFields,
    groupedProjects, statuses,
    tagPickerOpen, setTagPickerOpen, tagPickerRef,
    newTagName, setNewTagName, newTagColor, setNewTagColor,
    tagManageMode, setTagManageMode, confirm,
  };

  return {
    showCreateTask, setShowCreateTask,
    title, setTitle,
    background, setBackground,
    requirement, setRequirement,
    notes, setNotes,
    users,
    projectId, allProjects,
    requiredFields,
    taskTemplates, applyTemplate,
    titleRef, fileInputRef,
    isValid, isSubmitting, uploading,
    showValidationErrors, setShowValidationErrors,
    todoItems, newTodoText, setNewTodoText, addTodo, removeTodo,
    checkItems, newCheckText, setNewCheckText, addCheck, removeCheck,
    subtaskItems, setSubtaskItems, newSubtaskText, setNewSubtaskText,
    pendingFiles, handleFileSelect, removePendingFile, handleDrop,
    fieldsProps, isMobile,
    hasFeature,
    handleSubmitAttempt,
    ConfirmDialog,
  };
}
