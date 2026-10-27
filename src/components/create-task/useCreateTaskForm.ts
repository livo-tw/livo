import { defaultTaskProject } from './defaultProject';
import { hasRichTextContent } from '@/lib/richTextContent';
import { taskWorkErrorCode } from '@/lib/taskWork/client';
import { subtaskCustomValues, subtaskNeedsFullForm, subtaskQuickCreateFields } from '@/lib/taskWork/subtaskDefaults';
import { useDeploymentEnvironments } from '@/context/DeploymentEnvironmentContext';
import { useState, useEffect, useRef, useMemo } from 'react';
import { customFieldDefault, customFieldFilled, customFieldHasValue, type CustomFieldDraft } from '@/lib/customFieldValues';
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
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from '@/lib/uploadLimits';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { Task, Priority, TaskDeployment } from '@/types';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { randomUUID } from '@/lib/generateId';

interface PendingFile {
  file: File;
  preview?: string;
  id: string;
}

export function useCreateTaskForm() {
  const { t } = useTranslation();
  const environmentConfig = useDeploymentEnvironments();
  const { currentMemberId, currentMember } = useAuthContext();
  const { users } = useMemberContext();
  const { showCreateTask, setShowCreateTask, setSelectedTask, requiredFields, currentView, createTaskSeed } = useUIContext();
  // Visible in the form: a task made from the backlog stays in the backlog unless the member ticks it.
  const [joinSprint, setJoinSprint] = useState(true);
  const { selectedProjectId, selectedLineId, allProjects, productLines } = useProjectContext();
  const { allTasks, setAllTasks, statuses, tags, refreshTags, refreshTasks, createTaskInDb, createSubtask, refreshTaskSpecs, refreshTaskChecks, refreshTaskTodos, refreshStatusLogs, refreshCustomFieldValues, taskTemplates, customFields, upsertCustomFieldValue } = useTaskContext();
  const { currentSprint } = useSprintContext();
  const { hasFeature } = useLicense();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const isMobile = useIsMobile();

  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  // The chosen project's custom fields, starting from their defaults.
  const [customValues, setCustomValues] = useState<Record<string, CustomFieldDraft>>({});
  const [customTouched, setCustomTouched] = useState(false);
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
  const creationInFlight = useRef<string | null>(null);
  const createdTask = useRef<Task | null>(null);
  const draftOwner = useRef(currentMemberId);
  const [partialCreation, setPartialCreation] = useState<{ task: Task; sections: string[] } | null>(null);
  const childSubmission = useRef<{ parentId:string; invoke:() => Promise<Task | null> } | null>(null);
  const [uncertainSubtask, setUncertainSubtask] = useState(false);
  const [retainedChildParentId, setRetainedChildParentId] = useState<string | null>(null);
  const subtaskParentId = partialCreation ? undefined : retainedChildParentId || createTaskSeed?.parentTaskId;
  const isSubtask = !!subtaskParentId;
  const parentTask = allTasks.find(task => task.id === subtaskParentId);
  const creationVisit = useRef({ memberId: currentMemberId, parentId: subtaskParentId, generation: 0 });
  if (creationVisit.current.memberId !== currentMemberId || creationVisit.current.parentId !== subtaskParentId) {
    creationVisit.current = { memberId: currentMemberId, parentId: subtaskParentId, generation: creationVisit.current.generation + 1 };
  }
  const creationScope = `${currentMemberId}:${creationVisit.current.generation}:${subtaskParentId || ''}`;
  const activeCreationScope = useRef(creationScope); activeCreationScope.current = creationScope;
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
    activeCreationScope.current = creationScope;
    return () => { if (activeCreationScope.current === creationScope) activeCreationScope.current = ''; };
  }, [creationScope]);

  useEffect(() => {
    if (draftOwner.current === currentMemberId) return;
    draftOwner.current = currentMemberId;
    createdTask.current = null; setPartialCreation(null); childSubmission.current = null; setUncertainSubtask(false); setRetainedChildParentId(null);
    creationInFlight.current = null; setIsSubmitting(false); setUploading(false);
    setShowCreateTask(false);
  }, [currentMemberId, setShowCreateTask]);

  useEffect(() => { if (showCreateTask && partialCreation && createTaskSeed) toast.info(t('taskCreate.recovery.resolveFirst')); }, [showCreateTask, partialCreation, createTaskSeed, t]);

  // Reset only when the form opens: a project or line changing elsewhere (realtime)
  // while it is open must not wipe what was typed.
  const lastOpenedScope = useRef<string | null>(null);
  useEffect(() => {
    const opening = showCreateTask && lastOpenedScope.current !== creationScope;
    lastOpenedScope.current = showCreateTask ? creationScope : null;
    if (opening && !partialCreation && !uncertainSubtask) {
      createdTask.current = null;
      creationInFlight.current = null; setIsSubmitting(false); setUploading(false);
      setJoinSprint(!isSubtask && currentView !== 'backlog');
      setProjectId(isSubtask ? parentTask?.projectId || '' : defaultTaskProject(groupProjectsByLine(productLines, allProjects), selectedProjectId, selectedLineId));
      setTitle(isSubtask ? createTaskSeed?.title || '' : ''); setStatusId(isSubtask ? parentTask?.statusId || '' : statuses[0]?.id || ''); setPriority('medium');
      const inherited = parentTask ? subtaskQuickCreateFields(parentTask, requiredFields) : null;
      setAssigneeId(inherited?.assigneeId && users.some(user => user.id === inherited.assigneeId && user.isActive) ? inherited.assigneeId : '');
      setReviewerId(inherited?.reviewerId && users.some(user => user.id === inherited.reviewerId && user.isActive) ? inherited.reviewerId : '');
      setDueDate(inherited?.dueDate ? new Date(inherited.dueDate + 'T00:00:00') : undefined); setStartDate(undefined);
      setBackground(''); setRequirement(''); setNotes(''); setGitlabUrl('');
      setCheckItems([]); setNewCheckText(''); setTodoItems([]); setNewTodoText('');
      setDeployments([]); setPendingFiles([]); setSelectedTagIds([]);
      setTagPickerOpen(false); setNewTagName(''); setTagManageMode(false);
      setSubtaskItems([]); setNewSubtaskText('');
      setTimeout(() => titleRef.current?.focus(), 100);
    }
  }, [showCreateTask, creationScope, isSubtask, parentTask, createTaskSeed, selectedProjectId, selectedLineId, allProjects, productLines, currentView, partialCreation, uncertainSubtask]);

  const projectCustomFields = useMemo(() => (customFields || []).filter(field => field.projectId === projectId).sort((a, b) => a.sortOrder - b.sortOrder), [customFields, projectId]);
  const customFieldsRef = useRef(projectCustomFields); customFieldsRef.current = projectCustomFields;
  // Defaults are filled in when the form opens or the project changes, not when a field list refreshes.
  useEffect(() => {
    if (!showCreateTask || partialCreation || uncertainSubtask) return;
    setCustomValues(Object.fromEntries(customFieldsRef.current.map(field => [field.id, customFieldDefault(field)])));
    setCustomTouched(false);
  }, [showCreateTask, projectId, partialCreation]);
  const setCustomValue = (fieldId: string, value: CustomFieldDraft) => { setCustomValues(previous => ({ ...previous, [fieldId]: value })); setCustomTouched(true); setShowValidationErrors(false); };
  const missingCustomFields = projectCustomFields.filter(field => field.isRequired && !customFieldFilled(field, customValues[field.id]));
  const subtasksRequireFullForm = subtaskNeedsFullForm(requiredFields, projectCustomFields.some(field => field.isRequired));

  const applyTemplate = (templateId: string) => {
    if (isSubmitting || partialCreation || uncertainSubtask) return;
    const tmpl = taskTemplates.find(t => t.id === templateId);
    if (!tmpl) return;
    if (isSubtask && tmpl.projectId && tmpl.projectId !== parentTask?.projectId) { toast.error(t('taskCreate.subtaskTemplateProject')); return; }
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
    if (isSubtask && (!parentTask || parentTask.parentTaskId || parentTask.projectId !== projectId)) return false;
    if (!title.trim() || !projectId) return false;
    if (missingCustomFields.length) return false;
    if (requiredFields.dueDate && !dueDate) return false;
    if (requiredFields.startDate && !startDate) return false;
    if (requiredFields.assignee && !assigneeId) return false;
    if (requiredFields.reviewer && !reviewerId) return false;
    if (requiredFields.tags && selectedTagIds.length === 0) return false;
    if (requiredFields.background && !hasRichTextContent(background)) return false;
    if (requiredFields.requirement && !hasRichTextContent(requirement)) return false;
    if (requiredFields.notes && !hasRichTextContent(notes)) return false;
    if (requiredFields.checks && checkItems.length === 0) return false;
    if (requiredFields.todos && todoItems.length === 0) return false;
    if (requiredFields.gitlabUrl && !gitlabUrl.trim()) return false;
    if (requiredFields.deployments && deployments.length === 0) return false;
    return true;
  })();

  const generateTaskKey = () => {
    const project = allProjects.find(p => p.id === projectId);
    if (!project) return 'TASK-1';
    // Count every task that carries this project's prefix, including tasks moved to
    // another project (they keep their key): keys are unique across projects.
    const prefix = `${project.key}-`;
    const maxNum = allTasks.reduce((max, t) => {
      if (!t.taskKey.startsWith(prefix)) return max;
      const rest = t.taskKey.slice(prefix.length);
      return /^\d+$/.test(rest) ? Math.max(max, Number(rest)) : max;
    }, 0);
    return `${project.key}-${maxNum + 1}`;
  };

  const addCheck = () => { if (!newCheckText.trim()) return; setCheckItems(prev => [...prev, newCheckText.trim()]); setNewCheckText(''); };
  const removeCheck = (idx: number) => setCheckItems(prev => prev.filter((_, i) => i !== idx));
  const addTodo = () => { if (!newTodoText.trim()) return; setTodoItems(prev => [...prev, newTodoText.trim()]); setNewTodoText(''); };
  const removeTodo = (idx: number) => setTodoItems(prev => prev.filter((_, i) => i !== idx));

  // Reject oversized files as soon as they're picked, instead of after the task
  // has been created and the whole file has been sent to the server.
  const addPendingFiles = (files: FileList) => {
    if (isSubtask) { toast.info(t('taskCreate.subtaskAttachmentsAfterCreation')); return; }
    if (isSubmitting || partialCreation || uncertainSubtask) return;
    const all = Array.from(files);
    const oversized = all.filter(f => f.size > MAX_UPLOAD_BYTES);
    if (oversized.length > 0) {
      toast.error(t('taskDetail.attachments.fileSizeExceeded', { files: oversized.map(f => f.name).join(', '), size: MAX_UPLOAD_MB }));
    }
    const newFiles: PendingFile[] = all.filter(f => f.size <= MAX_UPLOAD_BYTES).map(f => ({
      file: f, id: `pf_${randomUUID()}`,
      preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
    }));
    if (newFiles.length > 0) setPendingFiles(prev => [...prev, ...newFiles]);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    addPendingFiles(files);
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
    addPendingFiles(files);
  };

  const uploadFiles = async (taskId: string, assertCurrentScope: () => void) => {
    if (pendingFiles.length === 0) return;
    const rows: { task_id: string; file_name: string; file_size: number; file_type: string; storage_path: string; uploaded_by: string }[] = [];
    const failed: { name: string; message: string }[] = [];
    for (const pf of pendingFiles) {
      assertCurrentScope();
      const ext = pf.file.name.split('.').pop() || '';
      const storagePath = `${taskId}/${randomUUID()}.${ext}`;
      // Store the SERVER's effective path — cloud workspaces get a ws/ prefix.
      const { data: up, error } = await supabase.storage.from('task-images').upload(storagePath, pf.file);
      assertCurrentScope();
      if (error) {
        console.error('Upload error:', error);
        failed.push({ name: pf.file.name, message: error.message });
        continue;
      }
      rows.push({ task_id: taskId, file_name: pf.file.name, file_size: pf.file.size, file_type: pf.file.type, storage_path: up?.path || storagePath, uploaded_by: currentMemberId });
    }
    if (rows.length > 0) {
      assertCurrentScope();
      const { error } = await supabase.from('task_attachments').insert(rows);
      assertCurrentScope();
      if (error) throw error;
    }
    // The task itself was created — but silently dropping attachments (e.g.
    // beta 空間已滿 413) reads as data loss. Surface the server's reason.
    if (failed.length > 0) {
      throw new Error(`${failed[0].message}（${failed.map((f) => f.name).join('、')}）`);
    }
  };

  const handleSubmitAttempt = () => {
    if (isSubmitting || creationInFlight.current || createdTask.current || partialCreation) return;
    if (uncertainSubtask) { void handleSubmit(); return; }
    if (isSubtask && (!parentTask || parentTask.parentTaskId || parentTask.projectId !== projectId)) { toast.error(t('taskWork.errors.work_invalid_parent')); return; }
    if (isSubtask && subtaskItems.length) { toast.error(t('task.noNestedSubtasks')); return; }
    if (isSubtask && pendingFiles.length) { toast.info(t('taskCreate.subtaskAttachmentsAfterCreation')); return; }
    if (!isSubtask && subtaskItems.length && subtasksRequireFullForm) { toast.info(t('taskCreate.subtasksNeedFullForm')); return; }
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
    if (requiredFields.background && !hasRichTextContent(background)) missing.push(t('taskCreate.fields.background'));
    if (requiredFields.requirement && !hasRichTextContent(requirement)) missing.push(t('taskCreate.fields.requirement'));
    if (requiredFields.notes && !hasRichTextContent(notes)) missing.push(t('taskCreate.fields.notes'));
    if (requiredFields.checks && checkItems.length === 0) missing.push(t('taskCreate.fields.checks'));
    if (requiredFields.todos && todoItems.length === 0) missing.push(t('taskCreate.fields.todos'));
    if (requiredFields.gitlabUrl && !gitlabUrl.trim()) missing.push(t('taskCreate.fields.gitlabUrl'));
    if (requiredFields.deployments && deployments.length === 0) missing.push(t('taskCreate.fields.deployments'));
    for (const field of missingCustomFields) missing.push(field.fieldName);
    toast.error(t('taskCreate.missingRequiredFields', { fields: missing.join('、') }));
  };

  const handleSubmit = async () => {
    if ((!isValid && !uncertainSubtask) || isSubmitting || creationInFlight.current || createdTask.current || partialCreation) return;
    if (!uncertainSubtask && deployments.length && (!environmentConfig.ready || deployments.some(deployment => !environmentConfig.values.includes(deployment.environment)))) { toast.error(t('deploymentEnvironments.changed')); return; }
    if (isSubtask) {
      if (!uncertainSubtask && (!parentTask || parentTask.parentTaskId || parentTask.projectId !== projectId || pendingFiles.length || subtaskItems.length)) return;
      creationInFlight.current = creationScope; setIsSubmitting(true);
      const current = () => activeCreationScope.current === creationScope;
      try {
        const request = uncertainSubtask ? childSubmission.current : parentTask ? {
          parentId: parentTask.id,
          invoke: () => createSubtask(parentTask.id, title.trim(), projectId, statusId, undefined, {
            priority, assigneeId: assigneeId || null, reviewerId: reviewerId || null, dueDate: dueDate ? format(dueDate, 'yyyy-MM-dd') : null,
            details: { background, requirement, notes, startDate: startDate ? format(startDate, 'yyyy-MM-dd') : null,
              gitlabUrl: gitlabUrl.trim() || null, checks: [...checkItems], todos: [...todoItems], tagIds: [...selectedTagIds],
              deployments: deployments.map(value => ({ ...value, deployDate: value.deployDate || null })),
              customFields: subtaskCustomValues(projectCustomFields, customValues) },
          }),
        } : null;
        if (!request) return;
        childSubmission.current = request;
        const created = await request.invoke();
        if (!current()) return;
        if (!created) { childSubmission.current = null; setUncertainSubtask(false); return; }
        await Promise.all([refreshTasks(), refreshTaskSpecs(), refreshTaskChecks(), refreshTaskTodos(), refreshStatusLogs(), refreshCustomFieldValues()])
          .catch(() => { if (current()) toast.info(t('taskCreate.recovery.refreshFailed')); });
        if (!current()) return;
        childSubmission.current = null; setUncertainSubtask(false); setRetainedChildParentId(null);
        setIsSubmitting(false); toast.success(t('task.created'));
        setShowCreateTask(false); setSelectedTask(created);
      } catch (error) {
        if (current()) {
          if (taskWorkErrorCode(error) === 'work_transport_error') { setRetainedChildParentId(childSubmission.current?.parentId || subtaskParentId || null); setUncertainSubtask(true); toast.error(t('taskCreate.subtaskResultUnknown')); }
          else { childSubmission.current = null; setUncertainSubtask(false); }
        }
      } finally {
        if (creationInFlight.current === creationScope) creationInFlight.current = null;
        if (current()) setIsSubmitting(false);
      }
      return;
    }
    if (subtaskItems.length && subtasksRequireFullForm) { toast.info(t('taskCreate.subtasksNeedFullForm')); return; }
    creationInFlight.current = creationScope;
    setIsSubmitting(true);
    const status = statuses.find(s => s.id === statusId);
    const now = new Date().toISOString().split('T')[0];
    const taskKey = generateTaskKey();
    const taskId = `t_${randomUUID()}`;
    const newTask: Task = {
      id: taskId, taskKey, projectId, title: title.trim(), statusId, priority,
      creatorId: currentMemberId,
      assigneeId: assigneeId || undefined, reviewerId: reviewerId || undefined,
      dueDate: dueDate ? format(dueDate, 'yyyy-MM-dd') : undefined,
      startedAt: startDate ? format(startDate, 'yyyy-MM-dd') : (status?.autoStart ? now : undefined),
      completedAt: status?.autoDone ? now : undefined,
      gitlabUrl: gitlabUrl.trim() || undefined,
      sortOrder: 0, createdAt: now, commentCount: 0, attachmentCount: 0,
      deployments, sprintId: joinSprint && currentSprint ? currentSprint.id : undefined,
      tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
    };
    const sections = [
      ...(background || requirement || notes ? ['spec'] : []),
      ...(checkItems.length ? ['checks'] : []), ...(todoItems.length ? ['todos'] : []),
      ...(deployments.length ? ['deployments'] : []), ...(pendingFiles.length ? ['files'] : []),
      ...(projectCustomFields.some(field => customFieldHasValue(customValues[field.id])) ? ['custom'] : []),
      'history', ...(selectedTagIds.length ? ['tags'] : []), ...(subtaskItems.length ? ['subtasks'] : []),
    ];
    const assertCurrentScope = () => {
      if (activeCreationScope.current !== creationScope) throw new Error('creation_scope_changed');
    };
    const saveSection = async (section: string, action: () => PromiseLike<{ error?: { message: string } | null }>) => {
      assertCurrentScope();
      const result = await action();
      assertCurrentScope();
      if (result.error) throw result.error;
      sections.splice(sections.indexOf(section), 1);
    };
    try {
      setAllTasks(prev => [...prev, newTask]);
      const created = await createTaskInDb(newTask);
      if (activeCreationScope.current !== creationScope) {
        // Do not compensate or continue writes with a different login/session.
        if (created) console.info('[LIVO] Task created for a previous form session', { taskId: created.id });
        return;
      }
      // The insert failed (already explained): keep the form open with what was typed.
      if (!created) { setAllTasks(prev => prev.filter(task => task.id !== taskId)); return; }
      // The database may have kept a different key; notifications use the stored one.
      createdTask.current = created;
      const storedKey = created.taskKey;
      await logActivity(currentMemberId, 'create_task', title.trim(), taskId, storedKey);
      assertCurrentScope();
      const proj = allProjects.find(p => p.id === projectId);
      sendSlackNotify({
        type: 'task_created', taskKey: storedKey, taskTitle: title.trim(), taskId,
        projectName: proj?.name, actorName: currentMember?.name || t('common.unknown'),
        priority, assigneeName: assigneeId ? users.find(u => u.id === assigneeId)?.name : undefined,
        statusName: statuses.find(s => s.id === statusId)?.name,
        dueDate: dueDate ? format(dueDate, 'yyyy-MM-dd') : undefined,
      });
      if (background || requirement || notes) {
        await saveSection('spec', () => supabase.from('task_specs').insert({ id: `ts_${randomUUID()}`, task_id: taskId, background, requirement, notes }));
      }
      if (checkItems.length > 0) {
        await saveSection('checks', () => supabase.from('task_checks').insert(checkItems.map((text, i) => ({ id: `tc_${randomUUID()}`, task_id: taskId, text, is_done: false, sort_order: i + 1 }))));
      }
      if (todoItems.length > 0) {
        await saveSection('todos', () => supabase.from('task_todos').insert(todoItems.map((text, i) => ({ id: `td_${randomUUID()}`, task_id: taskId, text, is_done: false, sort_order: i + 1 }))));
      }
      if (deployments.length > 0) {
        await saveSection('deployments', () => supabase.from('task_deployments').insert(deployments.map(d => ({ task_id: taskId, environment: d.environment, status: d.status, deploy_date: d.deployDate || null }))));
      }
      if (pendingFiles.length > 0) {
        setUploading(true); await uploadFiles(taskId, assertCurrentScope);
        assertCurrentScope();
        sections.splice(sections.indexOf('files'), 1);
      }
      for (const field of projectCustomFields) {
        assertCurrentScope();
        const value = customValues[field.id];
        if (customFieldHasValue(value)) {
          await upsertCustomFieldValue(taskId, field.id, value!);
          assertCurrentScope();
          // The shared field editor reports errors itself but returns void. Confirm
          // this new task actually has the value before treating its draft as saved.
          const stored = await supabase.from('task_custom_field_values').select('*').eq('task_id', taskId).eq('field_id', field.id).maybeSingle();
          assertCurrentScope();
          if (stored.error || !stored.data) throw stored.error || new Error(t('error.saveFailed'));
        }
      }
      if (sections.includes('custom')) sections.splice(sections.indexOf('custom'), 1);
      await saveSection('history', () => supabase.from('status_logs').insert({ id: `sl_${randomUUID()}`, task_id: taskId, from_status_id: null, to_status_id: statusId, changed_by: currentMemberId }));
      if (selectedTagIds.length > 0) {
        await saveSection('tags', () => supabase.from('task_tags').insert(selectedTagIds.map(tagId => ({ id: `tt_${randomUUID()}`, task_id: taskId, tag_id: tagId }))));
      }
      if (subtaskItems.length > 0) {
        for (const subtaskTitle of subtaskItems) {
          assertCurrentScope();
          const subtask = await createSubtask(taskId, subtaskTitle, projectId, statusId, created);
          assertCurrentScope();
          if (!subtask) throw new Error(t('task.createFailed'));
        }
      }
      if (sections.includes('subtasks')) sections.splice(sections.indexOf('subtasks'), 1);
      await Promise.all([refreshTaskSpecs(), refreshTaskChecks(), refreshTaskTodos(), refreshStatusLogs()])
        .catch(() => { if (activeCreationScope.current === creationScope) toast.info(t('taskCreate.recovery.refreshFailed')); });
      assertCurrentScope();
      createdTask.current = null;
      toast.success(t('task.created'));
      setShowCreateTask(false);
    } catch (err) {
      if (activeCreationScope.current !== creationScope) return;
      if (createdTask.current) {
        // The card exists. Preserve its draft and identity; another Create would duplicate it.
        setPartialCreation({ task: createdTask.current, sections: sections.length ? [...sections] : ['details'] });
        toast.error(t('taskCreate.recovery.createdPartial', { key: createdTask.current.taskKey }));
      } else {
        setAllTasks(prev => prev.filter(task => task.id !== newTask.id));
        toast.error(t('task.createFailed') + (err instanceof Error ? err.message : t('error.unexpectedError')));
      }
    } finally {
      if (activeCreationScope.current === creationScope && creationInFlight.current === creationScope) {
        creationInFlight.current = null;
        setUploading(false);
        setIsSubmitting(false);
      }
    }
  };

  const groupedProjects = groupProjectsByLine(productLines, allProjects);

  // Closing asks first once something was typed or added, so a misclick does not lose it.
  const dirty = !!title.trim() || hasRichTextContent(background) || hasRichTextContent(requirement) || hasRichTextContent(notes)
    || checkItems.length > 0 || todoItems.length > 0 || subtaskItems.length > 0 || pendingFiles.length > 0 || deployments.length > 0 || !!gitlabUrl.trim() || customTouched;
  const requestClose = async () => {
    if (isSubmitting) return;
    if (partialCreation || uncertainSubtask) { setShowCreateTask(false); return; }
    if (dirty && !(await confirm({ title: t('taskCreate.discardTitle'), description: t('taskCreate.discardDesc'), destructive: true }))) return;
    if (activeCreationScope.current !== creationScope) return;
    setRetainedChildParentId(null); setShowCreateTask(false);
    if (isSubtask && parentTask) setSelectedTask(parentTask);
  };

  const openCreatedTask = () => {
    if (!partialCreation) return;
    setSelectedTask(partialCreation.task);
    setShowCreateTask(false);
  };
  const discardPartialDraft = async () => {
    if (!(await confirm({ title: t('taskCreate.recovery.discard'), description: t('taskCreate.recovery.discardConfirm'), destructive: true }))) return;
    if (activeCreationScope.current !== creationScope) return;
    createdTask.current = null;
    setPartialCreation(null);
    setShowCreateTask(false);
  };

  const fieldsProps = {
    projectId, setProjectId: isSubtask ? () => {} : setProjectId, projectLocked:isSubtask,
    lockedProjectName: isSubtask ? allProjects.find(project => project.id === projectId)?.name : undefined,
    statusId, setStatusId, priority, setPriority,
    assigneeId, setAssigneeId, reviewerId, setReviewerId,
    startDate, setStartDate, dueDate, setDueDate,
    gitlabUrl, setGitlabUrl, deployments, setDeployments,
    selectedTagIds, setSelectedTagIds, tags, refreshTags,
    showValidationErrors, setShowValidationErrors, requiredFields,
    groupedProjects, statuses,
    tagPickerOpen, setTagPickerOpen, tagPickerRef,
    newTagName, setNewTagName, newTagColor, setNewTagColor,
    tagManageMode, setTagManageMode, confirm,
    sprintName: isSubtask ? undefined : currentSprint?.name, joinSprint, setJoinSprint,
  };
  const customFieldsProps = { fields: projectCustomFields, values: customValues, onChange: setCustomValue, showValidationErrors };

  return {
    showCreateTask: showCreateTask && draftOwner.current === currentMemberId, setShowCreateTask,
    title, setTitle,
    isSubtask, parentTask, subtasksRequireFullForm, uncertainSubtask,
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
    fieldsProps, customFieldsProps, isMobile,
    hasFeature,
    handleSubmitAttempt, requestClose, partialCreation, openCreatedTask, discardPartialDraft,
    ConfirmDialog,
  };
}
