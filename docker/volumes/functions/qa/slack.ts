/** Slack QA UI and intent routing shared by Socket Mode and HTTP transports. */
import { canQaCommand, type QaActor, type QaCommand, type QaDetail, type QaIssue } from './domain.ts';
import { DEFAULT_QA_WORKFLOW, type QaWorkflow } from './workflow.ts';
import { slackProjectOptionGroups, type ProjectGroup } from './projectGroups.ts';
export type SlackBlock = Record<string, unknown>;
type Selection = { value?: string; selected_option?: { value: string }; };
export interface QaSlackPayload {
  type?: string; command?: string; text?: string; trigger_id?: string; callback_id?: string; event_id?: string;
  user_id?: string; team_id?: string; channel_id?: string; user?: { id: string }; team?: { id: string }; channel?: { id: string };
  actions?: Array<{ action_id: string; value?: string }>;
  message?: { text?: string; ts?: string; thread_ts?: string };
  event?: { type?: string; user?: string; channel?: string; text?: string; ts?: string; thread_ts?: string; subtype?: string; bot_id?: string; files?: Array<{name?:string;permalink?:string}> };
  view?: { id: string; callback_id: string; private_metadata?: string; state?: { values?: Record<string, Record<string, Selection>> } };
}
export interface QaSlackActor extends QaActor { team: string; slack_user: string; locale?: string; }
export interface QaSlackSource { team: string; channel: string; thread: string; user: string; issueId?: string; version?: number; intent?: string; }
export interface QaSlackActions {
  enabled(): Promise<boolean>;
  actor(payload: QaSlackPayload): Promise<QaSlackActor>;
  api<T>(actor: QaSlackActor, body: Record<string, unknown>): Promise<T>;
  projects(actor: QaSlackActor, search: string): Promise<ProjectGroup[]>;
  mapped(actor: QaSlackActor, source: QaSlackSource): Promise<string | undefined>;
  publish(actor: QaSlackActor, issue: QaIssue, source: QaSlackSource): Promise<void>;
  sync(actor: QaSlackActor, issue: QaIssue): Promise<void>;
  claimNotice(key: string): Promise<boolean>;
  enqueueEvent(payload: QaSlackPayload): Promise<string>;
  completeEvent(id: string): Promise<void>;
  pendingEvents(): Promise<Array<{ id: string; payload: QaSlackPayload }>>;
  slack(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  reply(payload: QaSlackPayload, text: string): Promise<void>;
  background(work: Promise<unknown>): void;
  link(issue: QaIssue): string;
}
const text = (value: string) => ({ type: 'plain_text', text: value });
const option = (value: string, label: string) => ({ text: text(label.slice(0, 75)), value });
const input = (key: string, label: string, element: SlackBlock, optional = false): SlackBlock => ({ type: 'input', block_id: key, label: text(label), element: { ...element, action_id: key }, optional });
const field = (value = '', multiline = false, max_length = 3000): SlackBlock => ({ type: 'plain_text_input', multiline, max_length, ...(value ? { initial_value: value.slice(0, max_length) } : {}) });
function modal(title: string, blocks: SlackBlock[], source: QaSlackSource): SlackBlock {
  return { type: 'modal', callback_id: 'livo_qa_submit', title: text(title), submit: text('送出'), close: text('取消'), private_metadata: JSON.stringify(source), blocks };
}
export const qaMessageModal = (message: string): SlackBlock => ({ type: 'modal', callback_id: 'livo_qa_result', title: text('LIVO QA'), close: text('關閉'), blocks: [{ type: 'section', text: text(message.slice(0, 3000)) }] });
function sourceOf(p: QaSlackPayload): QaSlackSource {
  if (p.view?.private_metadata) {
    const s = JSON.parse(p.view.private_metadata) as QaSlackSource;
    return { team: s.team || '', channel: s.channel || '', thread: s.thread || '', user: s.user || '', issueId: s.issueId, version: s.version, intent: s.intent };
  }
  return { team: p.team_id || p.team?.id || '', channel: p.channel_id || p.channel?.id || p.event?.channel || '',
    thread: p.message?.thread_ts || p.message?.ts || p.event?.thread_ts || '', user: p.user_id || p.user?.id || p.event?.user || '' };
}
export function isQaSlackPayload(p: QaSlackPayload): boolean {
  return !!(p.command && /^bug(?:\s|$)/i.test(p.text || '')) || p.callback_id === 'livo_qa_new'
    || !!p.view?.callback_id.startsWith('livo_qa_')
    || !!p.actions?.some(action => action.action_id.startsWith('livo_qa_'))
    || p.type === 'event_callback' || p.type === 'block_suggestion' && p.view?.callback_id === 'livo_qa_submit';
}
export function parseQaSlackCommand(raw: string) {
  const rest = raw.trim().replace(/^bug\s*/i, '');
  const match = /^(fix|pass|fail|blocked|deploy|close|reopen|comment|show|link)\s+(\S+)(?:\s+([\s\S]*))?$/i.exec(rest);
  if (match) return { intent: match[1].toLowerCase(), issueId: match[2], value: match[3] || '' };
  return { intent: 'new', issueId: '', value: rest.replace(/^new\s*/i, '') };
}
/** Only bounded, positive phrases trigger a form. Negation and ambiguous prose remain comments. */
export function qaMessageIntent(message: string, issue: QaIssue, actor: QaActor): string | undefined {
  const value = message.trim();
  if (/^(?:FAIL|驗證失敗|驗證不通過|未修好|仍有問題)[。.!！]?$/i.test(value)) return 'fail';
  if (/^(?:PASS|驗證通過|復驗通過|確認已修正)[。.!！]?$/i.test(value)) return 'pass';
  if (/^(?:已修復|已修正|修復完成|已修好|fixed)[。.!！]?$/i.test(value)) {
    if (issue.qaOwnerId === actor.id && issue.assigneeId !== actor.id && issue.state === 'verification') return 'pass';
    if (issue.assigneeId === actor.id && issue.qaOwnerId !== actor.id) return 'fix';
    return 'choose';
  }
  if (/^(?:部署完成|已部署|deployed)[。.!！]?$/i.test(value)) return 'deploy';
  if (/^(?:重新開啟|重開|reopen)[。.!！]?$/i.test(value)) return 'reopen';
}
const stateNames = { new: '待分流', triaged: '待修復', in_progress: '修復中', verification: '驗證階段', closed: '已結案' };
export function qaSlackCard(issue: QaIssue, url: string, workflow: QaWorkflow = DEFAULT_QA_WORKFLOW): SlackBlock[] {
  const button = (intent: string, label: string): SlackBlock => ({ type: 'button', action_id: `livo_qa_${intent}`, text: text(label), value: issue.id });
  const summary = issue.targets.map(target => {
    const latest = issue.runs.filter(run => run.fixCycle === issue.fixCycle && run.targetId === target.id).sort((a, b) => b.sequence - a.sequence)[0];
    return `${target.environment} · ${target.build} · ${!target.deployedAt ? '待部署' : latest?.result?.toUpperCase() || '待驗證'}`;
  }).join('\n');
  return [
    { type: 'header', text: text(`Bug · ${issue.title}`.slice(0, 150)) },
    { type: 'section', text: text(`${workflow.labels[issue.state] || stateNames[issue.state]} · ${issue.severity} · 修復輪次 ${issue.fixCycle}\nID: ${issue.id}${summary ? '\n' + summary : ''}`.slice(0, 3000)) },
    { type: 'actions', elements: issue.state === 'closed' ? [button('reopen', '重新開啟'), { type: 'button', text: text('查看 LIVO'), url }]
      : [button('fix', '回報修復'), button('deploy', '部署完成'), button('pass', '驗證通過'), button('fail', '驗證失敗'), button('close', '結案')] },
    { type: 'actions', elements: [{ type: 'button', text: text('查看 LIVO'), url }, button('comment', '新增留言'), button('new', '新增 Bug')] },
  ];
}
export async function qaRequestId(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return 'qa-slack-' + [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const kindFor = (intent: string): QaCommand['type'] | undefined => ({ fix: 'submit_fix', deploy: 'record_deployment', pass: 'record_verification', fail: 'record_verification', blocked: 'record_verification', close: 'close', reopen: 'reopen' } as Record<string, QaCommand['type']>)[intent];
async function openQaForm(p: QaSlackPayload, d: QaSlackActions, intent: string, issueId: string, draft: string) {
  const opening = await d.slack('views.open', { trigger_id: p.trigger_id, view: qaMessageModal('正在載入 LIVO QA…') });
  const opened = opening.view as { id: string };
  try {
    const actor = await d.actor(p), source = sourceOf(p);
    source.team = actor.team; source.user = actor.slack_user; source.intent = intent;
    if (intent === 'new' && p.actions) source.thread = '';
    let view: SlackBlock;
    if (intent === 'new') {
      if (source.thread && await d.mapped(actor, source)) throw new Error('此訊息串已綁定 Bug，請使用該單操作按鈕，或以 /livo bug new 另開新單。');
      const projects = (await d.projects(actor, '')).flatMap(group => group.projects);
      if (!projects.length) throw new Error('沒有可用的專案，請先在 LIVO 建立專案。');
      let actual = (p.actions ? '' : p.message?.text) || draft;
      if (!p.actions && p.message?.ts && source.channel) {
        const link = await d.slack('chat.getPermalink', { channel: source.channel, message_ts: p.message.ts });
        if (typeof link.permalink === 'string') actual += `\n\nSlack 來源：${link.permalink}`;
      }
      view = modal('新增 QA Bug', [input('project', '專案', { type: 'external_select', min_query_length: 0, initial_option: option(projects[0].id, projects[0].name) }),
        input('title', '問題標題', field(((p.actions ? '' : p.message?.text) || draft).split('\n')[0], false, 200)),
        input('environment', '發現環境', field('Stage', false, 120)), input('version', '發現版本（可未知）', field('', false, 200), true),
        input('actual', '實際問題與來源', field(actual, true)), input('steps', '重現步驟', field('', true), true), input('expected', '預期結果', field('', true), true)], source);
    } else {
      const detail = await d.api<QaDetail>(actor, { action: 'get', id: issueId });
      const issue = detail.issue, command = kindFor(intent);
      if (command && !canQaCommand(issue, actor, command)) throw new Error('目前階段或你的 LIVO 權限不允許這項操作，請開啟 Bug 查看。');
      source.issueId = issue.id; source.version = issue.version;
      const blocks: SlackBlock[] = [{ type: 'section', text: text(issue.title.slice(0, 200)) }];
      if (intent === 'fix') blocks.push(input('note', '修復說明', field(draft, true)), input('build', '修復版本／Commit ID', field('', false, 200)),
        input('environment', '需驗證環境（逗號分隔）', field(issue.observedEnvironment, false, 500)), input('component', '元件', field(issue.component, false, 120), true));
      else if (['pass', 'fail', 'blocked', 'deploy'].includes(intent)) {
        const targets = issue.targets.filter(target => intent === 'deploy' || target.deployedAt);
        if (!targets.length) throw new Error(intent === 'deploy' ? '請先回報修復版本，再回報部署。' : '還沒有可驗證的部署，請先回報部署完成。');
        blocks.push(input('target', '驗證環境與版本', { type: 'static_select', options: targets.map(target => option(target.id, `${target.environment} · ${target.component} · ${target.build}`)) }),
          input('note', intent === 'deploy' ? '部署完成依據' : '驗證結果與說明', field(draft, true), intent === 'pass'));
      } else blocks.push(input('note', intent === 'close' ? '結案說明（檢查所有必要環境通過）' : intent === 'reopen' ? '重開原因' : '留言', field(draft, true), intent === 'close'));
      view = modal(({ fix: '回報修復', deploy: '回報部署', pass: '驗證通過', fail: '驗證失敗', blocked: '驗證受阻', close: 'QA 結案', reopen: '重新開啟 Bug', comment: '留言到 Bug' } as Record<string, string>)[intent] || 'LIVO QA', blocks, source);
    }
    await d.slack('views.update', { view_id: opened.id, view });
  } catch (error) { await d.slack('views.update', { view_id: opened.id, view: qaMessageModal(qaSlackError(error)) }); }
}
export function qaSlackError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = { qa_disabled: 'QA 功能目前關閉，請洽管理員。', qa_forbidden: '你沒有此操作權限，請確認 Bug 的主責與 QA 人員。',
    qa_conflict: 'Bug 已有更新。請重新開啟表單，確認最新版本與環境後再送出。', qa_build_mismatch: '修復版本已改變，請重新開啟表單。',
    qa_verification_required: '尚有必要環境未通過驗證，不能結案。', qa_not_deployed: '此環境尚未回報部署完成。', qa_triage_required: '請先在 LIVO 分流，指定修復者與驗證 QA。',
    qa_member_unavailable: '指定成員無法使用，請重新分派。', qa_required: '請填寫必要欄位。' };
  if (messages[code]) return messages[code];
  return /[\u3400-\u9fff]/.test(code) && code.length < 300 ? code : '操作未完成，請重新開啟表單再試；可在 LIVO 查看目前狀態。';
}
async function processQaSlackEvent(p: QaSlackPayload, id: string, d: QaSlackActions): Promise<void> {
  const event = p.event!;
  const source = sourceOf(p), actor = await d.actor({ ...p, user_id: event.user });
  const issueId = await d.mapped(actor, source);
  if (issueId) {
    const detail = await d.api<QaDetail>(actor, { action: 'get', id: issueId });
    const requestId = await qaRequestId(`${actor.team}:${event.channel}:${event.ts}`);
    const message = event.text!;
    await d.api(actor, { action: 'comment', id: issueId, commandId: requestId, body: message.slice(0, 7800) + `\n[Slack ${event.channel}/${event.ts}]` });
    const intent = qaMessageIntent(message, detail.issue, actor);
    if (intent && await d.claimNotice(requestId)) {
      const choices = intent === 'choose' ? ['fix', 'pass'] : [intent];
      const valid = choices.filter(choice => { const kind = kindFor(choice); return kind && canQaCommand(detail.issue, actor, kind); });
      if (valid.length) await d.slack('chat.postEphemeral', { channel: source.channel, user: actor.slack_user, thread_ts: source.thread,
        text: '已記錄到 LIVO Bug；請補齊本次操作的版本／環境。', blocks: [{ type: 'section', text: text('已記錄到 LIVO Bug。請確認本次操作，版本與環境會寫入同一張單。') },
          { type: 'actions', elements: valid.map(choice => ({ type: 'button', action_id: `livo_qa_${choice}`, value: issueId, text: text(({ fix: '回報修復', pass: '驗證通過', fail: '驗證失敗', deploy: '部署完成', reopen: '重新開啟' } as Record<string, string>)[choice] || choice) })) }] });
    }
  }
  await d.completeEvent(id);
}
export async function drainQaSlackInbox(d: QaSlackActions): Promise<void> {
  if (!await d.enabled()) return;
  for (const item of await d.pendingEvents()) {
    try { await processQaSlackEvent(item.payload, item.id, d); }
    catch { console.error('qa_slack_event_retry_pending'); }
  }
}
export async function handleQaSlack(p: QaSlackPayload, _envelopeId: string, d: QaSlackActions): Promise<Record<string, unknown>> {
  if (!(await d.enabled())) {
    if (p.type === 'event_callback') return {};
    if (p.type === 'block_suggestion') return { options: [] };
    if (p.type === 'view_submission') return { response_action: 'update', view: qaMessageModal('QA 或 Slack 互動功能目前關閉。') };
    d.background(d.reply(p, 'QA 或 Slack 互動功能目前關閉，請洽管理員。').catch(() => {})); return {};
  }
  try {
    if (p.type === 'view_closed') return {};
    if (p.type === 'block_suggestion') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const lookup = (async () => { const actor = await d.actor(p); return d.projects(actor, String((p as unknown as Record<string, unknown>).value || '')); })();
        const groups = await Promise.race([lookup, new Promise<ProjectGroup[]>(resolve => { timer = setTimeout(() => resolve([]), 2200); })]);
        return groups.length ? { option_groups: slackProjectOptionGroups(groups, '未分類') } : { options: [] };
      } finally { if (timer) clearTimeout(timer); }
    }
    if (p.type === 'event_callback') {
      const event = p.event;
      if (!event || event.type !== 'message' || event.bot_id || (event.subtype && event.subtype !== 'file_share') || !event.thread_ts || !event.user) return {};
      const files = (event.files || []).slice(0,20).filter(file => typeof file.permalink === 'string' && /^https:\/\//.test(file.permalink));
      const message = [event.text || '', ...files.map(file => `${file.name || 'Slack 附件'}: ${file.permalink}`)].filter(Boolean).join('\n');
      if (!message.trim()) return {};
      const queuedPayload:QaSlackPayload = { type:'event_callback',event_id:p.event_id,team_id:p.team_id || p.team?.id,
        event:{type:'message',user:event.user,channel:event.channel,ts:event.ts,thread_ts:event.thread_ts,text:message.slice(0,7800)} };
      // Persist before ACK. Failures retain a lease-backed inbox item for retry.
      const id = await d.enqueueEvent(queuedPayload);
      if (id) d.background(processQaSlackEvent(queuedPayload, id, d).catch(() => console.error('qa_slack_event_retry_pending')));
      return {};
    }
    if (p.type === 'view_submission' && p.view) {
      const source = sourceOf(p), values = p.view.state?.values || {};
      const value = (name: string) => values[name]?.[name]?.value ?? values[name]?.[name]?.selected_option?.value ?? '';
      const intent = source.intent || '';
      const required = intent === 'new' ? ['project', 'title', 'environment', 'actual'] : intent === 'fix' ? ['note', 'build', 'environment']
        : ['deploy', 'fail', 'blocked'].includes(intent) ? ['target', 'note'] : intent === 'pass' ? ['target'] : ['reopen', 'comment'].includes(intent) ? ['note'] : [];
      const errors = Object.fromEntries(required.filter(name => !value(name).trim()).map(name => [name, '請填寫此欄位']));
      if (Object.keys(errors).length) return { response_action: 'errors', errors };
      const viewId = p.view.id;
      d.background((async () => {
        let message: string;
        try {
          const actor = await d.actor(p), commandId = await qaRequestId(`${actor.team}:${viewId}`);
          let issue: QaIssue;
          let deliveryFailed = false;
          if (intent === 'new') {
            const existing = source.thread ? await d.mapped(actor, source) : undefined;
            if (existing) issue = (await d.api<QaDetail>(actor, { action: 'get', id: existing })).issue;
            else {
              const issueId = source.thread ? await qaRequestId(`${actor.team}:${source.channel}:${source.thread}:issue`) : commandId;
              issue = await d.api<QaIssue>(actor, { action: 'create', id: issueId, commandId, input: { projectId: value('project'), title: value('title'), actual: value('actual'),
                observedEnvironment: value('environment'), observedVersion: value('version'), steps: value('steps'), expected: value('expected') } });
              try { await d.publish(actor, issue, source); } catch { deliveryFailed = true; }
            }
          } else {
            const detail = await d.api<QaDetail>(actor, { action: 'get', id: source.issueId });
            issue = detail.issue;
            if (intent === 'comment') await d.api(actor, { action: 'comment', id: issue.id, commandId, body: value('note') });
            else {
              let command: QaCommand;
              if (intent === 'fix') command = { type: 'submit_fix', summary: value('note'), targets: value('environment').split(/[,，\n]/).map(environment => environment.trim()).filter(Boolean).map(environment => ({ environment, component: value('component'), build: value('build'), required: true })) };
              else if (intent === 'reopen') command = { type: 'reopen', reason: value('note') };
              else if (intent === 'close') command = { type: 'close', resolution: 'fixed', reason: value('note') };
              else {
                const target = issue.targets.find(item => item.id === value('target'));
                if (!target) throw new Error('qa_build_mismatch');
                command = intent === 'deploy' ? { type: 'record_deployment', targetId: target.id, build: target.build, evidence: value('note') }
                  : { type: 'record_verification', targetId: target.id, build: target.build, result: intent as 'pass' | 'fail' | 'blocked', note: value('note') };
              }
              issue = await d.api<QaIssue>(actor, { action: 'command', id: issue.id, expectedVersion: source.version, commandId, command });
            }
            try { await d.sync(actor, issue); } catch { deliveryFailed = true; }
          }
          message = `已更新 Bug：${issue.title}\n${d.link(issue)}`;
          if (deliveryFailed) message += `\nLIVO 已儲存；Slack 訊息卡暫未同步。可用 /livo bug link ${issue.id} 重新建立關聯。`;
        } catch (error) { message = qaSlackError(error); }
        await d.slack('views.update', { view_id: viewId, view: qaMessageModal(message) }).catch(() => {});
        await d.reply({ ...p, channel_id: source.channel }, message).catch(() => {});
      })());
      return { response_action: 'update', view: qaMessageModal('正在儲存 QA 紀錄，完成後會通知你。') };
    }
    const parsed = p.command ? parseQaSlackCommand(p.text || '') : undefined;
    const action = p.actions?.find(item => item.action_id.startsWith('livo_qa_'));
    const intent = parsed?.intent || action?.action_id.replace('livo_qa_', '') || 'new';
    const issueId = parsed?.issueId || action?.value || '';
    if (intent === 'show') {
      d.background((async () => { const actor = await d.actor(p), detail = await d.api<QaDetail>(actor, { action: 'get', id: issueId });
        await d.reply(p, `${detail.issue.title}\n${d.link(detail.issue)}`); })().catch(error => d.reply(p, qaSlackError(error)))); return {};
    }
    if (intent === 'link') {
      d.background((async () => { const actor = await d.actor(p), issue = (await d.api<QaDetail>(actor, { action: 'get', id: issueId })).issue;
        if (!canQaCommand(issue, actor, 'link_tasks')) throw new Error('qa_forbidden');
        await d.publish(actor, issue, sourceOf(p)); await d.reply(p, '已建立 Bug 操作訊息，請在該訊息串回覆。'); })().catch(error => d.reply(p, qaSlackError(error)))); return {};
    }
    d.background(openQaForm(p, d, intent, issueId, parsed?.value || '').catch(error => d.reply(p, qaSlackError(error)))); return {};
  } catch (error) { if (p.type === 'event_callback') throw error; if (p.type === 'block_suggestion') return { options: [] }; d.background(d.reply(p, qaSlackError(error)).catch(() => {})); return {}; }
}
