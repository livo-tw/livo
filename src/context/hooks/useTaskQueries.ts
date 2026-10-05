import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { fetchComments } from '@/lib/commentQueries';
import type {
  Task, Status, Tag, TaskSpec, TaskCheck, TaskTodo, Comment, StatusLog,
  CustomField, TaskCustomFieldValue, TaskTemplate, TaskDependency, TaskDeployment,
} from '@/types';
import {
  mapTask, mapStatus, mapTag, mapTaskSpec, mapTaskCheck, mapTaskTodo,
  mapComment, mapStatusLog, mapCustomField, mapCustomFieldValue,
  mapTaskTemplate, mapTaskDependency,
  type TaskTagRow,
} from '../mappers';

export function useTaskQueries() {
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [taskSpecs, setTaskSpecs] = useState<TaskSpec[]>([]);
  const [taskChecks, setTaskChecks] = useState<TaskCheck[]>([]);
  const [taskTodos, setTaskTodos] = useState<TaskTodo[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [statusLogs, setStatusLogs] = useState<StatusLog[]>([]);
  const [deployMap, setDeployMap] = useState<Map<string, TaskDeployment[]>>(new Map());
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customFieldValues, setCustomFieldValues] = useState<TaskCustomFieldValue[]>([]);
  const [taskTemplates, setTaskTemplates] = useState<TaskTemplate[]>([]);
  const [taskDependencies, setTaskDependencies] = useState<TaskDependency[]>([]);

  const refreshStatuses = useCallback(async () => {
    const { data, error } = await supabase.from('statuses').select('*').order('sort_order');
    if (error) { console.error('[LIVO] refreshStatuses failed:', error.message); return; }
    if (data) setStatuses(data.map(mapStatus));
  }, []);

  const refreshTags = useCallback(async () => {
    const { data, error } = await supabase.from('tags').select('*');
    if (error) { console.error('[LIVO] refreshTags failed:', error.message); return; }
    if (data) setTags(data.map(mapTag));
  }, []);

  const refreshTaskSpecs = useCallback(async () => {
    const { data, error } = await supabase.from('task_specs').select('*');
    if (error) { console.error('[LIVO] refreshTaskSpecs failed:', error.message); return; }
    if (data) setTaskSpecs(data.map(mapTaskSpec));
  }, []);

  const refreshTaskChecks = useCallback(async () => {
    const { data, error } = await supabase.from('task_checks').select('*');
    if (error) { console.error('[LIVO] refreshTaskChecks failed:', error.message); return; }
    if (data) setTaskChecks(data.map(mapTaskCheck));
  }, []);

  const refreshTaskTodos = useCallback(async () => {
    const { data, error } = await supabase.from('task_todos').select('*').order('sort_order');
    if (error) { console.error('[LIVO] refreshTaskTodos failed:', error.message); return; }
    if (data) setTaskTodos(data.map(mapTaskTodo));
  }, []);

  const refreshComments = useCallback(async () => {
    const { data, error } = await fetchComments(supabase);
    if (error) { console.error('[LIVO] refreshComments failed:', error.message); return; }
    if (data) setComments(data.map(mapComment));
  }, []);

  const refreshStatusLogs = useCallback(async () => {
    const { data, error } = await supabase.from('status_logs').select('*');
    if (error) { console.error('[LIVO] refreshStatusLogs failed:', error.message); return; }
    if (data) setStatusLogs(data.map(mapStatusLog));
  }, []);

  const appendStatusLog = useCallback((log: StatusLog) => {
    setStatusLogs(prev => prev.some(l => l.id === log.id) ? prev : [...prev, log]);
  }, []);

  const refreshCustomFields = useCallback(async () => {
    try {
      const { data } = await supabase.from('custom_fields').select('*').order('sort_order');
      if (data) setCustomFields(data.map(mapCustomField));
    } catch (e) {
      console.error('[LIVO] refreshCustomFields skipped:', e);
    }
  }, []);

  const refreshCustomFieldValues = useCallback(async () => {
    try {
      const { data } = await supabase.from('task_custom_field_values').select('*');
      if (data) setCustomFieldValues(data.map(mapCustomFieldValue));
    } catch (e) {
      console.error('[LIVO] refreshCustomFieldValues skipped:', e);
    }
  }, []);

  const refreshTaskTemplates = useCallback(async () => {
    try {
      const { data } = await supabase.from('task_templates').select('*').order('created_at', { ascending: false });
      if (data) setTaskTemplates(data.map(mapTaskTemplate));
    } catch (e) {
      console.error('[LIVO] refreshTaskTemplates skipped:', e);
    }
  }, []);

  const refreshTaskDependencies = useCallback(async () => {
    try {
      const { data } = await supabase.from('task_dependencies').select('*');
      if (data) setTaskDependencies(data.map(mapTaskDependency));
    } catch (e) {
      console.error('[LIVO] refreshTaskDependencies skipped:', e);
    }
  }, []);

  const refreshTasks = useCallback(async () => {
    const [{ data: taskRows }, { data: deployRows }, { data: attRows }, { data: commentAtts }, { data: taskTagRows }] = await Promise.all([
      supabase.from('tasks').select('*'),
      supabase.from('task_deployments').select('*'),
      supabase.from('task_attachments').select('task_id'),
      supabase.from('comments').select('task_id').not('attachment_url', 'is', null),
      supabase.from('task_tags').select('*'),
    ]);
    if (taskRows) {
      const dm = new Map<string, TaskDeployment[]>();
      (deployRows || []).forEach(d => {
        const arr = dm.get(d.task_id) || [];
        arr.push({ environment: d.environment, status: d.status, deployDate: d.deploy_date || undefined });
        dm.set(d.task_id, arr);
      });
      const attCounts = new Map<string, number>();
      (attRows || []).forEach(a => {
        attCounts.set(a.task_id, (attCounts.get(a.task_id) || 0) + 1);
      });
      (commentAtts || []).forEach(c => {
        attCounts.set(c.task_id, (attCounts.get(c.task_id) || 0) + 1);
      });
      const tagMap = new Map<string, string[]>();
      ((taskTagRows || []) as TaskTagRow[]).forEach(tt => {
        const arr = tagMap.get(tt.task_id) || [];
        arr.push(tt.tag_id);
        tagMap.set(tt.task_id, arr);
      });
      setDeployMap(dm);
      setAllTasks(taskRows.map(r => {
        const mapped = mapTask(r);
        return {
          ...mapped,
          deployments: dm.get(r.id) || [],
          attachmentCount: attCounts.get(r.id) || 0,
          tagIds: tagMap.get(r.id) || mapped.tagIds || undefined,
        };
      }));
    }
  }, []);

  return {
    // State + setters
    allTasks, setAllTasks,
    statuses, setStatuses,
    tags, setTags,
    taskSpecs, setTaskSpecs,
    taskChecks, setTaskChecks,
    taskTodos, setTaskTodos,
    comments, setComments,
    statusLogs, setStatusLogs,
    deployMap, setDeployMap,
    customFields, setCustomFields,
    customFieldValues, setCustomFieldValues,
    taskTemplates, setTaskTemplates,
    taskDependencies, setTaskDependencies,
    // Refresh functions
    refreshStatuses, refreshTags, refreshTaskSpecs, refreshTaskChecks, refreshTaskTodos,
    refreshComments, refreshStatusLogs, appendStatusLog, refreshCustomFields, refreshCustomFieldValues,
    refreshTaskTemplates, refreshTaskDependencies, refreshTasks,
  };
}
