import { useMemo, useCallback } from 'react';
import i18n from '@/i18n';

import { AuthContext } from './AuthContext';
import { MemberContext } from './MemberContext';
import { UIContext } from './UIContext';
import { ProjectContext } from './ProjectContext';
import { TaskContext } from './TaskContext';
import { SprintContext } from './SprintContext';

import { useAuthState } from './hooks/useAuthState';
import { useMemberState } from './hooks/useMemberState';
import { useUIState } from './hooks/useUIState';
import { useProjectState } from './hooks/useProjectState';
import { useTaskState } from './hooks/useTaskState';
import { useSprintState } from './hooks/useSprintState';
import { useInitialLoad } from './hooks/useInitialLoad';
import { useRealtimeSubs } from './hooks/useRealtimeSubs';
import { useSideEffects } from './hooks/useSideEffects';

export const AppProvider = ({ children }: { children: React.ReactNode }) => {
  // ─── Domain State Hooks ───
  const member = useMemberState();
  const auth = useAuthState(member.users, member.usersLoaded);
  const ui = useUIState();
  const project = useProjectState();
  const task = useTaskState();
  const sprint = useSprintState();

  // ─── Cross-domain wired functions ───
  const updateTaskInDb = useMemo(
    () => task.createUpdateTaskInDb(auth.currentMemberId, member.users, ui.setSelectedTask),
    [task.createUpdateTaskInDb, auth.currentMemberId, member.users, ui.setSelectedTask],
  );

  const createSubtask = useMemo(
    () => task.createCreateSubtask(project.allProjects, auth.currentMemberId),
    [task.createCreateSubtask, project.allProjects, auth.currentMemberId],
  );

  const deleteProjectInDb = useMemo(
    () => project.createDeleteProjectInDb(task.allTasks, auth.currentMemberId, task.setAllTasks),
    [project.createDeleteProjectInDb, task.allTasks, auth.currentMemberId, task.setAllTasks],
  );

  const startSprint = useMemo(
    () => sprint.createStartSprint(task.statuses, task.allTasks, task.refreshTasks),
    [sprint.createStartSprint, task.statuses, task.allTasks, task.refreshTasks],
  );

  const completeSprint = useMemo(
    () => sprint.createCompleteSprint(task.statuses, task.allTasks, task.refreshTasks, task.setAllTasks),
    [sprint.createCompleteSprint, task.statuses, task.allTasks, task.refreshTasks, task.setAllTasks],
  );

  // ─── Initial Data Load ───
  useInitialLoad({
    setUsers: member.setUsers,
    setStatuses: task.setStatuses,
    setProductLines: project.setProductLines,
    setAllProjects: project.setAllProjects,
    setTags: task.setTags,
    setTaskSpecs: task.setTaskSpecs,
    setTaskChecks: task.setTaskChecks,
    setTaskTodos: task.setTaskTodos,
    setComments: task.setComments,
    setStatusLogs: task.setStatusLogs,
    setAllTasks: task.setAllTasks,
    setDeployMap: task.setDeployMap,
    setCustomFields: task.setCustomFields,
    setCustomFieldValues: task.setCustomFieldValues,
    setTaskTemplates: task.setTaskTemplates,
    setTaskDependencies: task.setTaskDependencies,
    setUserThemeState: auth.setUserThemeState,
    setRequiredFields: ui.setRequiredFields,
    setIsLoading: ui.setIsLoading,
    setSprintActive: sprint.setSprintActive,
    webhookConfigRef: task.webhookConfigRef,
    refreshSprints: sprint.refreshSprints,
  });

  // ─── Realtime Subscriptions ───
  useRealtimeSubs({
    setAllTasks: task.setAllTasks,
    setSelectedTask: ui.setSelectedTask,
    setComments: task.setComments,
    setTaskSpecs: task.setTaskSpecs,
    setTaskChecks: task.setTaskChecks,
    setTaskTodos: task.setTaskTodos,
    setDeployMap: task.setDeployMap,
    setCustomFieldValues: task.setCustomFieldValues,
    setTaskDependencies: task.setTaskDependencies,
    setAllProjects: project.setAllProjects,
    refreshTags: task.refreshTags,
    refreshCustomFields: task.refreshCustomFields,
    refreshTaskTemplates: task.refreshTaskTemplates,
    refreshSprints: sprint.refreshSprints,
    refreshTasks: task.refreshTasks,
    refreshUsers: member.refreshUsers,
    refreshStatuses: task.refreshStatuses,
    refreshProductLines: project.refreshProductLines,
  });

  // ─── Side Effects (due-soon, auto-report) ───
  useSideEffects(auth.currentMemberId, task.allTasks, task.statuses);

  // ─── Memoized Context Values ───
  const authValue = useMemo(() => ({
    currentMemberId: auth.currentMemberId, setCurrentMemberId: auth.setCurrentMemberId,
    currentMember: auth.currentMember, realMemberId: auth.realMemberId, realMember: auth.realMember,
    permissions: auth.permissions, userTheme: auth.userTheme, setUserTheme: auth.setUserTheme,
  }), [auth.currentMemberId, auth.setCurrentMemberId, auth.currentMember, auth.realMemberId, auth.realMember, auth.permissions, auth.userTheme, auth.setUserTheme]);

  const memberValue = useMemo(() => ({
    users: member.users, refreshUsers: member.refreshUsers,
  }), [member.users, member.refreshUsers]);

  const uiValue = useMemo(() => ({
    currentView: ui.currentView, setCurrentView: ui.setCurrentView,
    selectedTask: ui.selectedTask, setSelectedTask: ui.setSelectedTask,
    standupMode: ui.standupMode, setStandupMode: ui.setStandupMode,
    standupUserId: ui.standupUserId, setStandupUserId: ui.setStandupUserId,
    showCreateProject: ui.showCreateProject, setShowCreateProject: ui.setShowCreateProject,
    showCreateTask: ui.showCreateTask, setShowCreateTask: ui.setShowCreateTask,
    editingProject: ui.editingProject, setEditingProject: ui.setEditingProject,
    taskDisplayMode: ui.taskDisplayMode, setTaskDisplayMode: ui.setTaskDisplayMode,
    requiredFields: ui.requiredFields, setRequiredFields: ui.setRequiredFields, saveRequiredFields: ui.saveRequiredFields,
    isLoading: ui.isLoading,
  }), [ui.currentView, ui.selectedTask, ui.standupMode, ui.standupUserId, ui.showCreateProject, ui.showCreateTask, ui.editingProject, ui.taskDisplayMode, ui.requiredFields, ui.saveRequiredFields, ui.isLoading]);

  const projectValue = useMemo(() => ({
    allProjects: project.allProjects, setAllProjects: project.setAllProjects,
    selectedProjectId: project.selectedProjectId, setSelectedProjectId: project.setSelectedProjectId,
    selectedLineId: project.selectedLineId, setSelectedLineId: project.setSelectedLineId,
    productLines: project.productLines, refreshProductLines: project.refreshProductLines,
    createProjectInDb: project.createProjectInDb, updateProjectInDb: project.updateProjectInDb,
    deleteProjectInDb,
    createProductLineInDb: project.createProductLineInDb, updateProductLineInDb: project.updateProductLineInDb, deleteProductLineInDb: project.deleteProductLineInDb,
  }), [project.allProjects, project.selectedProjectId, project.selectedLineId, project.productLines, project.refreshProductLines, project.createProjectInDb, project.updateProjectInDb, deleteProjectInDb, project.createProductLineInDb, project.updateProductLineInDb, project.deleteProductLineInDb]);

  const taskValue = useMemo(() => ({
    allTasks: task.allTasks, setAllTasks: task.setAllTasks,
    statuses: task.statuses, tags: task.tags,
    taskSpecs: task.taskSpecs, taskChecks: task.taskChecks, taskTodos: task.taskTodos,
    comments: task.comments, statusLogs: task.statusLogs,
    refreshTasks: task.refreshTasks, refreshComments: task.refreshComments, refreshStatusLogs: task.refreshStatusLogs,
    refreshTaskSpecs: task.refreshTaskSpecs, refreshTaskChecks: task.refreshTaskChecks, refreshTaskTodos: task.refreshTaskTodos,
    refreshStatuses: task.refreshStatuses, refreshTags: task.refreshTags,
    updateTaskInDb, createTaskInDb: task.createTaskInDb, createSubtask,
    customFields: task.customFields, customFieldValues: task.customFieldValues,
    refreshCustomFields: task.refreshCustomFields, refreshCustomFieldValues: task.refreshCustomFieldValues,
    createCustomField: task.createCustomField, updateCustomField: task.updateCustomField, deleteCustomField: task.deleteCustomField,
    upsertCustomFieldValue: task.upsertCustomFieldValue,
    taskTemplates: task.taskTemplates, refreshTaskTemplates: task.refreshTaskTemplates,
    createTaskTemplate: task.createTaskTemplate, updateTaskTemplate: task.updateTaskTemplate, deleteTaskTemplate: task.deleteTaskTemplate,
    taskDependencies: task.taskDependencies, refreshTaskDependencies: task.refreshTaskDependencies,
    addTaskDependency: task.addTaskDependency, removeTaskDependency: task.removeTaskDependency,
  }), [
    task.allTasks, task.statuses, task.tags,
    task.taskSpecs, task.taskChecks, task.taskTodos, task.comments, task.statusLogs,
    task.refreshTasks, task.refreshComments, task.refreshStatusLogs, task.refreshTaskSpecs, task.refreshTaskChecks, task.refreshTaskTodos,
    task.refreshStatuses, task.refreshTags,
    updateTaskInDb, task.createTaskInDb, createSubtask,
    task.customFields, task.customFieldValues,
    task.refreshCustomFields, task.refreshCustomFieldValues,
    task.createCustomField, task.updateCustomField, task.deleteCustomField, task.upsertCustomFieldValue,
    task.taskTemplates, task.refreshTaskTemplates, task.createTaskTemplate, task.updateTaskTemplate, task.deleteTaskTemplate,
    task.taskDependencies, task.refreshTaskDependencies, task.addTaskDependency, task.removeTaskDependency,
  ]);

  const sprintValue = useMemo(() => ({
    sprintActive: sprint.sprintActive, setSprintActive: sprint.setSprintActive, sprintStartedAt: sprint.sprintStartedAt,
    sprints: sprint.sprints, currentSprint: sprint.currentSprint,
    startSprint, completeSprint, renameSprint: sprint.renameSprint,
    refreshSprints: sprint.refreshSprints, getDefaultSprintName: sprint.getDefaultSprintName,
  }), [sprint.sprintActive, sprint.sprintStartedAt, sprint.sprints, sprint.currentSprint, startSprint, completeSprint, sprint.renameSprint, sprint.refreshSprints, sprint.getDefaultSprintName]);

  // ─── Auth Guard ───
  if (!auth.memberVerified) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <span className="text-muted-foreground">{i18n.t('common.verifyingIdentity')}</span>
      </div>
    );
  }

  // ─── Provider Composition ───
  return (
    <AuthContext.Provider value={authValue}>
      <MemberContext.Provider value={memberValue}>
        <UIContext.Provider value={uiValue}>
          <ProjectContext.Provider value={projectValue}>
            <TaskContext.Provider value={taskValue}>
              <SprintContext.Provider value={sprintValue}>
                {children}
              </SprintContext.Provider>
            </TaskContext.Provider>
          </ProjectContext.Provider>
        </UIContext.Provider>
      </MemberContext.Provider>
    </AuthContext.Provider>
  );
};
