import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';
import type { Task, Status, Tag, TaskSpec, TaskCheck, TaskTodo, Comment, StatusLog, CustomField, TaskCustomFieldValue, TaskTemplate, TaskDependency } from '@/types';

export interface TaskContextType {
  allTasks: Task[];
  setAllTasks: Dispatch<SetStateAction<Task[]>>;
  statuses: Status[];
  tags: Tag[];
  taskSpecs: TaskSpec[];
  taskChecks: TaskCheck[];
  taskTodos: TaskTodo[];
  comments: Comment[];
  statusLogs: StatusLog[];
  refreshTasks: () => Promise<void>;
  refreshComments: () => Promise<void>;
  refreshStatusLogs: () => Promise<void>;
  refreshTaskSpecs: () => Promise<void>;
  refreshTaskChecks: () => Promise<void>;
  refreshTaskTodos: () => Promise<void>;
  refreshStatuses: () => Promise<void>;
  refreshTags: () => Promise<void>;
  updateTaskInDb: (taskId: string, updates: Partial<Task>) => Promise<boolean | void>;
  createTaskInDb: (task: Task) => Promise<void>;
  createSubtask: (parentTaskId: string, title: string, projectId: string, statusId: string, parentTaskOverride?: Task) => Promise<Task | null>;
  customFields: CustomField[];
  customFieldValues: TaskCustomFieldValue[];
  refreshCustomFields: () => Promise<void>;
  refreshCustomFieldValues: () => Promise<void>;
  createCustomField: (field: Omit<CustomField, 'id' | 'createdAt'>) => Promise<CustomField | null>;
  updateCustomField: (fieldId: string, updates: Partial<CustomField>) => Promise<void>;
  deleteCustomField: (fieldId: string) => Promise<void>;
  upsertCustomFieldValue: (taskId: string, fieldId: string, value: Partial<TaskCustomFieldValue>) => Promise<void>;
  taskTemplates: TaskTemplate[];
  refreshTaskTemplates: () => Promise<void>;
  createTaskTemplate: (template: Omit<TaskTemplate, 'id' | 'createdAt' | 'updatedAt'>) => Promise<TaskTemplate | null>;
  updateTaskTemplate: (templateId: string, updates: Partial<TaskTemplate>) => Promise<void>;
  deleteTaskTemplate: (templateId: string) => Promise<void>;
  taskDependencies: TaskDependency[];
  refreshTaskDependencies: () => Promise<void>;
  addTaskDependency: (taskId: string, dependsOnTaskId: string) => Promise<boolean>;
  removeTaskDependency: (dependencyId: string) => Promise<void>;
}

export const TaskContext = createContext<TaskContextType | null>(null);

export const useTaskContext = () => {
  const ctx = useContext(TaskContext);
  if (!ctx) throw new Error('useTaskContext must be used within AppProvider');
  return ctx;
};
