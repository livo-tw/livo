import { supabase } from '@/integrations/supabase/client';
import { useRef } from 'react';
import { sendSlackNotify } from '@/lib/slackNotify';
import { toast } from 'sonner';
import { taskWriteErrorText } from '@/lib/approval/feedback';
import { logActivity } from '@/lib/activityLog';
import i18n from '@/i18n';
import { createNotification, type EnvName } from '../utils';
import type { Task, Status, User, Project, TaskCustomFieldValue } from '@/types';
import { copyText } from '@/lib/clipboard';
import { applyTaskUpdate } from '@/lib/taskWork/projectMove';

export interface UseTaskActionsParams {
  task: Task | null;
  project: Project | null;
  statuses: Status[];
  users: User[];
  allProjects: Project[];
  currentMemberId: string | undefined;
  currentMember: User | null | undefined;
  status: Status | undefined;
  assignee: User | undefined;
  setAllTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setSelectedTask: React.Dispatch<React.SetStateAction<Task | null>>;
  updateTaskInDb: (taskId: string, updates: Partial<Task>) => Promise<boolean | void> | void;
  confirm: (opts: { title?: string; description: string; destructive?: boolean }) => Promise<boolean>;
  undoStack: { push: (entry: { type: string; description: string; undo: () => Promise<void> }) => void };
  customFieldValues: TaskCustomFieldValue[];
  upsertCustomFieldValue: (taskId: string, fieldId: string, value: Partial<TaskCustomFieldValue>) => Promise<void>;
  trackPresence: (extraFields?: Record<string, unknown>) => Promise<void>;
  taskSpecs: { taskId: string; background?: string; requirement?: string; notes?: string }[];
  checkItems: string[];
  todoItems: string[];
  createTaskTemplate: (template: Record<string, unknown>) => Promise<void>;
  createSubtask: (parentId: string, title: string, projectId: string, statusId: string) => Promise<Task | null>;
  sidebarNewSubtaskTitle: string;
  setSidebarNewSubtaskTitle: (v: string) => void;
  setSidebarAddingSubtask: (v: boolean) => void;
  showSaveTemplate: boolean;
  setShowSaveTemplate: (v: boolean) => void;
  templateName: string;
  setTemplateName: (v: string) => void;
  templateScope: 'project' | 'global';
}

export function useTaskActions(params: UseTaskActionsParams) {
  const subtaskScope = `${params.currentMemberId}:${params.task?.id || ''}`;
  const activeSubtaskScope = useRef(subtaskScope); activeSubtaskScope.current = subtaskScope;
  const activeSubtaskTitle = useRef(params.sidebarNewSubtaskTitle); activeSubtaskTitle.current = params.sidebarNewSubtaskTitle;
  const pendingSubtasks = useRef(new Set<string>());
  const {
    task, project, statuses, users, allProjects,
    currentMemberId, currentMember, status, assignee,
    setAllTasks, setSelectedTask, updateTaskInDb,
    confirm,
    customFieldValues, upsertCustomFieldValue, trackPresence,
    taskSpecs, checkItems, todoItems,
    createTaskTemplate, createSubtask,
    sidebarNewSubtaskTitle, setSidebarNewSubtaskTitle, setSidebarAddingSubtask,
    setShowSaveTemplate, templateName, setTemplateName, templateScope,
  } = params;

  /** Resolves false when the save was refused or failed (updateTaskInDb reports why). */
  const updateTask = (updates: Partial<Task>): Promise<boolean> => {
    if (!task) return Promise.resolve(false);
    const updated = { ...task, ...updates };
    setAllTasks(prev => applyTaskUpdate(prev, updated, task.projectId));
    setSelectedTask(updated);
    const saved = Promise.resolve(updateTaskInDb(task.id, updates));
    // Activity, inbox notifications and Slack notices describe the saved task, so they
    // run only after the write succeeds: a refused save (permission, approval, conflict)
    // must not log or announce a change that did not happen. slack-notify also reads the
    // assignee and reviewer from the stored row.
    const afterSave: Array<() => void> = [];
    const log = (...args: Parameters<typeof logActivity>) => { afterSave.push(() => { void logActivity(...args); }); };
    const notify = (...args: Parameters<typeof createNotification>) => { afterSave.push(() => { void createNotification(...args); }); };
    const notifyAfterSave = (payload: Parameters<typeof sendSlackNotify>[0]) => { afterSave.push(() => { void sendSlackNotify(payload); }); };
    const outcome = saved.then(ok => { if (ok !== false) afterSave.forEach(run => run()); return ok !== false; }, () => false);

    if (updates.title && updates.title !== task.title)
      log(currentMemberId, 'update_title', `「${task.title}」→「${updates.title}」`, task.id, task.taskKey);
    if (updates.statusId && updates.statusId !== task.statusId) {
      const oldS = statuses.find(s => s.id === task.statusId);
      const newS = statuses.find(s => s.id === updates.statusId);
      log(currentMemberId, 'update_status', `${oldS?.name || '—'} → ${newS?.name || '—'}`, task.id, task.taskKey);
    }
    if (updates.priority && updates.priority !== task.priority) {
      const pLabels: Record<string, string> = { highest: i18n.t('priority.highest'), high: i18n.t('priority.high'), medium: i18n.t('priority.medium'), low: i18n.t('priority.low'), lowest: i18n.t('priority.lowest') };
      log(currentMemberId, 'update_priority', `${pLabels[task.priority] || task.priority} → ${pLabels[updates.priority] || updates.priority}`, task.id, task.taskKey);
    }
    if (updates.assigneeId !== undefined && updates.assigneeId !== task.assigneeId) {
      const oldA = users.find(u => u.id === task.assigneeId);
      const newA = users.find(u => u.id === updates.assigneeId);
      log(currentMemberId, 'update_assignee', `${oldA?.name || i18n.t('common.unassigned')} → ${newA?.name || i18n.t('common.unassigned')}`, task.id, task.taskKey);
    }
    if (updates.reviewerId !== undefined && updates.reviewerId !== task.reviewerId) {
      const oldR = users.find(u => u.id === task.reviewerId);
      const newR = users.find(u => u.id === updates.reviewerId);
      log(currentMemberId, 'update_reviewer', `${oldR?.name || i18n.t('common.unassigned')} → ${newR?.name || i18n.t('common.unassigned')}`, task.id, task.taskKey);
    }
    if (updates.dueDate !== undefined && updates.dueDate !== task.dueDate)
      log(currentMemberId, 'update_due_date', `${task.dueDate || '—'} → ${updates.dueDate || '—'}`, task.id, task.taskKey);
    if (updates.projectId && updates.projectId !== task.projectId) {
      const oldP = allProjects.find(p => p.id === task.projectId);
      const newP = allProjects.find(p => p.id === updates.projectId);
      log(currentMemberId, 'update_project', `${oldP?.name || '—'} → ${newP?.name || '—'}`, task.id, task.taskKey);
    }
    if (updates.department !== undefined && updates.department !== task.department)
      log(currentMemberId, 'update_department', `${task.department || '—'} → ${updates.department || '—'}`, task.id, task.taskKey);
    if (updates.deployments)
      log(currentMemberId, 'update_deploy', i18n.t('activity.updateDeploy'), task.id, task.taskKey);

    if (updates.assigneeId && updates.assigneeId !== task.assigneeId) {
      notify(updates.assigneeId, currentMemberId, 'assign', task.id, task.title);
      const oldAssignee = users.find(u => u.id === task.assigneeId);
      const newAssignee = users.find(u => u.id === updates.assigneeId);
      const dmTargets: { email: string; name?: string; reason: string }[] = [];
      if (newAssignee && newAssignee.id !== currentMemberId)
        dmTargets.push({ email: newAssignee.email, name: newAssignee.name, reason: i18n.t('taskDetail.assignedAsAssignee') });
      notifyAfterSave({
        type: 'assignee_changed', taskKey: task.taskKey, taskTitle: task.title, taskId: task.id,
        projectName: project?.name, actorName: currentMember?.name || i18n.t('common.unknown'),
        oldAssignee: oldAssignee?.name || i18n.t('common.unassigned'), newAssignee: newAssignee?.name || i18n.t('common.unassigned'),
        statusName: status?.name, priority: task.priority, dmTargets,
      });
    }
    if (updates.priority && updates.priority !== task.priority) {
      const pLabels2: Record<string, string> = { highest: i18n.t('priority.highest'), high: i18n.t('priority.high'), medium: i18n.t('priority.medium'), low: i18n.t('priority.low'), lowest: i18n.t('priority.lowest') };
      notifyAfterSave({
        type: 'priority_changed', taskKey: task.taskKey, taskTitle: task.title, taskId: task.id,
        projectName: project?.name, actorName: currentMember?.name || i18n.t('common.unknown'),
        assigneeName: users.find(u => u.id === task.assigneeId)?.name, statusName: status?.name,
        fromStatus: pLabels2[task.priority] || task.priority, toStatus: pLabels2[updates.priority] || updates.priority,
      });
    }
    if (updates.reviewerId && updates.reviewerId !== task.reviewerId) {
      notify(updates.reviewerId, currentMemberId, 'review', task.id, task.title);
      const newReviewer = users.find(u => u.id === updates.reviewerId);
      if (newReviewer?.email && newReviewer.id !== currentMemberId) {
        notifyAfterSave({
          type: 'assignee_changed', taskKey: task.taskKey, taskTitle: task.title, taskId: task.id,
          projectName: project?.name, actorName: currentMember?.name || i18n.t('common.unknown'),
          oldAssignee: users.find(u => u.id === task.reviewerId)?.name || i18n.t('common.unassigned'),
          newAssignee: newReviewer.name, statusName: status?.name, priority: task.priority,
          dmTargets: [{ email: newReviewer.email, name: newReviewer.name, reason: i18n.t('taskDetail.assignedAsReviewer') }],
        });
      }
    }
    return outcome;
  };

  // Deleting is permanent (comments, attachments and specs go with the task), so the
  // confirmation says so and no undo is offered.
  const handleDelete = async () => {
    if (!task) return;
    if (!(await confirm({ title: i18n.t('task.deleteTitle'), description: i18n.t('task.deleteConfirm', { title: task.title }), destructive: true }))) return;
    const { error } = await supabase.from('tasks').delete().eq('id', task.id);
    if (error) { toast.error(taskWriteErrorText(error.message)); return; }
    setAllTasks(prev => prev.filter(t => t.id !== task.id).map(t => t.parentTaskId === task.id ? { ...t, parentTaskId: undefined } : t));
    setSelectedTask(null);
    void logActivity(currentMemberId, 'delete_task', task.title, task.id, task.taskKey);
    toast.success(i18n.t('undo.taskDeleted', { key: task.taskKey }));
  };

  const handleCreateSubtask = async () => {
    if (!task) return;
    const title = sidebarNewSubtaskTitle.trim();
    if (!title || activeSubtaskScope.current !== subtaskScope || pendingSubtasks.current.has(subtaskScope)) return;
    pendingSubtasks.current.add(subtaskScope);
    try {
      const created = await createSubtask(task.id, title, task.projectId, task.statusId);
      if (!created || activeSubtaskScope.current !== subtaskScope) return;
      if (activeSubtaskTitle.current.trim() === title) { setSidebarNewSubtaskTitle(''); setSidebarAddingSubtask(false); }
    } finally { pendingSubtasks.current.delete(subtaskScope); }
  };

  const handleUnlinkParent = async () => {
    if (!task) return;
    if (!(await confirm({ description: i18n.t('task.unlinkParentConfirm'), title: i18n.t('confirm.defaultTitle'), destructive: true }))) return;
    const updated = { ...task, parentTaskId: undefined };
    setAllTasks(prev => prev.map(t => t.id === task.id ? updated : t));
    setSelectedTask(updated);
    await supabase.from('tasks').update({ parent_task_id: null } as Record<string, unknown>).eq('id', task.id);
    logActivity(currentMemberId, 'unlink_parent', i18n.t('activity.unlinkParent'), task.id, task.taskKey);
    toast.success(i18n.t('task.unlinkParentSuccess'));
  };

  const handleCopyLink = () => {
    if (!task) return;
    const url = `${window.location.origin}${import.meta.env.BASE_URL}?task=${task.taskKey}`;
    void copyText(url).then(ok => {
      if (ok) toast.success(i18n.t('task.linkCopied'));
      else toast.error(i18n.t('common.copyFailed'), { description: url });
    });
  };

  // Deployment handlers
  const setDeploy = (env: EnvName, deployStatus: 'deployed' | 'scheduled') => {
    if (!task) return;
    const existing = task.deployments.filter(d => d.environment !== env);
    const today = new Date();
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const newDep = { environment: env, status: deployStatus as 'deployed' | 'scheduled', deployDate: deployStatus === 'deployed' ? today.toISOString().split('T')[0] : tomorrow.toISOString().split('T')[0] };
    updateTask({ deployments: [...existing, newDep] });
  };

  const removeDeploy = (env: EnvName) => {
    if (!task) return;
    updateTask({ deployments: task.deployments.filter(d => d.environment !== env) });
  };

  const toggleDeployStatus = (env: EnvName) => {
    if (!task) return;
    const dep = task.deployments.find(d => d.environment === env);
    if (!dep) return;
    const newStatus = dep.status === 'deployed' ? 'scheduled' : 'deployed';
    const newDate = newStatus === 'deployed' ? new Date().toISOString().split('T')[0] : dep.deployDate;
    updateTask({ deployments: [...task.deployments.filter(d => d.environment !== env), { environment: env, status: newStatus, deployDate: newDate }] });
  };

  // Custom field handlers
  const getCustomFieldValue = (fieldId: string) =>
    task ? customFieldValues.find(v => v.taskId === task.id && v.fieldId === fieldId) : undefined;

  const handleCustomFieldChange = async (fieldId: string, partial: Parameters<typeof upsertCustomFieldValue>[2]) => {
    if (!task) return;
    await upsertCustomFieldValue(task.id, fieldId, partial);
    trackPresence({ editingField: null });
  };

  // Template handler
  const handleSaveAsTemplate = async () => {
    if (!templateName.trim() || !task) return;
    const spec = taskSpecs.find(s => s.taskId === task.id);
    await createTaskTemplate({
      projectId: templateScope === 'project' ? task.projectId : null,
      name: templateName.trim(),
      description: '',
      defaultPriority: task.priority,
      defaultTagIds: task.tagIds || [],
      defaultSpecBackground: spec?.background || '',
      defaultSpecRequirement: spec?.requirement || '',
      defaultSpecNotes: spec?.notes || '',
      defaultCheckItems: checkItems,
      defaultTodoItems: todoItems,
      createdBy: currentMemberId,
    });
    setShowSaveTemplate(false);
    setTemplateName('');
    toast.success(i18n.t('task.templateSaved'));
  };

  return {
    updateTask,
    handleDelete,
    handleCreateSubtask,
    handleUnlinkParent,
    handleCopyLink,
    setDeploy, removeDeploy, toggleDeployStatus,
    getCustomFieldValue, handleCustomFieldChange,
    handleSaveAsTemplate,
  };
}
