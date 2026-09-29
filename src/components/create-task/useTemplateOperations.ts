import { useTaskContext } from '@/context/TaskContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useMemberContext } from '@/context/MemberContext';
import { useAuthContext } from '@/context/AuthContext';
import { Task, TaskTemplate } from '@/types';
import { toast } from 'sonner';
import i18n from '@/i18n';

/**
 * Hook for managing task template operations
 * Provides functions to create, apply, and manage templates
 */
export function useTemplateOperations() {
  const { taskTemplates, createTaskTemplate, updateTaskTemplate, deleteTaskTemplate, taskChecks, taskTodos } = useTaskContext();
  const { allProjects } = useProjectContext();
  const { currentMemberId } = useAuthContext();
  const { users } = useMemberContext();

  /**
   * Create a new template from a task and its associated data
   */
  const createTemplateFromTask = async (
    name: string,
    description: string,
    task: Task,
    checks: Array<{ text: string; isDone: boolean }>,
    todos: Array<{ text: string; isDone: boolean }>,
    scope: 'project' | 'global'
  ): Promise<TaskTemplate | null> => {
    if (!name.trim()) {
      toast.error(i18n.t('template.nameRequired'));
      return null;
    }

    try {
      const result = await createTaskTemplate({
        projectId: scope === 'project' ? task.projectId : null,
        name: name.trim(),
        description: description.trim(),
        defaultPriority: task.priority,
        defaultTagIds: task.tagIds || [],
        defaultSpecBackground: '',
        defaultSpecRequirement: '',
        defaultSpecNotes: '',
        defaultCheckItems: checks.filter(c => !c.isDone).map(c => c.text),
        defaultTodoItems: todos.filter(t => !t.isDone).map(t => t.text),
        createdBy: currentMemberId,
      });

      if (result) {
        toast.success(i18n.t('template.created'));
      }
      return result;
    } catch (error) {
      console.error('Failed to create template:', error);
      toast.error(i18n.t('template.createFailed'));
      return null;
    }
  };

  /**
   * Get templates available for a specific project
   */
  const getTemplatesForProject = (projectId: string): TaskTemplate[] => {
    return taskTemplates.filter(t => !t.projectId || t.projectId === projectId);
  };

  /**
   * Get all global templates
   */
  const getGlobalTemplates = (): TaskTemplate[] => {
    return taskTemplates.filter(t => !t.projectId);
  };

  /**
   * Get project-specific templates
   */
  const getProjectTemplates = (projectId: string): TaskTemplate[] => {
    return taskTemplates.filter(t => t.projectId === projectId);
  };

  /**
   * Get templates grouped by scope
   */
  const getGroupedTemplates = (currentProjectId?: string) => {
    const global = getGlobalTemplates();
    const current = currentProjectId ? getProjectTemplates(currentProjectId) : [];
    const other = currentProjectId
      ? taskTemplates.filter(t => t.projectId && t.projectId !== currentProjectId)
      : [];

    return { global, current, other };
  };

  /**
   * Get template details including creator name
   */
  const getTemplateWithDetails = (templateId: string) => {
    const template = taskTemplates.find(t => t.id === templateId);
    if (!template) return null;

    const creator = users.find(u => u.id === template.createdBy);
    const project = template.projectId ? allProjects.find(p => p.id === template.projectId) : null;

    return {
      ...template,
      creator,
      project,
    };
  };

  /**
   * Delete a template
   */
  const removeTemplate = async (templateId: string, templateName: string): Promise<boolean> => {
    try {
      await deleteTaskTemplate(templateId);
      toast.success(i18n.t('template.deleted', { name: templateName }));
      return true;
    } catch (error) {
      console.error('Failed to delete template:', error);
      toast.error(i18n.t('template.deleteFailed'));
      return false;
    }
  };

  return {
    taskTemplates,
    createTemplateFromTask,
    getTemplatesForProject,
    getGlobalTemplates,
    getProjectTemplates,
    getGroupedTemplates,
    getTemplateWithDetails,
    removeTemplate,
  };
}
