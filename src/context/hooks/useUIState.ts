import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Task, Project } from '@/types';
import { DEFAULT_REQUIRED_FIELDS, type RequiredFieldsConfig, type ViewType, type TaskDisplayMode } from '../UIContext';

export function useUIState() {
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
