import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Task, Project } from '@/types';
import { DEFAULT_REQUIRED_FIELDS, type RequiredFieldsConfig, type ViewType, type TaskDisplayMode } from '../UIContext';
import { canManageFeatureToggles, resolveFeatureToggles, type FeatureKey, type FeatureToggles } from '@/lib/featureToggles';
import { loadFeatureToggles, persistFeatureToggle } from '@/lib/featureToggleQueries';

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
  const [currentView, setCurrentView] = useState<ViewType>('board');
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [standupMode, setStandupMode] = useState(false);
  const [standupUserId, setStandupUserId] = useState<string | null>(null);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [taskDisplayMode, setTaskDisplayMode] = useState<TaskDisplayMode>('modal');
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
