import { createContext, useContext } from 'react';
import type { Task, Project } from '@/types';

export type ViewType = 'board' | 'backlog' | 'dashboard' | 'gantt' | 'all-list' | 'my-tasks' | 'work-report' | 'status-manage' | 'member-manage' | 'team-manage' | 'team-intro' | 'system-admin' | 'activity-log' | 'my-settings' | 'team-settings' | 'template-manage' | 'integrations' | 'approvals';
export type TaskDisplayMode = 'modal' | 'side' | 'page';

export interface RequiredFieldsConfig {
  title: boolean;
  project: boolean;
  status: boolean;
  priority: boolean;
  assignee: boolean;
  reviewer: boolean;
  dueDate: boolean;
  startDate: boolean;
  tags: boolean;
  background: boolean;
  requirement: boolean;
  notes: boolean;
  checks: boolean;
  todos: boolean;
  gitlabUrl: boolean;
  deployments: boolean;
}

export const DEFAULT_REQUIRED_FIELDS: RequiredFieldsConfig = {
  title: true,
  project: true,
  status: false,
  priority: false,
  assignee: false,
  reviewer: false,
  dueDate: true,
  startDate: false,
  tags: false,
  background: false,
  requirement: false,
  notes: false,
  checks: false,
  todos: false,
  gitlabUrl: false,
  deployments: false,
};

export interface UIContextType {
  currentView: ViewType;
  setCurrentView: (v: ViewType) => void;
  selectedTask: Task | null;
  setSelectedTask: (t: Task | null) => void;
  standupMode: boolean;
  setStandupMode: (v: boolean) => void;
  standupUserId: string | null;
  setStandupUserId: (id: string | null) => void;
  showCreateProject: boolean;
  setShowCreateProject: (v: boolean) => void;
  showCreateTask: boolean;
  setShowCreateTask: (v: boolean) => void;
  editingProject: Project | null;
  setEditingProject: (p: Project | null) => void;
  taskDisplayMode: TaskDisplayMode;
  setTaskDisplayMode: (m: TaskDisplayMode) => void;
  requiredFields: RequiredFieldsConfig;
  setRequiredFields: (fields: RequiredFieldsConfig) => void;
  saveRequiredFields: (fields: RequiredFieldsConfig) => Promise<void>;
  isLoading: boolean;
}

export const UIContext = createContext<UIContextType | null>(null);

export const useUIContext = () => {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error('useUIContext must be used within AppProvider');
  return ctx;
};