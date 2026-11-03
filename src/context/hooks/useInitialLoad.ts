import { useEffect, useRef, useState } from 'react';
import { supabase, USING_MOCK_BACKEND } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { fetchComments } from '@/lib/commentQueries';
import { applyTheme, type ThemeKey } from '@/lib/themes';
import type {
  Task, User, Status, ProductLine, Project, Tag,
  TaskSpec, TaskCheck, TaskTodo, Comment, StatusLog,
  TaskDeployment, CustomField, TaskCustomFieldValue,
  TaskTemplate, TaskDependency,
} from '@/types';
import {
  mapUser, mapStatus, mapProductLine, mapProject, mapTag,
  mapTaskSpec, mapTaskCheck, mapTaskTodo, mapComment, mapStatusLog,
  mapTask, mapCustomField, mapCustomFieldValue, mapTaskTemplate,
  mapTaskDependency,
  type TaskTagRow, type MemberRow,
} from '../mappers';
import { DEFAULT_REQUIRED_FIELDS, type RequiredFieldsConfig } from '../UIContext';

interface InitialLoadDeps {
  setUsers: (u: User[]) => void;
  setStatuses: (s: Status[]) => void;
  setProductLines: (p: ProductLine[]) => void;
  setAllProjects: (p: Project[]) => void;
  setTags: (t: Tag[]) => void;
  setTaskSpecs: (s: TaskSpec[]) => void;
  setTaskChecks: (c: TaskCheck[]) => void;
  setTaskTodos: (t: TaskTodo[]) => void;
  setComments: (c: Comment[]) => void;
  setStatusLogs: (l: StatusLog[]) => void;
  setAllTasks: (t: Task[]) => void;
  setDeployMap: (m: Map<string, TaskDeployment[]>) => void;
  setCustomFields: (f: CustomField[]) => void;
  setCustomFieldValues: (v: TaskCustomFieldValue[]) => void;
  setTaskTemplates: (t: TaskTemplate[]) => void;
  setTaskDependencies: (d: TaskDependency[]) => void;
  setUserThemeState: (t: ThemeKey) => void;
  readAuthUser?: () => ReturnType<typeof supabase.auth.getUser>;
  setRequiredFields: (f: RequiredFieldsConfig) => void;
  refreshFeatureToggles: () => Promise<void>;
  setIsLoading: (v: boolean) => void;
  setSprintActive: (v: boolean) => void;
  refreshSprints: (keepActiveState?: boolean) => Promise<void>;
}

// Wraps an optional query so a rejection (e.g. missing table) resolves to
// { data: null } instead of rejecting the whole Promise.all.
const safe = <T,>(p: PromiseLike<{ data: T | null }>, label: string) =>
  Promise.resolve(p).then(
    r => r,
    e => { console.error(`[LIVO] ${label} load skipped:`, e); return { data: null as T | null }; },
  );

// A required read returning an error/null is unknown, not an empty collection.
const required = <T,>(p: PromiseLike<{ data: T | null; error?: unknown }>, label: string) =>
  Promise.resolve(p).then(result => {
    if (result.error || result.data === null) throw result.error || new Error(`${label} returned no data`);
    return result;
  });

export function useInitialLoad(deps: InitialLoadDeps) {
  const [loadFailed, setLoadFailed] = useState(false);
  const loadedRef = useRef(false);
  const activeRef = useRef(false);

  useEffect(() => {
    activeRef.current = true;
    if (loadedRef.current) return () => { activeRef.current = false; };
    loadedRef.current = true;

    const loadAll = async () => {
      deps.setIsLoading(true);
      // Publish the fresh member list independently of large task/history reads.
      // Identity verification must not wait for unrelated application data.
      const membersPromise = required(supabase.from('members').select('*'), 'members').then(result => {
        if (activeRef.current && result.data) deps.setUsers(result.data.map(mapUser));
        return result;
      });
      const authPromise = (deps.readAuthUser ? deps.readAuthUser() : supabase.auth.getUser()).catch((e: unknown) => {
        if (activeRef.current) console.error('[LIVO] theme load skipped:', e);
        return { data: { user: null } };
      });
      void Promise.all([membersPromise, authPromise]).then(([{ data: memberRows }, authRes]) => {
        if (!activeRef.current || !memberRows || ('error' in authRes && authRes.error)) return;
        const authUser = authRes.data.user;
        if (!authUser) return;
        const rows = memberRows as MemberRow[];
        const allowEmailSelfLink = USING_MOCK_BACKEND || Boolean(import.meta.env.VITE_API_URL);
        const myRow = rows.find(m => m.auth_id === authUser.id)
          || (allowEmailSelfLink ? rows.find(m => !!authUser.email && m.email === authUser.email) : undefined);
        if (myRow?.theme) {
          const theme = myRow.theme as ThemeKey;
          deps.setUserThemeState(theme);
          applyTheme(theme);
        }
      }).catch(() => { /* The main load reports a member-read failure below. */ });
      // Attach rejection handling immediately while the other reads are running.
      const sprintsPromise = Promise.allSettled([deps.refreshSprints()]);
      const featureTogglesPromise = deps.refreshFeatureToggles();
      const [
        , // Members have already been published independently.
        { data: statusRows },
        { data: plRows },
        { data: projRows },
        { data: tagRows },
        { data: specRows },
        { data: checkRows },
        { data: todoRows },
        { data: commentRows },
        { data: logRows },
        { data: taskRows },
        { data: deployRows },
        { data: attRows },
        { data: taskTagRows },
        { data: cfRows },
        { data: cfvRows },
        { data: tmplRows },
        { data: taskDepRows },
        { data: settingsRows },
      ] = await Promise.all([
        membersPromise,
        required(supabase.from('statuses').select('*').order('sort_order'), 'statuses'),
        required(supabase.from('product_lines').select('*').order('sort_order'), 'product_lines'),
        required(supabase.from('projects').select('*'), 'projects'),
        required(supabase.from('tags').select('*'), 'tags'),
        required(supabase.from('task_specs').select('*'), 'task_specs'),
        required(supabase.from('task_checks').select('*').order('sort_order'), 'task_checks'),
        required(supabase.from('task_todos').select('*').order('sort_order'), 'task_todos'),
        required(fetchComments(supabase), 'comments'),
        required(supabase.from('status_logs').select('*'), 'status_logs'),
        required(supabase.from('tasks').select('*'), 'tasks'),
        required(supabase.from('task_deployments').select('*'), 'task_deployments'),
        required(supabase.from('task_attachments').select('task_id'), 'task_attachments'),
        required(supabase.from('task_tags').select('*'), 'task_tags'),
        safe(supabase.from('custom_fields').select('*').order('sort_order'), 'custom_fields'),
        safe(supabase.from('task_custom_field_values').select('*'), 'custom_field_values'),
        safe(supabase.from('task_templates').select('*').order('created_at', { ascending: false }), 'task_templates'),
        safe(supabase.from('task_dependencies').select('*'), 'task_dependencies'),
        safe(supabase.from('system_settings').select('*').eq('key', 'required_fields').maybeSingle(), 'required_fields'),
      ]);
      if (!activeRef.current) return;

      if (cfRows) deps.setCustomFields(cfRows.map(mapCustomField));
      if (cfvRows) deps.setCustomFieldValues(cfvRows.map(mapCustomFieldValue));
      if (tmplRows) deps.setTaskTemplates(tmplRows.map(mapTaskTemplate));
      if (taskDepRows) deps.setTaskDependencies(taskDepRows.map(mapTaskDependency));

      if (settingsRows?.value) {
        deps.setRequiredFields({ ...DEFAULT_REQUIRED_FIELDS, ...(settingsRows.value as Partial<RequiredFieldsConfig>) });
      }

      if (statusRows) deps.setStatuses(statusRows.map(mapStatus));
      if (plRows) deps.setProductLines(plRows.map(mapProductLine));
      if (projRows) deps.setAllProjects(projRows.map(mapProject));
      if (tagRows) deps.setTags(tagRows.map(mapTag));
      if (specRows) deps.setTaskSpecs(specRows.map(mapTaskSpec));
      if (checkRows) deps.setTaskChecks(checkRows.map(mapTaskCheck));
      if (todoRows) deps.setTaskTodos(todoRows.map(mapTaskTodo));
      if (commentRows) deps.setComments(commentRows.map(mapComment));
      if (logRows) deps.setStatusLogs(logRows.map(mapStatusLog));

      if (taskRows) {
        const dm = new Map<string, TaskDeployment[]>();
        (deployRows || []).forEach(d => {
          const arr = dm.get(d.task_id) || [];
          arr.push({ environment: d.environment, status: d.status, deployDate: d.deploy_date || undefined });
          dm.set(d.task_id, arr);
        });
        deps.setDeployMap(dm);
        const attCounts = new Map<string, number>();
        (attRows || []).forEach(a => {
          attCounts.set(a.task_id, (attCounts.get(a.task_id) || 0) + 1);
        });
        if (commentRows) {
          commentRows.filter(c => c.attachment_url).forEach(c => {
            attCounts.set(c.task_id, (attCounts.get(c.task_id) || 0) + 1);
          });
        }
        const tagMap = new Map<string, string[]>();
        ((taskTagRows || []) as TaskTagRow[]).forEach(tt => {
          const arr = tagMap.get(tt.task_id) || [];
          arr.push(tt.tag_id);
          tagMap.set(tt.task_id, arr);
        });
        deps.setAllTasks(taskRows.map(r => ({ ...mapTask(r), deployments: dm.get(r.id) || [], attachmentCount: attCounts.get(r.id) || 0, tagIds: tagMap.get(r.id) || undefined })));
      }

      const [sprintReads] = await Promise.all([sprintsPromise, featureTogglesPromise]);
      if (!activeRef.current) return;
      if (sprintReads[0].status === 'rejected') {
        toast.error(i18n.t('sprint.refreshFailed'));
        throw sprintReads[0].reason;
      }
      // Starting a sprint is an explicit lifecycle command. A read or reload
      // must never create a new sprint or move backlog cards implicitly.


      deps.setIsLoading(false);
    };
    loadAll().catch(err => {
      if (activeRef.current) {
        console.error('[LIVO] loadAll failed:', err);
        setLoadFailed(true);
        deps.setIsLoading(false);
      }
    });
    return () => { activeRef.current = false; };
  }, []);
  return { loadFailed };
}
