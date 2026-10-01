import type {
  Task, TaskDeployment, Comment, TaskSpec, TaskCheck, TaskTodo,
  TaskCustomFieldValue, TaskDependency, Project,
} from '@/types';
import { useHighFreqSubs } from './useHighFreqSubs';
import { useConfigSubs } from './useConfigSubs';

interface RealtimeSubsDeps {
  setAllTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setSelectedTask: (fn: (prev: Task | null) => Task | null) => void;
  setComments: React.Dispatch<React.SetStateAction<Comment[]>>;
  setTaskSpecs: React.Dispatch<React.SetStateAction<TaskSpec[]>>;
  setTaskChecks: React.Dispatch<React.SetStateAction<TaskCheck[]>>;
  setTaskTodos: React.Dispatch<React.SetStateAction<TaskTodo[]>>;
  setDeployMap: React.Dispatch<React.SetStateAction<Map<string, TaskDeployment[]>>>;
  setCustomFieldValues: React.Dispatch<React.SetStateAction<TaskCustomFieldValue[]>>;
  setTaskDependencies: React.Dispatch<React.SetStateAction<TaskDependency[]>>;
  setAllProjects: React.Dispatch<React.SetStateAction<Project[]>>;
  refreshTags: () => Promise<void>;
  refreshCustomFields: () => Promise<void>;
  refreshTaskTemplates: () => Promise<void>;
  refreshSprints: (keepActiveState?: boolean) => Promise<void>;
  refreshTasks: () => Promise<void>;
  refreshUsers: () => Promise<void>;
  refreshStatuses: () => Promise<void>;
  refreshProductLines: () => Promise<void>;
  refreshFeatureToggles: () => Promise<void>;
}

export function useRealtimeSubs(deps: RealtimeSubsDeps) {
  useHighFreqSubs(deps);
  useConfigSubs(deps);
}
