import type { TaskUnfurlActions } from './slackTaskUnfurl.ts';
import type { QaDetail } from '../qa/domain.ts';
import type { QaSlackActions, QaSlackActor } from '../qa/slack.ts';
import { getQaStateLabel, type QaWorkflow } from '../qa/workflow.ts';
import { qaPriorityText, qaSeverityText } from '../qa/notificationText.ts';
type Row = Record<string, any>;
type Db = { rows(table: string, query?: Row): Promise<Row[]> };
export function createTaskUnfurlActions(appUrl: string, actions: {
  actor(payload: Row): Promise<Row>;
  qa?: Pick<QaSlackActions, 'api'>;
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
    qaCard: async (actor, reference) => {
      if (!actions.qa) return;
      let detail: QaDetail, workflow: QaWorkflow;
      try {
        [detail, workflow] = await Promise.all([
          actions.qa.api<QaDetail>(actor as QaSlackActor, { action: 'get', id: reference }),
          actions.qa.api<QaWorkflow>(actor as QaSlackActor, { action: 'get_workflow' }),
        ]);
      } catch (error) {
        if ([400, 401, 403, 404].includes(Number((error as Row)?.status))) return;
        if (['qa_disabled', 'qa_forbidden', 'qa_not_found', 'slack_link_disabled'].includes(String((error as Row)?.code || (error as Row)?.message))) return;
        throw error;
      }
      const issue = detail?.issue;
      if (!issue?.projectId || issue.id !== reference) return;
      const db = memberDb(actor);
      const projects = await db.rows('projects', { select: 'id,name,line_id,is_archived', id: 'eq.' + issue.projectId, limit: '1' });
      if (projects.length !== 1) return;
      return {
        issue: { id: issue.id, projectId: issue.projectId, title: issue.title, state: issue.state,
          assigneeId: issue.assigneeId, qaOwnerId: issue.qaOwnerId },
        project: projects[0], stateLabel: getQaStateLabel(workflow, issue.state),
        assigneeName: issue.assigneeId ? detail.memberNames?.[issue.assigneeId] : undefined,
        qaOwnerName: issue.qaOwnerId ? detail.memberNames?.[issue.qaOwnerId] : undefined,
        priorityLabel: qaPriorityText(issue.priority, actor.locale),
        severityLabel: qaSeverityText(issue.severity, actor.locale), dueDate: issue.dueDate,
      };
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
