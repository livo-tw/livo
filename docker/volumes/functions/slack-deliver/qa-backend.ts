import { Database, type Environment } from '../slack-interact/backend.ts';
import { DeliveryError, type DeliveryStore } from './core.ts';
import { type QaDeliveryState, type QaDeliveryStore } from './qa-core.ts';
import { qaNotificationReferences } from '../qa/notificationText.ts';
import { parseQaDisplaySettings } from '../qa/displaySettings.ts';

export async function loadQaDeliveryState(db: Database, issueId: string, eventType?: string, eventDetail?: unknown, actorId?: string): Promise<QaDeliveryState | undefined> {
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
  // Labels include current participants as well as immutable event references.
  // They never join the active member list used for routing or DM authorization.
  const refs = qaNotificationReferences(eventType, eventDetail);
  const issue = row.data;
  const labelIds = [...new Set([...refs.members, issue.assigneeId, issue.qaOwnerId, issue.reporterId, actorId,
    issue.handoff?.nextOwnerId, issue.handoff?.requestedBy, issue.handoff?.acceptedBy, issue.handoff?.resolvedBy]
    .filter((value): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)))];
  const [memberLabels, projectLabels] = await Promise.all([
    labelIds.length ? db.rows('members', { select: 'id,name', id: `in.(${labelIds.join(',')})`, limit: '20' }) : [],
    refs.projects.length ? db.rows('projects', { select: 'id,name', id: `in.(${refs.projects.join(',')})`, limit: '10' }) : [],
  ]);
  const named = new Set([...members, ...memberLabels].map(member => member.id));
  const missing = new Set(labelIds.filter(id => !named.has(id)));
  if (missing.size) {
    // Docker external accounts are instance-scoped, with no workspace column.
    // Only this default-workspace issue's participants and immutable event refs
    // may supply labels; revoked/inactive accounts remain historical people.
    // Real member names take precedence, even for external-looking identifiers.
    const externalLabels = await db.rows('external_qa_accounts', { select: 'id,name', id: `in.(${[...missing].join(',')})`, limit: '20' });
    memberLabels.push(...externalLabels.filter(person => missing.has(person.id)).map(person => ({ id: person.id, name: person.name })));
  }
  const displaySettings = parseQaDisplaySettings(await db.setting('qa_display_settings'));
  return { displaySettings, issue: row.data, project: projects[0], members, memberNames: Object.fromEntries(memberLabels.map(member => [member.id, member.name])),
    projectNames: Object.fromEntries(projectLabels.map(project => [project.id, project.name])),
    triagers: coordinator ? [coordinator.id] : members.filter(m => ['admin', 'super_admin'].includes(m.role)).map(m => m.id) };
}

export function qaDeliveryStore(env: Environment, shared: DeliveryStore, canRead: QaDeliveryStore['canRead']): QaDeliveryStore {
  const db = new Database(env);
  return {
    config: shared.config, token: shared.token, binding: shared.binding, canSend: shared.canSend, finish: shared.finish,
    enabled: async () => { const flags = await db.setting('feature_toggles'); return flags?.qa === true && flags?.slackActions === true; },
    state: (issueId, eventType, eventDetail, actorId) => loadQaDeliveryState(db, issueId, eventType, eventDetail, actorId),
    canRead,
    thread: async (issueId, teamId, channelId) => (await db.rows('qa_slack_links', { select: 'thread_ts', issue_id: `eq.${issueId}`, workspace_id: 'eq.default',
      team_id: `eq.${teamId}`, channel_id: `eq.${channelId}`, order: 'created_at.desc,thread_ts.desc', limit: '1' }))[0]?.thread_ts,
    workflow: () => db.setting('qa_workflow'),
  };
}
