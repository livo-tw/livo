import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { fetchComments } from '@/lib/commentQueries';
import { applyTheme, type ThemeKey } from '@/lib/themes';
import { setWebhookConfig, type WebhookConfig } from '@/lib/webhook';
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
  setRequiredFields: (f: RequiredFieldsConfig) => void;
  refreshFeatureToggles: () => Promise<void>;
  setIsLoading: (v: boolean) => void;
  setSprintActive: (v: boolean) => void;
  webhookConfigRef: React.MutableRefObject<WebhookConfig | null>;
  refreshSprints: (keepActiveState?: boolean) => Promise<void>;
}

// Wraps an optional query so a rejection (e.g. missing table) resolves to
// { data: null } instead of rejecting the whole Promise.all.
const safe = <T,>(p: PromiseLike<{ data: T | null }>, label: string) =>
  Promise.resolve(p).then(
    r => r,
    e => { console.error(`[LIVO] ${label} load skipped:`, e); return { data: null as T | null }; },
  );

export function useInitialLoad(deps: InitialLoadDeps) {
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;

    const loadAll = async () => {
      deps.setIsLoading(true);
      const sprintsPromise = deps.refreshSprints();
      const featureTogglesPromise = deps.refreshFeatureToggles();
      const [
        { data: memberRows },
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
        authRes,
        { data: settingsRows },
        { data: activeCheck },
        { data: wbRow },
      ] = await Promise.all([
        supabase.from('members').select('*'),
        supabase.from('statuses').select('*').order('sort_order'),
        supabase.from('product_lines').select('*').order('sort_order'),
        supabase.from('projects').select('*'),
        supabase.from('tags').select('*'),
        supabase.from('task_specs').select('*'),
        supabase.from('task_checks').select('*').order('sort_order'),
        supabase.from('task_todos').select('*').order('sort_order'),
        fetchComments(supabase),
        supabase.from('status_logs').select('*'),
        supabase.from('tasks').select('*'),
        supabase.from('task_deployments').select('*'),
        supabase.from('task_attachments').select('task_id'),
        supabase.from('task_tags').select('*'),
        safe(supabase.from('custom_fields').select('*').order('sort_order'), 'custom_fields'),
        safe(supabase.from('task_custom_field_values').select('*'), 'custom_field_values'),
        safe(supabase.from('task_templates').select('*').order('created_at', { ascending: false }), 'task_templates'),
        safe(supabase.from('task_dependencies').select('*'), 'task_dependencies'),
        supabase.auth.getUser().catch((e: unknown) => {
          console.error('[LIVO] theme load skipped:', e);
          return { data: { user: null } };
        }),
        safe(supabase.from('system_settings').select('*').eq('key', 'required_fields').maybeSingle(), 'required_fields'),
        supabase.from('sprints').select('id').eq('is_active', true).limit(1),
        safe(supabase.from('team_settings').select('value').eq('key', 'integration_webhook').maybeSingle(), 'webhook'),
      ]);

      if (cfRows) deps.setCustomFields(cfRows.map(mapCustomField));
      if (cfvRows) deps.setCustomFieldValues(cfvRows.map(mapCustomFieldValue));
      if (tmplRows) deps.setTaskTemplates(tmplRows.map(mapTaskTemplate));
      if (taskDepRows) deps.setTaskDependencies(taskDepRows.map(mapTaskDependency));

      if (memberRows) {
        deps.setUsers(memberRows.map(mapUser));
        const authUser = authRes.data.user;
        if (authUser?.email) {
          const myRow = (memberRows as MemberRow[]).find(m => m.email === authUser.email);
          if (myRow?.theme) {
            const t = myRow.theme as ThemeKey;
            deps.setUserThemeState(t);
            applyTheme(t);
          }
        }
      }

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

      await Promise.all([sprintsPromise, featureTogglesPromise]);
      // memberRows is empty when this login sees no data (Docker: not an active
      // member); it is about to be signed out, so do not try to write.
      if ((!activeCheck || activeCheck.length === 0) && (memberRows?.length ?? 0) > 0) {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const defaultName = `${y}${m}W1`;
        await supabase.from('sprints').insert({ name: defaultName, is_active: true });
        await deps.refreshSprints();
      }
      deps.setSprintActive(true);

      if (wbRow?.value) {
        deps.webhookConfigRef.current = wbRow.value as unknown as WebhookConfig;
        setWebhookConfig(deps.webhookConfigRef.current);
      }

      deps.setIsLoading(false);
    };
    loadAll().catch(err => {
      console.error('[LIVO] loadAll failed:', err);
      deps.setIsLoading(false);
    });
  }, []);
}
