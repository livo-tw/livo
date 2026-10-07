import { Database, type Environment } from '../slack-interact/backend.ts';
import { DeliveryError, type DeliveryStore } from './core.ts';
import { type QaDeliveryState, type QaDeliveryStore } from './qa-core.ts';
import { qaNotificationReferences } from '../qa/notificationText.ts';

export async function loadQaDeliveryState(db: Database, issueId: string, eventType?: string, eventDetail?: unknown): Promise<QaDeliveryState | undefined> {
  const row = (await db.rows('qa_issues', { select: 'data', id: `eq.${issueId}`, workspace_id: 'eq.default', limit: '1' }))[0];
  if (!row?.data) return undefined;
  const [projects, members, coordination] = await Promise.all([
    db.rows('projects', { select: 'id,line_id,name,is_archived', id: `eq.${row.data.projectId}`, limit: '1' }),
    db.rows('members', { select: 'id,name,role', is_active: 'eq.true', limit: '1000' }),
    db.rows('qa_project_coordination', { select: 'coordinator_id', id: `eq.${row.data.projectId}`, workspace_id: 'eq.default', limit: '1' }),
  ]);
  if (!projects[0]) return undefined;
  if (members.length >= 1000) throw new DeliveryError('recipient_lookup_incomplete', true);
  const coordinator = members.find(m => m.id === coordination[0]?.coordinator_id);
  // Historical labels include inactive members and archived projects; these lookups grant no permissions.
  const refs = qaNotificationReferences(eventType, eventDetail);
  const [memberLabels, projectLabels] = await Promise.all([
    refs.members.length ? db.rows('members', { select: 'id,name', id: `in.(${refs.members.join(',')})`, limit: '10' }) : [],
    refs.projects.length ? db.rows('projects', { select: 'id,name', id: `in.(${refs.projects.join(',')})`, limit: '10' }) : [],
  ]);
  return { issue: row.data, project: projects[0], members, memberNames: Object.fromEntries(memberLabels.map(member => [member.id, member.name])),
    projectNames: Object.fromEntries(projectLabels.map(project => [project.id, project.name])),
    triagers: coordinator ? [coordinator.id] : members.filter(m => ['admin', 'super_admin'].includes(m.role)).map(m => m.id) };
}

export function qaDeliveryStore(env: Environment, shared: DeliveryStore, canRead: QaDeliveryStore['canRead']): QaDeliveryStore {
  const db = new Database(env);
  return {
    config: shared.config, token: shared.token, binding: shared.binding, canSend: shared.canSend, finish: shared.finish,
    enabled: async () => { const flags = await db.setting('feature_toggles'); return flags?.qa === true && flags?.slackActions === true; },
    state: (issueId, eventType, eventDetail) => loadQaDeliveryState(db, issueId, eventType, eventDetail),
    canRead,
    thread: async (issueId, teamId, channelId) => (await db.rows('qa_slack_links', { select: 'thread_ts', issue_id: `eq.${issueId}`, workspace_id: 'eq.default',
      team_id: `eq.${teamId}`, channel_id: `eq.${channelId}`, order: 'created_at.desc,thread_ts.desc', limit: '1' }))[0]?.thread_ts,
    workflow: () => db.setting('qa_workflow'),
  };
}
