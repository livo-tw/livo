import { mrkdwnLine } from './slackNotifyCore.ts';
import { matchingChannels } from './slackTaskRoutes.ts';

type Row = Record<string, any>;
export interface TaskUnfurlCard { task: Row; project: Row; status: Row }
export interface QaUnfurlCard {
  issue: Row; project: Row; stateLabel: string;
  assigneeName?: string; qaOwnerName?: string;
  priorityLabel?: string; severityLabel?: string; dueDate?: string | null;
}
export interface TaskUnfurlActions {
  /** A deployment-owned app URL, including /demo on the cloud. Never a request host. */
  appUrl: string;
  actor(payload: Row): Promise<Row | undefined>;
  config(): Promise<Row | undefined>;
  card(actor: Row, task: string): Promise<TaskUnfurlCard | undefined>;
  /** Uses the same actor's canonical QA read; never an administrative issue lookup. */
  qaCard?(actor: Row, issueId: string): Promise<QaUnfurlCard | undefined>;
  slack(method: string, body: Row): Promise<Row>;
}
type RecordReference = { kind: 'task' | 'qa'; id: string };
export function isTaskUnfurlPayload(payload: Row): boolean {
  return payload?.type === 'event_callback' && payload.event?.type === 'link_shared';
}
const OPEN_LINK_ACTION = 'livo_unfurl_open_link';
/** URL buttons only navigate. ACK their signed unfurl interaction without resolving
 * an actor, opening a modal, or producing any message or business command. */
export function isTaskUnfurlOpenPayload(payload: Row): boolean {
  const isAppUnfurl = payload?.is_app_unfurl === true || payload?.container?.is_app_unfurl === true ||
    payload?.app_unfurl?.is_app_unfurl === true;
  return payload?.type === 'block_actions' && isAppUnfurl &&
    payload.container?.type === 'message_attachment' && Array.isArray(payload.actions) &&
    payload.actions.length === 1 && payload.actions[0]?.type === 'button' &&
    payload.actions[0].action_id === OPEN_LINK_ACTION;
}

/** Parse locally: neither this function nor its adapters fetch a supplied URL. */
export function recordFromUnfurlUrl(value: unknown, appUrl: string): RecordReference | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  try {
    const base = new URL(appUrl), url = new URL(value);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
      url.origin !== base.origin || url.username || url.password || url.hash) return;
    const path = base.pathname.replace(/\/+$/, '');
    const allowed = [path || '/', path + '/', ...(path === '' ? ['/demo', '/demo/'] : [])];
    if (!allowed.includes(url.pathname)) return;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 1 || (keys[0] !== 'task' && keys[0] !== 'qa')) return;
    const kind = keys[0], id = url.searchParams.get(kind) || '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)) return;
    return { kind, id };
  } catch { return; }
}
export function taskFromUnfurlUrl(value: unknown, appUrl: string): string | undefined {
  const reference = recordFromUnfurlUrl(value, appUrl);
  return reference?.kind === 'task' ? reference.id : undefined;
}
export function qaFromUnfurlUrl(value: unknown, appUrl: string): string | undefined {
  const reference = recordFromUnfurlUrl(value, appUrl);
  return reference?.kind === 'qa' ? reference.id : undefined;
}
function audience(config: Row | undefined, project: Row, kind: RecordReference['kind']): string[] {
  return matchingChannels({ routes: kind === 'qa' ? config?.qaRoutes : config?.routes }, project);
}
function qaText(card: QaUnfurlCard): string {
  const issue = card.issue;
  const owner = (id: unknown, name: unknown) => typeof name === 'string' && name
    ? mrkdwnLine(name, 100) : id ? '待確認' : '未指派';
  const lines = [
    '*Bug · ' + mrkdwnLine(issue.title, 300) + '*',
    '專案：' + mrkdwnLine(card.project.name, 100) + '　狀態：' + mrkdwnLine(card.stateLabel, 100),
    '修復：' + owner(issue.assigneeId, card.assigneeName) + '　QA：' + owner(issue.qaOwnerId, card.qaOwnerName),
  ];
  if (card.priorityLabel || card.severityLabel) lines.push(
    '優先級：' + mrkdwnLine(card.priorityLabel || '未設定', 100) + '　嚴重度：' + mrkdwnLine(card.severityLabel || '未設定', 100));
  if (card.dueDate) lines.push('截止：' + mrkdwnLine(card.dueDate, 40));
  return lines.join('\n');
}
function previewField(label: string, value: unknown, limit = 100): Row {
  return { type: 'mrkdwn', verbatim: true, text: '*' + label + '*\n' + mrkdwnLine(value, limit) };
}
function ownerLabel(id: unknown, name: unknown): string {
  return typeof name === 'string' && name ? name : id ? '待確認' : '未指派';
}
function previewAttachment(url: string, kind: RecordReference['kind'], title: unknown,
  fields: Row[], fallback: string, taskKey?: unknown): Row {
  // Keep the title in a section (300 characters), not the 150-character header.
  // Plain-text header content must not contain mrkdwn's escaped HTML entities.
  const key = typeof taskKey === 'string'
    ? taskKey.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/gu, ' ').trim().slice(0, 80) : '';
  const isTask = kind === 'task';
  return {
    color: isTask ? '#3B82F6' : '#D97706',
    fallback,
    blocks: [
      { type: 'header', text: { type: 'plain_text', emoji: false,
        text: isTask ? 'LIVO · 任務' + (key ? ' ' + key : '') : 'LIVO · Bug' } },
      { type: 'section', text: { type: 'mrkdwn', verbatim: true, text: '*' + mrkdwnLine(title, 300) + '*' } },
      { type: 'divider' },
      { type: 'section', fields },
      { type: 'actions', elements: [{ type: 'button', action_id: OPEN_LINK_ACTION,
        text: { type: 'plain_text', emoji: false, text: isTask ? '開啟任務' : '開啟 Bug' },
        url: new URL(url).toString(),
        accessibility_label: isTask ? '在 LIVO 開啟任務卡片' : '在 LIVO 開啟 Bug 卡片' }] },
    ],
  };
}
function qaAttachment(url: string, card: QaUnfurlCard): Row {
  const fields = [previewField('專案', card.project.name), previewField('狀態', card.stateLabel),
    previewField('修復負責人', ownerLabel(card.issue.assigneeId, card.assigneeName)),
    previewField('QA 負責人', ownerLabel(card.issue.qaOwnerId, card.qaOwnerName)),
    previewField('優先級', card.priorityLabel || '未設定'), previewField('嚴重度', card.severityLabel || '未設定')];
  if (card.dueDate) fields.push(previewField('截止日', card.dueDate, 40));
  return previewAttachment(url, 'qa', card.issue.title, fields, qaText(card));
}

/** Only the actor's readable card and its kind's approved notification audience
 * may be unfurled. Composer and all DMs skip. Repeated calls update the same
 * message attachment; they never post a new message or DM. */
export async function handleTaskUnfurl(payload: Row, actions?: TaskUnfurlActions): Promise<Row> {
  if (!actions || !isTaskUnfurlPayload(payload)) return {};
  const event = payload.event, team = payload.team_id;
  if ((event.source !== undefined && event.source !== 'conversations_history') || !/^[CG][A-Z0-9]+$/.test(event.channel || '') ||
    !/^\d{1,20}\.\d{1,10}$/.test(event.message_ts || '') || !/^T[A-Z0-9]+$/.test(team || '') ||
    !/^[UW][A-Z0-9]+$/.test(event.user || '') || !Array.isArray(event.links)) return {};
  const links: Array<{ url: string; reference: RecordReference }> = event.links.slice(0, 5).map((link: Row) => ({ url: link?.url, reference: recordFromUnfurlUrl(link?.url, actions.appUrl) }))
    .filter((link: { url: unknown; reference?: RecordReference }): link is { url: string; reference: RecordReference } =>
      typeof link.url === 'string' && !!link.reference);
  if (!links.length) return {};
  const config = await actions.config();
  if (config?.enabled !== true || config.teamId !== team || !links.some(({ reference }) => {
    const routes = reference.kind === 'qa' ? config.qaRoutes : config.routes;
    return Array.isArray(routes) && routes.some((route: Row) => route?.enabled !== false &&
      route?.channelId === event.channel && (route.projectId || route.lineId));
  })) return {};
  const actor = await actions.actor({ ...payload, user_id: event.user, team_id: team });
  if (!actor || actor.team !== team || actor.slack_user !== event.user) return {};
  const channel = (await actions.slack('conversations.info', { channel: event.channel })).channel;
  if (!channel || channel.id !== event.channel || channel.is_im !== false || channel.is_mpim !== false ||
    !(channel.is_channel === true || channel.is_group === true) || channel.is_member !== true) return {};
  const cards: Array<{ url: string; kind: RecordReference['kind']; project: Row; attachment: Row }> = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    if (link.reference.kind === 'qa') {
      const card = await actions.qaCard?.(actor, link.reference.id);
      if (!card || !card.issue?.projectId || card.project.id !== card.issue.projectId ||
        card.issue.id !== link.reference.id || !card.stateLabel || !audience(config, card.project, 'qa').includes(event.channel)) continue;
      cards.push({ url: link.url, kind: 'qa', project: card.project, attachment: qaAttachment(link.url, card) });
    } else {
      const card = await actions.card(actor, link.reference.id);
      if (!card || !card.task.project_id || card.project.id !== card.task.project_id ||
        card.status.id !== card.task.status_id || !audience(config, card.project, 'task').includes(event.channel)) continue;
      const key = mrkdwnLine(card.task.task_key, 80), title = mrkdwnLine(card.task.title, 300);
      const fallback = '*' + (key ? key + ' · ' : '') + title + '*\n專案：' + mrkdwnLine(card.project.name, 100) +
        '　狀態：' + mrkdwnLine(card.status.name, 100);
      cards.push({ url: link.url, kind: 'task', project: card.project,
        attachment: previewAttachment(link.url, 'task', card.task.title,
          [previewField('專案', card.project.name), previewField('狀態', card.status.name)], fallback, card.task.task_key) });
    }
  }
  if (!cards.length) return {};
  const freshConfig = await actions.config();
  if (freshConfig?.enabled !== true || freshConfig.teamId !== team) return {};
  const unfurls: Row = {};
  for (const { url, kind, project, attachment } of cards) {
    if (!audience(freshConfig, project, kind).includes(event.channel)) continue;
    unfurls[url] = attachment;
  }
  if (Object.keys(unfurls).length) await actions.slack('chat.unfurl', { channel: event.channel, ts: event.message_ts, unfurls });
  return {};
}
