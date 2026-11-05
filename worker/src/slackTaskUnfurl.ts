import { mrkdwnLine } from './slackNotifyCore.ts';
import { matchingChannels } from './slackTaskRoutes.ts';

type Row = Record<string, any>;
export interface TaskUnfurlCard { task: Row; project: Row; status: Row }
export interface TaskUnfurlActions {
  /** A deployment-owned app URL, including /demo on the cloud. Never a request host. */
  appUrl: string;
  actor(payload: Row): Promise<Row | undefined>;
  config(): Promise<Row | undefined>;
  card(actor: Row, task: string): Promise<TaskUnfurlCard | undefined>;
  slack(method: string, body: Row): Promise<Row>;
}
export function isTaskUnfurlPayload(payload: Row): boolean {
  return payload?.type === 'event_callback' && payload.event?.type === 'link_shared';
}

/** Parse locally: neither this function nor its adapters fetch a supplied URL. */
export function taskFromUnfurlUrl(value: unknown, appUrl: string): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  try {
    const base = new URL(appUrl), url = new URL(value);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
      url.origin !== base.origin || url.username || url.password || url.hash) return;
    const path = base.pathname.replace(/\/+$/, '');
    // The self-host legacy /demo link redirects to the same authenticated card.
    const allowed = [path || '/', `${path}/`, ...(path === '' ? ['/demo', '/demo/'] : [])];
    if (!allowed.includes(url.pathname) || url.searchParams.getAll('task').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'task')) return;
    const task = url.searchParams.get('task') || '';
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(task) ? task : undefined;
  } catch { return; }
}

/** link_shared is not permission to publish into its conversation. Fail closed
 * unless the actor can read the current card AND the configured task route
 * permits its current project in this exact channel. Composer and all DMs skip.
 * Repeated chat.unfurl calls update this message's attachment, not a new post. */
export async function handleTaskUnfurl(payload: Row, actions?: TaskUnfurlActions): Promise<Row> {
  if (!actions || !isTaskUnfurlPayload(payload)) return {};
  const event = payload.event, team = payload.team_id;
  if ((event.source !== undefined && event.source !== 'conversations_history') || !/^[CG][A-Z0-9]+$/.test(event.channel || '') ||
    !/^\d{1,20}\.\d{1,10}$/.test(event.message_ts || '') || !/^T[A-Z0-9]+$/.test(team || '') ||
    !/^[UW][A-Z0-9]+$/.test(event.user || '') || !Array.isArray(event.links)) return {};
  const links = event.links.slice(0, 5).map((link: Row) => ({ url: link?.url, task: taskFromUnfurlUrl(link?.url, actions.appUrl) }))
    .filter((link: { url: unknown; task?: string }): link is { url: string; task: string } => typeof link.url === 'string' && !!link.task);
  if (!links.length) return {};
  const config = await actions.config();
  if (config?.enabled !== true || config.teamId !== team || !Array.isArray(config.routes) ||
    !config.routes.some((route: Row) => route?.enabled !== false && route?.channelId === event.channel && (route.projectId || route.lineId))) return {};
  const actor = await actions.actor({ ...payload, user_id: event.user, team_id: team });
  if (!actor || actor.team !== team || actor.slack_user !== event.user) return {};
  const channel = (await actions.slack('conversations.info', { channel: event.channel })).channel;
  if (!channel || channel.id !== event.channel || channel.is_im !== false || channel.is_mpim !== false ||
    !(channel.is_channel === true || channel.is_group === true) || channel.is_member !== true) return {};
  const cards: Array<{ url: string; card: TaskUnfurlCard }> = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    const card = await actions.card(actor, link.task);
    if (!card || !card.task.project_id || card.project.id !== card.task.project_id ||
      card.status.id !== card.task.status_id || !matchingChannels(config, card.project).includes(event.channel)) continue;
    cards.push({ url: link.url, card });
  }
  if (!cards.length) return {};
  // Recheck audience authority after potentially slow actor/card reads.
  const freshConfig = await actions.config();
  if (freshConfig?.enabled !== true || freshConfig.teamId !== team) return {};
  const unfurls: Row = {};
  for (const { url, card } of cards) {
    if (!matchingChannels(freshConfig, card.project).includes(event.channel)) continue;
    const key = mrkdwnLine(card.task.task_key, 80), title = mrkdwnLine(card.task.title, 300);
    unfurls[url] = { blocks: [{ type: 'section', text: { type: 'mrkdwn', verbatim: true,
      text: `*${key ? `${key} · ` : ''}${title}*\n專案：${mrkdwnLine(card.project.name, 100)}　狀態：${mrkdwnLine(card.status.name, 100)}` } }] };
  }
  if (Object.keys(unfurls).length) await actions.slack('chat.unfurl', { channel: event.channel, ts: event.message_ts, unfurls });
  return {};
}
