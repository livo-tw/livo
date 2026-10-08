import { qaNotificationRecipients, type QaCommand, type QaIssue } from '../qa/domain.ts';
import { qaSlackCard, qaSlackTargetSummary } from '../qa/slack.ts';
import { qaSlackCurrentState } from '../qa/slackWorkspace.ts';
import { parseQaWorkflow } from '../qa/workflow.ts';
import { defaultQaDisplaySettings, type QaDisplaySettings } from '../qa/displaySettings.ts';
import { qaNotificationDetailText, qaPriorityText, qaSeverityText, qaDueDateText } from '../qa/notificationText.ts';
import { activeThread, DeliveryError, escapeSlack, failureResult, matchingChannels, memberAllowed, plainText, slackTransport, type DeliveryStore, type Job, type Row } from './core.ts';

export interface QaDeliveryState { issue: QaIssue; project: Row; triagers: string[]; members: Row[]; memberNames?: Record<string, string>; projectNames?: Record<string, string>; displaySettings?: QaDisplaySettings }
export interface QaDeliveryStore extends Pick<DeliveryStore, 'config' | 'token' | 'binding' | 'canSend' | 'finish'> {
  enabled(): Promise<boolean>;
  state(issueId: string, eventType?: string, eventDetail?: unknown): Promise<QaDeliveryState | undefined>;
  canRead(memberId: string, teamId: string, issueId: string): Promise<boolean>;
  thread(issueId: string, teamId: string, channelId: string): Promise<string | undefined>;
  workflow(): Promise<Row | undefined>;
}
export function qaRouteAllowed(config: Row | undefined, state: QaDeliveryState | undefined, job: Job): boolean {
  if (!state || state.project.is_archived || config?.enabled !== true || config.teamId !== job.team_id ||
      job.task_id !== `qa:${state.issue.id}` || job.payload.issueId !== state.issue.id) return false;
  if (job.target_type === 'member') return memberAllowed(config, job.target_id);
  return job.target_id !== job.payload.sourceChannelId && matchingChannels({ ...config, routes: config.qaRoutes }, state.project).includes(job.target_id);
}
export function qaRecipientResponsible(state: QaDeliveryState, job: Job): boolean {
  const type = job.payload.eventType === 'created' ? 'create' : job.payload.eventType;
  if (type === 'create' && state.issue.state !== 'new') return false;
  const known = ['create', 'comment', 'triage', 'edit', 'update_fields', 'set_state', 'request_handoff', 'accept_handoff', 'resolve_handoff',
    'start_fix', 'link_tasks', 'record_deployment', 'submit_fix', 'record_verification', 'close', 'reopen', 'hold'];
  return known.includes(type) && qaNotificationRecipients(state.issue, type as QaCommand['type'] | 'create' | 'comment', job.payload.actorId, state.triagers).includes(job.target_id);
}
const events: Record<string, string> = { create: '新增 Bug', created: '新增 Bug', comment: '新增留言', triage: '指派責任人', edit: '更新 Bug', update_fields:'更新 Bug 欄位', set_state: '狀態變更',
  submit_fix: '回報修復', record_deployment: '部署紀錄', record_verification: '驗證紀錄', close: '結案', reopen: '重新開啟',
  hold: '記錄卡關', start_fix: '開始修復', link_tasks: '連結任務', request_handoff: '建立交接', accept_handoff: '接收交接', resolve_handoff: '解除交接' };
export function qaNotificationMessage(state: QaDeliveryState, job: Job, appBase: string, workflow?: Row): Row {
  const issue = state.issue, url = `${appBase.replace(/\/$/, '')}/?qa=${encodeURIComponent(issue.id)}`;
  const memberName = (id: string) => {
    const label = state.memberNames && Object.prototype.hasOwnProperty.call(state.memberNames, id) ? state.memberNames[id] : state.members.find(member => member.id === id)?.name;
    return typeof label === 'string' && label.trim() && label !== id ? label : undefined;
  };
  const name = (id: string | null) => String(id ? memberName(id) || '未知成員' : '未指定').slice(0, 50);
  const title = `${job.target_type === 'member' ? '[個人通知] ' : ''}${events[job.payload.eventType] || 'Bug 更新'}`;
  const display = state.displaySettings || defaultQaDisplaySettings();
  const flow = parseQaWorkflow(workflow), currentState = qaSlackCurrentState(issue.state, flow);
  const summary = `*${escapeSlack(currentState)}*\n*通知原因：${title}*\n<${url}|Bug - ${escapeSlack(issue.title.slice(0, 120))}>\n` +
    `專案：${escapeSlack(String(state.project.name).slice(0, 80))}｜操作人：${escapeSlack(name(job.payload.actorId))}\n` +
    `👤 修復：${escapeSlack(name(issue.assigneeId))}｜驗證：${escapeSlack(name(issue.qaOwnerId))}\n` +
    `⚡ 優先級：${qaPriorityText(issue.priority)}${display.showSeverity ? `｜嚴重度：${qaSeverityText(issue.severity)}` : ''}\n` +
    `📅 截止日：${qaDueDateText(issue.dueDate)}｜修復輪次：${issue.fixCycle}`;
  // A queued report can predate the current card. Show a labeled current snapshot rather
  // than trying to split the legacy flattened payload or changing immutable audit data.
  const report = ['create', 'created', 'edit'].includes(job.payload.eventType);
  const section = (value: string) => ({ type: 'section', text: { type: 'mrkdwn', text: value } });
  const bounded = (value: unknown, limit = 900) => {
    const raw = String(value ?? '').trim();
    return escapeSlack(raw.length > limit ? raw.slice(0, limit) + '…' : raw).slice(0, 2800);
  };
  const detailSections: string[] = report ? [
    `*回報內容（目前卡片）*\n環境：${bounded(issue.observedEnvironment, 120) || '未設定'}｜發現版本：${bounded(issue.observedVersion, 200) || '未填寫'}`,
    ...([['實際結果', issue.actual], ['預期結果', issue.expected], ['重現步驟／備註', issue.steps]] as const)
      .filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([label, value]) => `*${label}*\n${bounded(value)}`),
  ] : (() => {
    const readable = qaNotificationDetailText(job.payload.eventType, job.payload.detail, { memberName, fixSnapshot: issue, verificationSnapshot: issue, showSeverity: display.showSeverity,
      stateName: id => Object.prototype.hasOwnProperty.call(flow.labels, id) ? flow.labels[id as keyof typeof flow.labels] || undefined : undefined,
      projectName: id => state.projectNames && Object.prototype.hasOwnProperty.call(state.projectNames, id) ? state.projectNames[id] : state.project.id === id ? state.project.name : undefined,
    }) ?? (['comment', 'hold', 'reopen'].includes(job.payload.eventType) && typeof job.payload.detail === 'string' ? job.payload.detail : plainText(job.payload.detail));
    const detail = bounded(readable, 1500);
    return detail ? [detail] : [];
  })();
  const targets = qaSlackTargetSummary(issue), deployment = targets ? `*修復部署與驗證*\n${bounded(targets, 1500)}` : '';
  const blocks = [section(summary), ...detailSections.map(section), ...(deployment ? [section(deployment)] : []),
    ...qaSlackCard(issue, url, flow, display).slice(3)];
  return { text: [summary, ...detailSections, deployment].filter(Boolean).join('\n\n'), blocks, unfurl_links: false, unfurl_media: false };
}
/** QA shares the durable queue and receipt rules; ordinary task routes are never used. */
export async function deliverQaJob(job: Job, owner: string, store: QaDeliveryStore, appBase: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<string> {
  let result: Row;
  try {
    let state = await store.state(job.payload.issueId, job.payload.eventType, job.payload.detail);
    if (!await store.enabled() || !qaRouteAllowed(await store.config(), state, job)) result = { status: 'skipped', error: 'route_no_longer_allowed' };
    else if (job.target_type === 'member' && !qaRecipientResponsible(state!, job)) result = { status: 'skipped', error: 'recipient_no_longer_responsible' };
    else {
      const token = await store.token();
      if (!token) throw new DeliveryError('slack_not_configured');
      const slack = slackTransport(token, fetcher), auth = await slack('auth.test', {});
      if (auth.team_id !== job.team_id) throw new DeliveryError('slack_workspace_mismatch');
      let channel = job.target_id, recipient: string | undefined;
      if (job.target_type === 'member') {
        recipient = await store.binding(job.target_id, job.team_id);
        if (!recipient) throw new DeliveryError('recipient_not_verified');
        const info = (await slack('users.info', { user: recipient })).user;
        if (!info || info.deleted || info.is_bot || info.is_restricted || info.is_ultra_restricted || info.team_id !== job.team_id) throw new DeliveryError('recipient_unavailable');
        if (!await store.canRead(job.target_id, job.team_id, job.payload.issueId)) throw new DeliveryError('recipient_permission_denied');
        channel = (await slack('conversations.open', { users: recipient })).channel?.id;
        if (!/^D[A-Z0-9]+$/.test(channel || '')) throw new DeliveryError('dm_channel_unavailable');
      }
      const thread = job.target_type === 'channel' ? activeThread(await store.thread(job.payload.issueId, job.team_id, channel), now) : undefined;
      const workflow = await store.workflow();
      if (!await store.canSend(job, owner)) throw new DeliveryError('delivery_lease_lost', false, true);
      state = await store.state(job.payload.issueId, job.payload.eventType, job.payload.detail);
      if (!await store.enabled() || !qaRouteAllowed(await store.config(), state, job)) result = { status: 'skipped', error: 'route_no_longer_allowed' };
      else if (job.target_type === 'member' && !qaRecipientResponsible(state!, job)) result = { status: 'skipped', error: 'recipient_no_longer_responsible' };
      else {
        if (job.target_type === 'member') {
          if (!await store.canRead(job.target_id, job.team_id, job.payload.issueId)) throw new DeliveryError('recipient_permission_denied');
          if (await store.binding(job.target_id, job.team_id) !== recipient) throw new DeliveryError('recipient_not_verified');
        }
        const sent = await slack('chat.postMessage', { channel, ...qaNotificationMessage(state!, job, appBase, workflow), ...(thread ? { thread_ts: thread } : {}) });
        if (!/^\d+\.\d+$/.test(sent.ts || '')) throw new DeliveryError('missing_slack_receipt', false, true);
        result = { status: 'sent', channel, messageTs: sent.ts, threadTs: thread || sent.ts };
      }
    }
  } catch (error) { result = failureResult(error, job.attempts); }
  if (!await store.finish(job, owner, result)) throw new DeliveryError('delivery_lease_lost', false, true);
  return result.status;
}
