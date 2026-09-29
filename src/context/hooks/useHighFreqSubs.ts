import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Task, TaskDeployment, Comment, TaskSpec, TaskCheck, TaskTodo } from '@/types';
import {
  mapTask, mapComment, mapTaskSpec, mapTaskCheck, mapTaskTodo,
  type TaskTagRow,
} from '../mappers';

export interface HighFreqSubsDeps {
  setAllTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setSelectedTask: (fn: (prev: Task | null) => Task | null) => void;
  setComments: React.Dispatch<React.SetStateAction<Comment[]>>;
  setTaskSpecs: React.Dispatch<React.SetStateAction<TaskSpec[]>>;
  setTaskChecks: React.Dispatch<React.SetStateAction<TaskCheck[]>>;
  setTaskTodos: React.Dispatch<React.SetStateAction<TaskTodo[]>>;
  setDeployMap: React.Dispatch<React.SetStateAction<Map<string, TaskDeployment[]>>>;
}

export function useHighFreqSubs(deps: HighFreqSubsDeps) {
  const deployTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tagTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const tasksChannel = supabase
      .channel('tasks-comments-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const newTask = { ...mapTask(payload.new), deployments: [] };
          deps.setAllTasks(prev => {
            if (prev.find(t => t.id === newTask.id)) return prev;
            return [...prev, newTask];
          });
        } else if (payload.eventType === 'UPDATE') {
          const updated = mapTask(payload.new);
          deps.setAllTasks(prev => prev.map(t =>
            t.id === updated.id ? { ...updated, deployments: t.deployments, attachmentCount: t.attachmentCount, tagIds: t.tagIds } : t
          ));
          deps.setSelectedTask(prev => {
            if (prev && prev.id === updated.id) {
              return { ...updated, deployments: prev.deployments, attachmentCount: prev.attachmentCount, tagIds: prev.tagIds };
            }
            return prev;
          });
        } else if (payload.eventType === 'DELETE') {
          const deletedId = (payload.old as { id: string }).id;
          deps.setAllTasks(prev => prev.filter(t => t.id !== deletedId));
          deps.setSelectedTask(prev => (prev && prev.id === deletedId ? null : prev));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const newComment = mapComment(payload.new);
          deps.setComments(prev => {
            if (prev.find(c => c.id === newComment.id)) return prev;
            return [...prev, newComment];
          });
          const taskId = (payload.new as { task_id: string }).task_id;
          deps.setAllTasks(prev => prev.map(t =>
            t.id === taskId ? { ...t, commentCount: t.commentCount + 1 } : t
          ));
        } else if (payload.eventType === 'UPDATE') {
          const updated = mapComment(payload.new);
          deps.setComments(prev => prev.map(c => c.id === updated.id ? updated : c));
        } else if (payload.eventType === 'DELETE') {
          const deletedId = (payload.old as { id: string; task_id: string }).id;
          const taskId = (payload.old as { id: string; task_id: string }).task_id;
          deps.setComments(prev => prev.filter(c => c.id !== deletedId));
          if (taskId) {
            deps.setAllTasks(prev => prev.map(t =>
              t.id === taskId ? { ...t, commentCount: Math.max(0, t.commentCount - 1) } : t
            ));
          }
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_specs' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const newSpec = mapTaskSpec(payload.new);
          deps.setTaskSpecs(prev => {
            if (prev.find(s => s.id === newSpec.id)) return prev;
            return [...prev, newSpec];
          });
        } else if (payload.eventType === 'UPDATE') {
          const updated = mapTaskSpec(payload.new);
          deps.setTaskSpecs(prev => prev.map(s => s.id === updated.id ? updated : s));
        } else if (payload.eventType === 'DELETE') {
          const deletedId = (payload.old as { id: string }).id;
          deps.setTaskSpecs(prev => prev.filter(s => s.id !== deletedId));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_checks' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const item = mapTaskCheck(payload.new);
          deps.setTaskChecks(prev => {
            if (prev.find(c => c.id === item.id)) return prev;
            return [...prev, item];
          });
        } else if (payload.eventType === 'UPDATE') {
          const updated = mapTaskCheck(payload.new);
          deps.setTaskChecks(prev => prev.map(c => c.id === updated.id ? updated : c));
        } else if (payload.eventType === 'DELETE') {
          const deletedId = (payload.old as { id: string }).id;
          deps.setTaskChecks(prev => prev.filter(c => c.id !== deletedId));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_todos' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          const item = mapTaskTodo(payload.new);
          deps.setTaskTodos(prev => {
            if (prev.find(t => t.id === item.id)) return prev;
            return [...prev, item];
          });
        } else if (payload.eventType === 'UPDATE') {
          const updated = mapTaskTodo(payload.new);
          deps.setTaskTodos(prev => prev.map(t => t.id === updated.id ? updated : t));
        } else if (payload.eventType === 'DELETE') {
          const deletedId = (payload.old as { id: string }).id;
          deps.setTaskTodos(prev => prev.filter(t => t.id !== deletedId));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_deployments' }, () => {
        if (deployTimeoutRef.current) clearTimeout(deployTimeoutRef.current);
        deployTimeoutRef.current = setTimeout(async () => {
          const { data: deployRows } = await supabase.from('task_deployments').select('*');
          if (deployRows) {
            const dm = new Map<string, TaskDeployment[]>();
            deployRows.forEach(d => {
              const arr = dm.get(d.task_id) || [];
              arr.push({ environment: d.environment, status: d.status, deployDate: d.deploy_date || undefined });
              dm.set(d.task_id, arr);
            });
            deps.setDeployMap(dm);
            deps.setAllTasks(prev => prev.map(t => ({ ...t, deployments: dm.get(t.id) || [] })));
            deps.setSelectedTask(prev => {
              if (prev) return { ...prev, deployments: dm.get(prev.id) || [] };
              return prev;
            });
          }
        }, 500);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_tags' }, () => {
        if (tagTimeoutRef.current) clearTimeout(tagTimeoutRef.current);
        tagTimeoutRef.current = setTimeout(async () => {
          const { data: taskTagRows } = await supabase.from('task_tags').select('*');
          if (taskTagRows) {
            const tagMap = new Map<string, string[]>();
            (taskTagRows as TaskTagRow[]).forEach(tt => {
              const arr = tagMap.get(tt.task_id) || [];
              arr.push(tt.tag_id);
              tagMap.set(tt.task_id, arr);
            });
            deps.setAllTasks(prev => prev.map(t => ({ ...t, tagIds: tagMap.get(t.id) || undefined })));
            deps.setSelectedTask(prev => {
              if (prev) return { ...prev, tagIds: tagMap.get(prev.id) || undefined };
              return prev;
            });
          }
        }, 500);
      })
      .subscribe();

    return () => {
      if (deployTimeoutRef.current) clearTimeout(deployTimeoutRef.current);
      if (tagTimeoutRef.current) clearTimeout(tagTimeoutRef.current);
      supabase.removeChannel(tasksChannel);
    };
  }, []);
}
