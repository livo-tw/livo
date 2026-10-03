import { parseDeploymentEnvironments } from './environments.ts';
import { groupProjectsByLine, type ProductLineOption } from './projectGroups.ts';
import { Database, type Environment } from '../slack-interact/backend.ts';
import type { Actions } from '../slack-interact/handler.ts';
import { createQaService } from './service.ts';
import { qaRequestId, qaSlackCard, type QaSlackActions, type QaSlackActor } from './slack.ts';
import { qaSlackLink, syncQaSlackIssue } from './slackSync.ts';
import { parseQaWorkflow } from './workflow.ts';

export function createQaSlackActions(env: Environment, actions: Actions): QaSlackActions {
  const db = new Database(env);
  let teamPromise: Promise<string> | undefined;
  const adapter: QaSlackActions = {
    enabled: async () => { const flags = await db.setting('feature_toggles'); return flags?.qa === true && flags?.slackActions === true; },
    actor: async payload => await actions.actor(payload) as QaSlackActor,
    api: async <T>(actor: QaSlackActor, body: Record<string, unknown>): Promise<T> => {
      if (!await adapter.enabled()) throw new Error('qa_disabled');
      return await createQaService(env, (actor as QaSlackActor & { jwt: string }).jwt).handle(body) as T;
    },
    environments: async actor => {
      const member = new Database(env, (actor as QaSlackActor & { jwt: string }).jwt);
      const rows = await member.rows('system_settings', { select: 'value', key: 'eq.deployment_environments', limit: '1' });
      const parsed = parseDeploymentEnvironments(rows[0]?.value);
      if (!parsed) throw new Error('qa_invalid_environment');
      return parsed.values;
    },
    projects: async (actor, search, includeArchived = false) => {
      const member = new Database(env, (actor as QaSlackActor & { jwt: string }).jwt);
      const pattern = search.replace(/[\\%_*]/g, character => '\\' + character);
      const [rows, lines] = await Promise.all([
        member.rows('projects', { select: 'id,name,line_id', ...(includeArchived ? {} : {is_archived: 'eq.false'}), order: 'name,id', limit: '100',
          ...(search ? { name: `ilike.%${pattern}%` } : {}) }),
        member.rows('product_lines', { select: 'id,name,icon', order: 'sort_order,id' }),
      ]);
      return groupProjectsByLine(lines as ProductLineOption[], rows.map(project => ({ id: String(project.id), name: String(project.name), lineId: project.line_id as string | null })));
    },
    mapped: async (actor, source) => {
      if (!source.thread || source.team !== actor.team) return undefined;
      return (await db.rows('qa_slack_links', { select: 'issue_id', team_id: `eq.${actor.team}`, channel_id: `eq.${source.channel}`, thread_ts: `eq.${source.thread}`, limit: '1' }))[0]?.issue_id;
    },
    publish: async (actor, issue, source) => {
      let channel = source.channel;
      if (!channel) channel = (await actions.slack('conversations.open', { users: actor.slack_user })).channel.id;
      const existing = source.thread ? await adapter.mapped(actor, { ...source, channel, team: actor.team }) : undefined;
      if (existing && existing !== issue.id) throw new Error('此訊息串已綁定另一張 Bug。');
      if (existing) { await syncQaSlackIssue(env, issue); return; }
      // client_msg_id plus the unique thread constraint make Slack/DB retry recovery deterministic.
      const hash = await qaRequestId(`${actor.team}:${channel}:${source.thread || issue.id}:${issue.id}`);
      const hex = hash.slice(9, 41), clientId = `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
      const workflow = parseQaWorkflow(await db.setting('qa_workflow'));
      const card = await actions.slack('chat.postMessage', { channel, ...(source.thread ? { thread_ts: source.thread } : {}),
        client_msg_id: clientId, text: `Bug · ${issue.title}`, blocks: qaSlackCard(issue, qaSlackLink(env, issue), workflow) });
      // No merge-upsert: a concurrent link may never silently replace another issue.
      await db.request('/rest/v1/qa_slack_links', 'POST', { id: hash, issue_id: issue.id, team_id: actor.team, channel_id: channel,
        thread_ts: source.thread || card.ts, card_ts: card.ts, created_at: new Date().toISOString() }, {}, 'return=representation');
    },
    sync: async (_actor, issue) => syncQaSlackIssue(env, issue),
    claimNotice: async key => { try { await db.request('/rest/v1/qa_slack_receipts', 'POST', { id: key, created_at: new Date().toISOString() }, {}, 'return=representation'); return true; } catch { return false; } },
    enqueueEvent: async (payload: Record<string, any>) => {
      const team = payload.team_id || payload.team?.id;
      const expected = await (teamPromise ??= actions.slack('auth.test', {}).then(result => result.team_id));
      if (!team || !expected || team !== expected) throw new Error('Slack workspace mismatch');
      const channel = payload.event?.channel, thread = payload.event?.thread_ts;
      if (typeof channel !== 'string' || typeof thread !== 'string' || !channel || !thread) return '';
      const link = (await db.rows('qa_slack_links', { select: 'issue_id', workspace_id: 'eq.default',
        team_id: `eq.${expected}`, channel_id: `eq.${channel}`, thread_ts: `eq.${thread}`, limit: '1' }))[0];
      // Ordinary Slack conversations must never enter the retained QA inbox.
      if (!link) return '';
      const eventId = typeof payload.event_id === 'string' ? payload.event_id : JSON.stringify(payload);
      const requestId = await qaRequestId(`inbox:${eventId}`);
      return db.request('/rest/v1/rpc/livo_qa_slack_enqueue', 'POST', { p_id: requestId, p_payload: payload });
    },
    completeEvent: async (requestId: string) => { await db.request('/rest/v1/rpc/livo_qa_slack_complete', 'POST', { p_id: requestId }); },
    pendingEvents: async () => db.request('/rest/v1/rpc/livo_qa_slack_pending', 'POST', {}),
    slack: actions.slack, reply: (p, message) => actions.reply(p, message), background: actions.background,
    link: issue => qaSlackLink(env, issue),
  };
  return adapter;
}
