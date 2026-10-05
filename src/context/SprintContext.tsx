import { createContext, useContext } from 'react';
import type { PendingTaskAction } from './hooks/useSprintState';

export type { PendingTaskAction } from './hooks/useSprintState';

export interface Sprint {
  id: string;
  name: string;
  startedAt: string;
  completedAt: string | null;
  completedCount: number;
  pendingCount: number;
  isActive: boolean;
}

export interface SprintContextType {
  sprintActive: boolean;
  setSprintActive: (v: boolean) => void;
  sprintStartedAt: string | null;
  sprints: Sprint[];
  currentSprint: Sprint | null;
  /** Resolves false when the sprint was not started (the reason is shown). */
  startSprint: (name: string, carryOverTaskIds?: string[], includeBacklog?: boolean) => Promise<boolean>;
  getDefaultSprintName: () => string;
  /** Resolves null when the sprint was not completed (the reason is shown); otherwise its unfinished tasks. */
  completeSprint: (pendingAction?: PendingTaskAction) => Promise<{ pendingIds: string[] } | null>;
  renameSprint: (sprintId: string, newName: string) => Promise<void>;
  refreshSprints: () => Promise<void>;
}

export const SprintContext = createContext<SprintContextType | null>(null);

export const useSprintContext = () => {
  const ctx = useContext(SprintContext);
  if (!ctx) throw new Error('useSprintContext must be used within AppProvider');
  return ctx;
};
