import { useState, useEffect, useReducer } from 'react';
import { useUIContext } from '@/context/UIContext';
import { useTaskContext } from '@/context/TaskContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useMemberContext } from '@/context/MemberContext';
import { useAuthContext } from '@/context/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useLicense } from '@/context/LicenseContext';
import { usePortalConfirmDialog } from '@/components/PortalConfirmDialog';
import { useIsMobile } from '@/hooks/use-mobile';
import { fetchTaskActivityLogs, type ActivityLog } from '@/lib/activityLog';
import { useStatusTransitionRules } from '@/hooks/useStatusTransitionRules';
import { useNotificationToast } from '@/components/notifications/NotificationToastProvider';
import { useApprovalRules } from '@/hooks/useApprovalRules';
import { useApprovalWorkflow } from '@/hooks/useApprovalWorkflow';
import { useUndoStack } from '@/hooks/useUndoStack';

// Shared types
export type { OtherViewer } from './types';

// Sub-hooks (existing)
import { useTaskAttachments } from './useTaskAttachments';
import { useTaskComments } from './useTaskComments';
import { useTaskSpecs } from './useTaskSpecs';
import { useTaskSidebarFields } from './useTaskSidebarFields';
import { useTaskDetailChecklist } from './useTaskDetailChecklist';
import { useTaskDetailTodos } from './useTaskDetailTodos';

// Sub-hooks (new – extracted from this file)
import { useTaskPresence } from './useTaskPresence';
import { useTaskStatusChange } from './useTaskStatusChange';
import { useTaskActions } from './useTaskActions';

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export const useTaskDetail = () => {
  const { selectedTask, setSelectedTask, taskDisplayMode, setTaskDisplayMode } = useUIContext();
  const {
    allTasks, setAllTasks, statuses, tags, taskSpecs, taskChecks,
    taskTodos: globalTodos, comments: globalComments, statusLogs,
    updateTaskInDb, refreshTags, customFields, customFieldValues,
    upsertCustomFieldValue, createTaskTemplate, taskDependencies,
    addTaskDependency, removeTaskDependency, createSubtask,
  } = useTaskContext();
  const { allProjects, productLines } = useProjectContext();
  const { users } = useMemberContext();
  const { permissions, currentMemberId, currentMember } = useAuthContext();
  const { hasFeature } = useLicense();
  const undoStack = useUndoStack();
  const { confirm, ConfirmDialog } = usePortalConfirmDialog();
  const isMobile = useIsMobile();
  const { canTransitionTo } = useStatusTransitionRules();
  const { triggerNotification } = useNotificationToast();
  const { getRuleForTransition } = useApprovalRules();
  const { requestApproval } = useApprovalWorkflow();

  // ── UI / Modal state (consolidated via useReducer) ─────────────────────────
  type TabType = 'spec' | 'files' | 'comments' | 'metrics' | 'time' | 'activity' | 'subtasks';
  type UIState = {
    activeTab: TabType;
    deleteConfirm: boolean;
    showCustomFieldManager: boolean;
    showSaveTemplate: boolean;
    templateName: string;
    templateScope: 'project' | 'global';
    taskActivityLogs: ActivityLog[];
  };
  type UIAction =
    | { type: 'SET_ACTIVE_TAB'; payload: TabType }
    | { type: 'SET_DELETE_CONFIRM'; payload: boolean }
    | { type: 'SET_SHOW_CUSTOM_FIELD_MANAGER'; payload: boolean }
    | { type: 'SET_SHOW_SAVE_TEMPLATE'; payload: boolean }
    | { type: 'SET_TEMPLATE_NAME'; payload: string }
    | { type: 'SET_TEMPLATE_SCOPE'; payload: 'project' | 'global' }
    | { type: 'SET_TASK_ACTIVITY_LOGS'; payload: ActivityLog[] }
    | { type: 'RESET_FOR_TASK' };
  const uiReducer = (state: UIState, action: UIAction): UIState => {
    switch (action.type) {
      case 'SET_ACTIVE_TAB': return { ...state, activeTab: action.payload };
      case 'SET_DELETE_CONFIRM': return { ...state, deleteConfirm: action.payload };
      case 'SET_SHOW_CUSTOM_FIELD_MANAGER': return { ...state, showCustomFieldManager: action.payload };
      case 'SET_SHOW_SAVE_TEMPLATE': return { ...state, showSaveTemplate: action.payload };
      case 'SET_TEMPLATE_NAME': return { ...state, templateName: action.payload };
      case 'SET_TEMPLATE_SCOPE': return { ...state, templateScope: action.payload };
      case 'SET_TASK_ACTIVITY_LOGS': return { ...state, taskActivityLogs: action.payload };
      case 'RESET_FOR_TASK': return { ...state, activeTab: 'spec', deleteConfirm: false };
      default: return state;
    }
  };
  const [ui, dispatchUI] = useReducer(uiReducer, {
    activeTab: 'spec', deleteConfirm: false, showCustomFieldManager: false,
    showSaveTemplate: false, templateName: '', templateScope: 'project',
    taskActivityLogs: [],
  });
  // Stable setters that match the old useState interface
  const setActiveTab = (v: TabType) => dispatchUI({ type: 'SET_ACTIVE_TAB', payload: v });
  const setDeleteConfirm = (v: boolean) => dispatchUI({ type: 'SET_DELETE_CONFIRM', payload: v });
  const setShowCustomFieldManager = (v: boolean) => dispatchUI({ type: 'SET_SHOW_CUSTOM_FIELD_MANAGER', payload: v });
  const setShowSaveTemplate = (v: boolean) => dispatchUI({ type: 'SET_SHOW_SAVE_TEMPLATE', payload: v });
  const setTemplateName = (v: string) => dispatchUI({ type: 'SET_TEMPLATE_NAME', payload: v });
  const setTemplateScope = (v: 'project' | 'global') => dispatchUI({ type: 'SET_TEMPLATE_SCOPE', payload: v });
  const setTaskActivityLogs = (v: ActivityLog[]) => dispatchUI({ type: 'SET_TASK_ACTIVITY_LOGS', payload: v });

  // ─────────────────────────────────────────────────────────────────────────
  // Derived values
  // ─────────────────────────────────────────────────────────────────────────
  const task = selectedTask
    ? (allTasks.find(t => t.id === selectedTask.id) || selectedTask)
    : null;
  const project = task ? allProjects.find(p => p.id === task.projectId) : null;
  const line = project ? productLines.find(l => l.id === project.lineId) : null;
  const status = task ? statuses.find(s => s.id === task.statusId) : null;
  const assignee = task ? users.find(u => u.id === task.assigneeId) : null;
  const creator = task ? users.find(u => u.id === task.creatorId) : null;
  const logs = task
    ? statusLogs.filter(l => l.taskId === task.id).sort((a, b) => new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime())
    : [];

  // ─────────────────────────────────────────────────────────────────────────
  // Presence (extracted sub-hook)
  // ─────────────────────────────────────────────────────────────────────────
  const { otherViewers, trackPresence, getFieldLocker } = useTaskPresence(
    selectedTask?.id,
    currentMemberId,
    users,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Sub-hooks (ordered by dependency)
  // ─────────────────────────────────────────────────────────────────────────

  const attachments = useTaskAttachments({
    task,
    currentMemberId,
    allTasks,
    setAllTasks,
  });

  const specs = useTaskSpecs({
    task,
    selectedTaskId: selectedTask?.id,
    currentMemberId,
    getFieldLocker,
    trackPresence,
  });

  const comments = useTaskComments({
    task,
    currentMemberId,
    currentMember,
    users,
    allTasks,
    setAllTasks,
    globalComments,
    project,
    status,
    assignee,
    MAX_FILE_SIZE: attachments.MAX_FILE_SIZE,
    loadStorageUsage: attachments.loadStorageUsage,
  });

  const sidebarFields = useTaskSidebarFields({
    task,
    currentMemberId,
    users,
    tags,
    allTasks,
    setAllTasks,
    setSelectedTask,
    refreshTags,
    getFieldLocker,
    trackPresence,
    confirm,
  });

  const checklist = useTaskDetailChecklist({
    task,
    selectedTaskId: selectedTask?.id,
    taskChecks,
    currentMemberId,
    getFieldLocker,
    trackPresence,
  });

  const todos = useTaskDetailTodos({
    task,
    selectedTaskId: selectedTask?.id,
    globalTodos,
    currentMemberId,
    getFieldLocker,
    trackPresence,
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Task actions (extracted sub-hook)
  // ─────────────────────────────────────────────────────────────────────────
  const actions = useTaskActions({
    task, project, statuses, users, allProjects,
    currentMemberId, currentMember, status, assignee,
    setAllTasks, setSelectedTask, updateTaskInDb,
    confirm, undoStack,
    customFieldValues, upsertCustomFieldValue, trackPresence,
    taskSpecs,
    checkItems: checklist.checks.filter(c => !c.isDone).map(c => c.text),
    todoItems: todos.todos.filter(t => !t.isDone).map(t => t.text),
    createTaskTemplate, createSubtask,
    sidebarNewSubtaskTitle: sidebarFields.newSubtaskTitle,
    setSidebarNewSubtaskTitle: sidebarFields.setNewSubtaskTitle,
    setSidebarAddingSubtask: sidebarFields.setAddingSubtask,
    showSaveTemplate: ui.showSaveTemplate, setShowSaveTemplate,
    templateName: ui.templateName, setTemplateName, templateScope: ui.templateScope,
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Status change (extracted sub-hook)
  // ─────────────────────────────────────────────────────────────────────────
  const statusChange = useTaskStatusChange({
    task, project, statuses, statusLogs, users,
    currentMemberId, currentMember, assignee,
    updateTask: actions.updateTask,
    setAllTasks, setSelectedTask,
    canTransitionTo, triggerNotification, getRuleForTransition, requestApproval,
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Effects
  // ─────────────────────────────────────────────────────────────────────────

  // Activity realtime subscription
  useEffect(() => {
    if (!selectedTask) return;
    const taskId = selectedTask.id;
    const activityChannel = supabase
      .channel(`task-activity-${taskId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_logs', filter: `task_id=eq.${taskId}` }, () => {
        fetchTaskActivityLogs(taskId).then(setTaskActivityLogs);
      })
      .subscribe();
    return () => { supabase.removeChannel(activityChannel); };
  }, [selectedTask?.id]);

  // On task change: reset UI state, refresh activity and tags
  useEffect(() => {
    if (selectedTask) {
      dispatchUI({ type: 'RESET_FOR_TASK' });
      fetchTaskActivityLogs(selectedTask.id).then(setTaskActivityLogs);
      supabase.from('task_tags').select('tag_id').eq('task_id', selectedTask.id).then(({ data }) => {
        if (data) {
          const freshTagIds = (data as { tag_id: string }[]).map(tt => tt.tag_id);
          const freshTagIdsOrUndef = freshTagIds.length > 0 ? freshTagIds : undefined;
          const taskId = selectedTask.id;
          setAllTasks(prev => prev.map(t => t.id === taskId ? { ...t, tagIds: freshTagIdsOrUndef } : t));
          setSelectedTask(prev => prev && prev.id === taskId ? { ...prev, tagIds: freshTagIdsOrUndef } : prev);
        }
      });
    }
  }, [selectedTask?.id]);

  // Re-fetch activity when switching to activity tab
  useEffect(() => {
    if (ui.activeTab === 'activity' && selectedTask) {
      fetchTaskActivityLogs(selectedTask.id).then(setTaskActivityLogs);
    }
  }, [ui.activeTab, selectedTask?.id]);

  // ─────────────────────────────────────────────────────────────────────────
  // Return
  // ─────────────────────────────────────────────────────────────────────────

  return {
    // Context passthrough (needed by sidebar / tabs)
    allTasks, setAllTasks, allProjects, users, statuses, productLines, tags,
    permissions, currentMemberId, currentMember, taskDisplayMode, setTaskDisplayMode,
    customFields, customFieldValues, upsertCustomFieldValue,
    taskDependencies, addTaskDependency, removeTaskDependency,
    hasFeature,
    isMobile,
    setSelectedTask,

    // Derived / computed
    task, project, line, status, assignee, creator, logs,

    // Presence
    otherViewers, trackPresence, getFieldLocker,

    // UI state (backed by useReducer)
    activeTab: ui.activeTab, setActiveTab,
    deleteConfirm: ui.deleteConfirm, setDeleteConfirm,
    showCustomFieldManager: ui.showCustomFieldManager, setShowCustomFieldManager,
    showSaveTemplate: ui.showSaveTemplate, setShowSaveTemplate,
    templateName: ui.templateName, setTemplateName,
    templateScope: ui.templateScope, setTemplateScope,
    advisoryState: statusChange.advisoryState,
    setAdvisoryState: statusChange.setAdvisoryState,
    approvalConfirmState: statusChange.approvalConfirmState,
    setApprovalConfirmState: statusChange.setApprovalConfirmState,
    handleApprovalConfirm: statusChange.handleApprovalConfirm,
    handleAdvisoryDirectChange: statusChange.handleAdvisoryDirectChange,
    handleAdvisorySubmitApproval: statusChange.handleAdvisorySubmitApproval,

    // Checklist (from sub-hook)
    ...checklist,

    // Todo (from sub-hook)
    ...todos,

    // Activity
    taskActivityLogs: ui.taskActivityLogs,

    // Task actions
    updateTask: actions.updateTask,
    handleStatusChange: statusChange.handleStatusChange,
    handleDelete: actions.handleDelete,
    handleCopyLink: actions.handleCopyLink,
    setDeploy: actions.setDeploy,
    removeDeploy: actions.removeDeploy,
    toggleDeployStatus: actions.toggleDeployStatus,
    handleSaveAsTemplate: actions.handleSaveAsTemplate,
    handleCreateSubtask: actions.handleCreateSubtask,
    handleUnlinkParent: actions.handleUnlinkParent,

    // Custom fields
    getCustomFieldValue: actions.getCustomFieldValue,
    handleCustomFieldChange: actions.handleCustomFieldChange,

    // Specs sub-hook
    ...specs,

    // Attachments sub-hook
    ...attachments,

    // Comments sub-hook
    ...comments,

    // Sidebar fields sub-hook
    ...sidebarFields,

    // Confirm dialog (must be rendered in JSX for approval flow)
    ConfirmDialog,
  };
}

export type TaskDetailState = ReturnType<typeof useTaskDetail>;
