// Backward-compatible aggregation: re-exports all context hooks and types.
// New code should import from specific context files instead.

export { AppProvider } from './AppProvider';
export { useAuthContext } from './AuthContext';
export type { AuthContextType } from './AuthContext';
export { useMemberContext } from './MemberContext';
export type { MemberContextType } from './MemberContext';
export { useUIContext, DEFAULT_REQUIRED_FIELDS } from './UIContext';
export type { UIContextType, ViewType, TaskDisplayMode, RequiredFieldsConfig } from './UIContext';
export { useProjectContext } from './ProjectContext';
export type { ProjectContextType } from './ProjectContext';
export { useTaskContext } from './TaskContext';
export type { TaskContextType } from './TaskContext';
export { useSprintContext } from './SprintContext';
export type { SprintContextType, Sprint } from './SprintContext';

// Aggregated hook for backward compatibility — prefer specific hooks in new code
import { useAuthContext } from './AuthContext';
import { useMemberContext } from './MemberContext';
import { useUIContext } from './UIContext';
import { useProjectContext } from './ProjectContext';
import { useTaskContext } from './TaskContext';
import { useSprintContext } from './SprintContext';

export const useAppContext = () => {
  const auth = useAuthContext();
  const member = useMemberContext();
  const ui = useUIContext();
  const project = useProjectContext();
  const task = useTaskContext();
  const sprint = useSprintContext();

  return {
    ...auth,
    ...member,
    ...ui,
    ...project,
    ...task,
    ...sprint,
  };
};
