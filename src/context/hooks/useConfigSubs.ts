import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { TaskCustomFieldValue, TaskDependency, Project } from '@/types';
import { mapCustomFieldValue, mapTaskDependency, mapProject } from '../mappers';

export interface ConfigSubsDeps {
  setTaskDependencies: React.Dispatch<React.SetStateAction<TaskDependency[]>>;
  setCustomFieldValues: React.Dispatch<React.SetStateAction<TaskCustomFieldValue[]>>;
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

export function useConfigSubs(deps: ConfigSubsDeps) {
  const refreshTasksTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const debouncedRefreshTasks = () => {
      if (refreshTasksTimerRef.current) clearTimeout(refreshTasksTimerRef.current);
      refreshTasksTimerRef.current = setTimeout(() => deps.refreshTasks(), 400);
    };
    const configChannel = supabase
      .channel('config-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'system_settings' }, () => {
        void deps.refreshFeatureToggles();
        debouncedRefreshTasks();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sprints' }, () => {
        deps.refreshSprints();
        debouncedRefreshTasks();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'members' }, () => {
        deps.refreshUsers();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'statuses' }, () => {
        deps.refreshStatuses();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tags' }, () => {
        deps.refreshTags();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'product_lines' }, () => {
        deps.refreshProductLines();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, () => {
        debouncedRefreshTasks();
        const loadProjects = async () => {
          const { data } = await supabase.from('projects').select('*');
          if (data) deps.setAllProjects(data.map(mapProject));
        };
        loadProjects();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_templates' }, () => {
        deps.refreshTaskTemplates();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'custom_fields' }, () => {
        deps.refreshCustomFields();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_dependencies' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const newDep = mapTaskDependency(payload.new);
          deps.setTaskDependencies(prev => {
            if (prev.find(d => d.id === newDep.id)) return prev;
            return [...prev, newDep];
          });
        } else if (payload.eventType === 'DELETE') {
          const deletedId = (payload.old as { id: string }).id;
          deps.setTaskDependencies(prev => prev.filter(d => d.id !== deletedId));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_custom_field_values' }, (payload) => {
        if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
          const mapped = mapCustomFieldValue(payload.new);
          deps.setCustomFieldValues(prev => {
            const idx = prev.findIndex(v => v.taskId === mapped.taskId && v.fieldId === mapped.fieldId);
            if (idx >= 0) return prev.map((v, i) => i === idx ? mapped : v);
            return [...prev, mapped];
          });
        } else if (payload.eventType === 'DELETE') {
          const old = payload.old as { id: string };
          deps.setCustomFieldValues(prev => prev.filter(v => v.id !== old.id));
        }
      })
      .subscribe();

    return () => {
      if (refreshTasksTimerRef.current) clearTimeout(refreshTasksTimerRef.current);
      supabase.removeChannel(configChannel);
    };
  }, [deps.refreshFeatureToggles, deps.refreshTags, deps.refreshCustomFields, deps.refreshTaskTemplates, deps.refreshSprints, deps.refreshTasks, deps.refreshUsers, deps.refreshStatuses, deps.refreshProductLines]);
}
