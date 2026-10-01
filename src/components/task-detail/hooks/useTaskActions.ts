import { supabase } from '@/integrations/supabase/client';
import { sendSlackNotify } from '@/lib/slackNotify';
import { toast } from 'sonner';
import { logActivity } from '@/lib/activityLog';
import i18n from '@/i18n';
import { createNotification, type EnvName } from '../utils';
import type { Task, Status, User, Project, TaskCustomFieldValue } from '@/types';
import { copyText } from '@/lib/clipboard';

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
  updateTaskInDb: (taskId: string, updates: Partial<Task>) => void;
  confirm: (opts: { title?: string; description: string; destructive?: boolean }) => Promise<boolean>;
  undoStack: { push: (entry: { type: string; description: string; undo: () => Promise<void> }) => void };
  customFieldValues: TaskCustomFieldValue[];
  upsertCustomFieldValue: (taskId: string, fieldId: string, value: Partial<TaskCustomFieldValue>) => Promise<void>;
  trackPresence: (extraFields?: Record<string, unknown>) => Promise<void>;
  taskSpecs: { taskId: string; background?: string; requirement?: string; notes?: string }[];
  checkItems: string[];
  todoItems: string[];
  createTaskTemplate: (template: Record<string, unknown>) => Promise<void>;
  createSubtask: (parentId: string, title: string, projectId: string, statusId: string) => Promise<void>;
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
  const {
    task, project, statuses, users, allProjects,
    currentMemberId, currentMember, status, assignee,
    setAllTasks, setSelectedTask, updateTaskInDb,
    confirm, undoStack,
    customFieldValues, upsertCustomFieldValue, trackPresence,
    taskSpecs, checkItems, todoItems,
    createTaskTemplate, createSubtask,
    sidebarNewSubtaskTitle, setSidebarNewSubtaskTitle, setSidebarAddingSubtask,
    setShowSaveTemplate, templateName, setTemplateName, templateScope,
  } = params;

  const updateTask = (updates: Partial<Task>) => {
    if (!task) return;
    const updated = { ...task, ...updates };
    setAllTasks(prev => prev.map(t => t.id === task.id ? updated : t));
    setSelectedTask(updated);
    updateTaskInDb(task.id, updates);

    if (updates.title && updates.title !== task.title)
      logActivity(currentMemberId, 'update_title', `「${task.title}」→「${updates.title}」`, task.id, task.taskKey);
    if (updates.statusId && updates.statusId !== task.statusId) {
      const oldS = statuses.find(s => s.id === task.statusId);
      const newS = statuses.find(s => s.id === updates.statusId);
      logActivity(currentMemberId, 'update_status', `${oldS?.name || '—'} → ${newS?.name || '—'}`, task.id, task.taskKey);
    }
    if (updates.priority && updates.priority !== task.priority) {
      const pLabels: Record<string, string> = { highest: i18n.t('priority.highest'), high: i18n.t('priority.high'), medium: i18n.t('priority.medium'), low: i18n.t('priority.low'), lowest: i18n.t('priority.lowest') };
      logActivity(currentMemberId, 'update_priority', `${pLabels[task.priority] || task.priority} → ${pLabels[updates.priority] || updates.priority}`, task.id, task.taskKey);
    }
    if (updates.assigneeId !== undefined && updates.assigneeId !== task.assigneeId) {
      const oldA = users.find(u => u.id === task.assigneeId);
      const newA = users.find(u => u.id === updates.assigneeId);
      logActivity(currentMemberId, 'update_assignee', `${oldA?.name || i18n.t('common.unassigned')} → ${newA?.name || i18n.t('common.unassigned')}`, task.id, task.taskKey);
    }
    if (updates.reviewerId !== undefined && updates.reviewerId !== task.reviewerId) {
      const oldR = users.find(u => u.id === task.reviewerId);
      const newR = users.find(u => u.id === updates.reviewerId);
      logActivity(currentMemberId, 'update_reviewer', `${oldR?.name || i18n.t('common.unassigned')} → ${newR?.name || i18n.t('common.unassigned')}`, task.id, task.taskKey);
    }
    if (updates.dueDate !== undefined && updates.dueDate !== task.dueDate)
      logActivity(currentMemberId, 'update_due_date', `${task.dueDate || '—'} → ${updates.dueDate || '—'}`, task.id, task.taskKey);
    if (updates.projectId && updates.projectId !== task.projectId) {
      const oldP = allProjects.find(p => p.id === task.projectId);
      const newP = allProjects.find(p => p.id === updates.projectId);
      logActivity(currentMemberId, 'update_project', `${oldP?.name || '—'} → ${newP?.name || '—'}`, task.id, task.taskKey);
    }
    if (updates.department !== undefined && updates.department !== task.department)
      logActivity(currentMemberId, 'update_department', `${task.department || '—'} → ${updates.department || '—'}`, task.id, task.taskKey);
    if (updates.deployments)
      logActivity(currentMemberId, 'update_deploy', i18n.t('activity.updateDeploy'), task.id, task.taskKey);

    if (updates.assigneeId && updates.assigneeId !== task.assigneeId) {
      createNotification(updates.assigneeId, currentMemberId, 'assign', task.id, task.title);
      const oldAssignee = users.find(u => u.id === task.assigneeId);
      const newAssignee = users.find(u => u.id === updates.assigneeId);
      const dmTargets: { email: string; name?: string; reason: string }[] = [];
      if (newAssignee && newAssignee.id !== currentMemberId)
        dmTargets.push({ email: newAssignee.email, name: newAssignee.name, reason: i18n.t('taskDetail.assignedAsAssignee') });
      sendSlackNotify({
        type: 'assignee_changed', taskKey: task.taskKey, taskTitle: task.title, taskId: task.id,
        projectName: project?.name, actorName: currentMember?.name || i18n.t('common.unknown'),
        oldAssignee: oldAssignee?.name || i18n.t('common.unassigned'), newAssignee: newAssignee?.name || i18n.t('common.unassigned'),
        statusName: status?.name, priority: task.priority, dmTargets,
      });
    }
    if (updates.priority && updates.priority !== task.priority) {
      const pLabels2: Record<string, string> = { highest: i18n.t('priority.highest'), high: i18n.t('priority.high'), medium: i18n.t('priority.medium'), low: i18n.t('priority.low'), lowest: i18n.t('priority.lowest') };
      sendSlackNotify({
        type: 'priority_changed', taskKey: task.taskKey, taskTitle: task.title, taskId: task.id,
        projectName: project?.name, actorName: currentMember?.name || i18n.t('common.unknown'),
        assigneeName: users.find(u => u.id === task.assigneeId)?.name, statusName: status?.name,
        fromStatus: pLabels2[task.priority] || task.priority, toStatus: pLabels2[updates.priority] || updates.priority,
      });
    }
    if (updates.reviewerId && updates.reviewerId !== task.reviewerId) {
      createNotification(updates.reviewerId, currentMemberId, 'review', task.id, task.title);
      const newReviewer = users.find(u => u.id === updates.reviewerId);
      if (newReviewer?.email && newReviewer.id !== currentMemberId) {
        sendSlackNotify({
          type: 'assignee_changed', taskKey: task.taskKey, taskTitle: task.title, taskId: task.id,
          projectName: project?.name, actorName: currentMember?.name || i18n.t('common.unknown'),
          oldAssignee: users.find(u => u.id === task.reviewerId)?.name || i18n.t('common.unassigned'),
          newAssignee: newReviewer.name, statusName: status?.name, priority: task.priority,
          dmTargets: [{ email: newReviewer.email, name: newReviewer.name, reason: i18n.t('taskDetail.assignedAsReviewer') }],
        });
      }
    }
  };

  const handleDelete = async () => {
    if (!task) return;
    if (!(await confirm({ title: i18n.t('task.deleteTitle'), description: i18n.t('task.deleteConfirm', { title: task.title }), destructive: true }))) return;
    const deletedTask = { ...task };
    logActivity(currentMemberId, 'delete_task', task.title, task.id, task.taskKey);
    await supabase.from('tasks').delete().eq('id', task.id);
    setAllTasks(prev => prev.filter(t => t.id !== task.id).map(t => t.parentTaskId === task.id ? { ...t, parentTaskId: undefined } : t));
    setSelectedTask(null);
    undoStack.push({
      type: 'delete_task',
      description: i18n.t('undo.taskDeleted', { key: deletedTask.taskKey }),
      undo: async () => {
        const { id, taskKey, commentCount, attachmentCount, deployments, tagIds, ...rest } = deletedTask;
        const dbRow: Record<string, unknown> = {
          id, task_key: taskKey,
          project_id: rest.projectId, title: rest.title,
          status_id: rest.statusId, priority: rest.priority,
          creator_id: rest.creatorId, sort_order: rest.sortOrder,
          created_at: rest.createdAt,
        };
        if (rest.assigneeId) dbRow.assignee_id = rest.assigneeId;
        if (rest.reviewerId) dbRow.reviewer_id = rest.reviewerId;
        if (rest.dueDate) dbRow.due_date = rest.dueDate;
        if (rest.startedAt) dbRow.started_at = rest.startedAt;
        if (rest.completedAt) dbRow.completed_at = rest.completedAt;
        if (rest.gitlabUrl) dbRow.gitlab_url = rest.gitlabUrl;
        if (rest.sprintId) dbRow.sprint_id = rest.sprintId;
        if (rest.department) dbRow.department = rest.department;
        if (rest.parentTaskId) dbRow.parent_task_id = rest.parentTaskId;
        await supabase.from('tasks').insert(dbRow);
        setAllTasks(prev => [...prev, deletedTask]);
      },
    });
  };

  const handleCreateSubtask = async () => {
    if (!task) return;
    const title = sidebarNewSubtaskTitle.trim();
    if (!title) return;
    await createSubtask(task.id, title, task.projectId, task.statusId);
    setSidebarNewSubtaskTitle('');
    setSidebarAddingSubtask(false);
    logActivity(currentMemberId, 'create_task', i18n.t('activity.subtaskCreated', { title }), task.id, task.taskKey);
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
