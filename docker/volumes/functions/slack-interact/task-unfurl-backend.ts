import type { TaskUnfurlActions } from './slackTaskUnfurl.ts';
type Row = Record<string, any>;
type Db = { rows(table: string, query?: Row): Promise<Row[]> };
export function createTaskUnfurlActions(appUrl: string, actions: {
  actor(payload: Row): Promise<Row>;
  task(actor: Row, id: string, byKey?: boolean): Promise<Row | undefined>;
  slack(method: string, body: Row): Promise<Row>;
}, memberDb: (actor: Row) => Db, config: TaskUnfurlActions['config']): TaskUnfurlActions {
  return {
    appUrl, config, slack: actions.slack,
    actor: async payload => {
      try { return await actions.actor(payload); }
      catch (error) {
        if (error instanceof Error && error.name === 'ActionError') return;
        throw error;
      }
    },
    card: async (actor, reference) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(reference)) return;
      const task = await actions.task(actor, reference, true) || await actions.task(actor, reference);
      if (!task?.project_id || !task.status_id) return;
      // Every read, including the labels, uses the caller's fresh member JWT/RLS.
      const db = memberDb(actor);
      const [projects, statuses] = await Promise.all([
        db.rows('projects', { select: 'id,name,line_id,is_archived', id: `eq.${task.project_id}`, limit: '1' }),
        db.rows('statuses', { select: 'id,name', id: `eq.${task.status_id}`, limit: '1' }),
      ]);
      return projects[0] && statuses[0] ? { task, project: projects[0], status: statuses[0] } : undefined;
    },
  };
}
