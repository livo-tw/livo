import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { fetchComments } from '@/lib/commentQueries';
import { applyBoardTaskChanges, fetchBoardRows, type BeginBoardRead, type BoardTaskChanges, type BoardTaskEvent } from '@/lib/boardQueries';
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

  // Startup and refresh may overlap. Each read keeps its own last task event
  // per ID. An older read cannot replace a newer published snapshot.
  const boardReads = useRef<Partial<Record<'startup' | 'refresh', BoardTaskChanges>>>({});
  const boardReadSequence = useRef(0);
  const publishedBoardRead = useRef(0);
  const beginBoardRead = useCallback<BeginBoardRead>(kind => {
    const changes: BoardTaskChanges = new Map();
    const sequence = ++boardReadSequence.current;
    boardReads.current[kind] = changes;
    const isCurrent = () => boardReads.current[kind] === changes;
    const close = () => { if (isCurrent()) delete boardReads.current[kind]; };
    return {
      isCurrent,
      close,
      publish: (tasks, deployments) => {
        if (!isCurrent()) return;
        close();
        if (sequence < publishedBoardRead.current) return;
        publishedBoardRead.current = sequence;
        setDeployMap(deployments);
        setAllTasks(applyBoardTaskChanges(tasks, changes));
      },
    };
  }, []);

  const recordBoardTaskEvent = useCallback((event: BoardTaskEvent) => {
    for (const changes of Object.values(boardReads.current)) {
      if (event.kind === 'delete') {
        changes.set(event.id, null);
      } else {
        const previous = changes.get(event.task.id);
        changes.set(event.task.id, { task: event.task, inserted: event.kind === 'insert' || !!previous?.inserted });
      }
    }
  }, []);

  const refreshTasks = useCallback(async () => {
    const boardRead = beginBoardRead('refresh');
    const results = await Promise.all([
      fetchBoardRows(options => supabase.from('tasks').select('*', options)),
      fetchBoardRows(options => supabase.from('task_deployments').select('*', options)),
      fetchBoardRows(options => supabase.from('task_attachments').select('id,task_id', options)),
      fetchBoardRows(options => supabase.from('comments').select('id,task_id', options).not('attachment_url', 'is', null)),
      fetchBoardRows(options => supabase.from('task_tags').select('*', options)),
    ]);
    if (!boardRead.isCurrent()) return;
    const failure = results.find(result => result.error);
    if (failure) {
      boardRead.close();
      console.error('[LIVO] refreshTasks skipped:', failure.error);
      return;
    }
    const [{ data: taskRows }, { data: deployRows }, { data: attRows }, { data: commentAtts }, { data: taskTagRows }] = results;
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
      const fetched = taskRows.map(r => {
        const mapped = mapTask(r);
        return {
          ...mapped,
          deployments: dm.get(r.id) || [],
          attachmentCount: attCounts.get(r.id) || 0,
          tagIds: tagMap.get(r.id) || mapped.tagIds || undefined,
        };
      });
      boardRead.publish(fetched, dm);
    }
    boardRead.close();
  }, [beginBoardRead]);

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
    refreshTaskTemplates, refreshTaskDependencies, refreshTasks, recordBoardTaskEvent, beginBoardRead,
  };
}
