import { appBaseUrl, type AuthCtx, type Ctx, type Env } from './env';
import { runQuery } from './db';
import { liveMember } from './liveMember';
import { qaSlackClient } from './qaSlackSync';
import type { TaskUnfurlActions } from './slackTaskUnfurl';

type Row = Record<string, any>;
export function createCloudTaskUnfurlActions(env: Env, ws: string, ctx: Ctx,
  resolveActor: (payload: Row) => Promise<Row>): TaskUnfurlActions {
  return {
    appUrl: `${appBaseUrl(env).replace(/\/+$/, '')}/demo/`,
    slack: qaSlackClient(env, ws),
    actor: async payload => {
      try { return await resolveActor(payload); }
      catch (error) {
        if (error instanceof Error && ['qa_forbidden', 'slack_link_disabled'].includes(error.message)) return;
        throw error;
      }
    },
    config: async () => {
      // This key is super_admin-only in the query engine, scoped to this workspace.
      const row = await env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='slack_delivery'")
        .bind(ws).first<{ value: string }>();
      try { return row ? JSON.parse(row.value) : undefined; } catch { return; }
    },
    card: async (actor, reference) => {
      const auth = actor.auth as AuthCtx | undefined;
      if (!auth || auth.member.workspaceId !== ws || !await liveMember(env, auth, { strict: true })) return;
      const read = async (table: string, cols: string, col: string, value: string): Promise<Row[]> => {
        const response = await runQuery(env, ctx, auth, { table, op: 'select', cols, filters: [{ col, op: 'eq', val: value }], limit: 2 });
        if (response.error) throw new Error('task_unfurl_read_failed');
        return Array.isArray(response.data) ? response.data as Row[] : [];
      };
      let tasks = await read('tasks', 'id,task_key,title,project_id,status_id', 'task_key', reference);
      if (!tasks.length) tasks = await read('tasks', 'id,task_key,title,project_id,status_id', 'id', reference);
      if (tasks.length !== 1 || !tasks[0].project_id || !tasks[0].status_id) return;
      const task = tasks[0];
      const [projects, statuses] = await Promise.all([
        read('projects', 'id,name,line_id,is_archived', 'id', task.project_id),
        read('statuses', 'id,name', 'id', task.status_id),
      ]);
      return projects.length === 1 && statuses.length === 1 ? { task, project: projects[0], status: statuses[0] } : undefined;
    },
  };
}
