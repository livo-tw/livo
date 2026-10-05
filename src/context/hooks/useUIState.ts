import { useState, useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Task, Project } from '@/types';
import { DEFAULT_REQUIRED_FIELDS, type RequiredFieldsConfig, type ViewType, type TaskDisplayMode } from '../UIContext';
import { canManageFeatureToggles, resolveFeatureToggles, type FeatureKey, type FeatureToggles } from '@/lib/featureToggles';
import { loadFeatureToggles, persistFeatureToggle } from '@/lib/featureToggleQueries';
import { clearQaNavigationGuards, hasQaNavigationGuard, notifyQaNavigationBlocked } from '@/lib/qa/navigationGuard';
import { hasReleaseNavigationGuard, notifyReleaseNavigationBlocked } from '@/components/releases/navigation';
import { confirmDiscardDrafts } from '@/lib/unsavedDrafts';
import { clearOtherViewParams } from '@/lib/viewUrl';
import { useIsMobile } from '@/hooks/use-mobile';

const TASK_DISPLAY_MODE_KEY = 'livo.taskDisplayMode';
/** The member's choice of modal, side panel or full page, remembered in this browser. */
function storedTaskDisplayMode(): TaskDisplayMode {
  try { const value = localStorage.getItem(TASK_DISPLAY_MODE_KEY); return value === 'side' || value === 'page' ? value : 'modal'; } catch { return 'modal'; }
}

export function useUIState(role?: string) {
  const [featureToggles, setFeatureToggles] = useState<FeatureToggles>(() =>
    resolveFeatureToggles(undefined, { hasApprovalRules: false, hasApprovalRequests: false }));
  const [featureTogglesReady, setFeatureTogglesReady] = useState(false);
  const [featureTogglesError, setFeatureTogglesError] = useState<string | null>(null);
  const featureLoadVersion = useRef(0);
  const refreshFeatureToggles = useCallback(async () => {
    const version = ++featureLoadVersion.current;
    try {
      const toggles = await loadFeatureToggles();
      if (version !== featureLoadVersion.current) return;
      setFeatureToggles(toggles);
      setFeatureTogglesReady(true);
      setFeatureTogglesError(null);
    } catch (error) {
      if (version !== featureLoadVersion.current) return;
      setFeatureTogglesReady(false);
      setFeatureTogglesError(error instanceof Error ? error.message : String(error));
      console.error('[LIVO] Feature settings could not be loaded:', error);
    }
  }, []);
  const saveFeatureToggle = useCallback(async (key: FeatureKey, enabled: boolean) => {
    if (!canManageFeatureToggles(role)) throw new Error('Administrator required');
    if (!featureTogglesReady) throw new Error('Feature settings are not ready');
    await persistFeatureToggle(key, enabled);
    setFeatureToggles(previous => ({ ...previous, [key]: enabled }));
    await refreshFeatureToggles();
  }, [role, featureTogglesReady, refreshFeatureToggles]);
  const [currentView, setCurrentViewState] = useState<ViewType>('board');
  const navigationState = useRef({ currentView, qaEnabled: false });
  navigationState.current = { currentView, qaEnabled: featureTogglesReady && featureToggles.qa };
  const setCurrentView = useCallback<Dispatch<SetStateAction<ViewType>>>(value => {
    const previous = navigationState.current.currentView;
    const next = typeof value === 'function' ? value(previous) : value;
    if (next === previous) return;
    if (hasReleaseNavigationGuard()) { notifyReleaseNavigationBlocked(); return; }
    if (navigationState.current.qaEnabled && hasQaNavigationGuard()) { notifyQaNavigationBlocked(); return; }
    // Unsaved text (a knowledge page draft) is lost when its view closes.
    if (!confirmDiscardDrafts('view')) return;
    // Capability revocation has priority over preserving pending UI work.
    if (!navigationState.current.qaEnabled) clearQaNavigationGuards();
    clearOtherViewParams(next);
    navigationState.current.currentView = next; setCurrentViewState(next);
  }, []);
  const [selectedTask, setSelectedTaskState] = useState<Task | null>(null);
  const [preferredDisplayMode, setTaskDisplayModeState] = useState<TaskDisplayMode>(storedTaskDisplayMode);
  // Phones always show a task as a full page; the desktop choice is kept, not overwritten.
  const isMobile = useIsMobile();
  const taskDisplayMode: TaskDisplayMode = isMobile ? 'page' : preferredDisplayMode;
  const taskNavigation = useRef({ selectedTask, taskDisplayMode });
  taskNavigation.current = { selectedTask, taskDisplayMode };
  const setSelectedTask = useCallback<Dispatch<SetStateAction<Task | null>>>(value => {
    const next = typeof value === 'function' ? value(taskNavigation.current.selectedTask) : value;
    if (next && taskNavigation.current.taskDisplayMode === 'page' && hasReleaseNavigationGuard()) { notifyReleaseNavigationBlocked(); return; }
    if (next && taskNavigation.current.taskDisplayMode === 'page' && navigationState.current.qaEnabled && hasQaNavigationGuard()) { notifyQaNavigationBlocked(); return; }
    // Closing the task or opening another discards an unsaved rich-text edit in it.
    if (next?.id !== taskNavigation.current.selectedTask?.id && !confirmDiscardDrafts('task')) return;
    taskNavigation.current.selectedTask = next; setSelectedTaskState(next);
  }, []);
  const setTaskDisplayMode = useCallback<Dispatch<SetStateAction<TaskDisplayMode>>>(value => {
    const next = typeof value === 'function' ? value(taskNavigation.current.taskDisplayMode) : value;
    if (next === 'page' && taskNavigation.current.selectedTask && hasReleaseNavigationGuard()) { notifyReleaseNavigationBlocked(); return; }
    if (next === 'page' && taskNavigation.current.selectedTask && navigationState.current.qaEnabled && hasQaNavigationGuard()) { notifyQaNavigationBlocked(); return; }
    taskNavigation.current.taskDisplayMode = next; setTaskDisplayModeState(next);
    try { localStorage.setItem(TASK_DISPLAY_MODE_KEY, next); } catch { /* private window: the choice lasts until reload */ }
  }, []);
  const [standupMode, setStandupMode] = useState(false);
  const [standupUserId, setStandupUserId] = useState<string | null>(null);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [requiredFields, setRequiredFields] = useState<RequiredFieldsConfig>(DEFAULT_REQUIRED_FIELDS);
  const [isLoading, setIsLoading] = useState(true);

  const saveRequiredFields = useCallback(async (fields: RequiredFieldsConfig) => {
    setRequiredFields(fields);
    await supabase.from('system_settings').upsert({ key: 'required_fields', value: fields as Record<string, boolean>, updated_at: new Date().toISOString() } as Parameters<typeof supabase.from<'system_settings'>>[0] extends string ? never : Record<string, unknown>);
  }, []);

  return {
    featureToggles, approvalsEnabled: featureToggles.approvals,
    featureTogglesReady, featureTogglesError, refreshFeatureToggles, saveFeatureToggle,
    currentView, setCurrentView,
    selectedTask, setSelectedTask,
    standupMode, setStandupMode,
    standupUserId, setStandupUserId,
    showCreateProject, setShowCreateProject,
    showCreateTask, setShowCreateTask,
    editingProject, setEditingProject,
    taskDisplayMode, setTaskDisplayMode,
    requiredFields, setRequiredFields, saveRequiredFields,
    isLoading, setIsLoading,
  };
}
