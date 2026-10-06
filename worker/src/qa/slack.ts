import { handleQaCoordinationSlack } from './slackHandoff.ts';
/** Slack QA UI and intent routing shared by Socket Mode and HTTP transports. */
import { canQaCommand, isHistoricalQaPass, isQaTerminal, type QaActor, type QaCommand, type QaDetail, type QaIssue } from './domain.ts';
import { DEFAULT_QA_WORKFLOW, parseQaWorkflow, type QaWorkflow } from './workflow.ts';
import { defaultObservedEnvironment } from './environments.ts';
import { slackProjectOptionGroups, type ProjectGroup } from './projectGroups.ts';
import { handleQaWorkspace, parseQaWorkspaceCommand, qaLatestDetailView, qaSlackCurrentState, qaSlackOperationAllowed } from './slackWorkspace.ts';
export type SlackBlock = Record<string, unknown>;
type Selection = { value?: string; selected_option?: { value: string }; selected_options?: Array<{value:string}>; };
export interface QaSlackPayload {
  type?: string; command?: string; text?: string; trigger_id?: string; callback_id?: string; event_id?: string; action_id?: string; value?: string;
  user_id?: string; team_id?: string; channel_id?: string; user?: { id: string }; team?: { id: string }; channel?: { id: string };
  actions?: Array<{ action_id: string; value?: string }>;
  message?: { text?: string; ts?: string; thread_ts?: string };
  event?: { type?: string; user?: string; channel?: string; text?: string; ts?: string; thread_ts?: string; subtype?: string; bot_id?: string; files?: Array<{name?:string;permalink?:string}> };
  view?: { id: string; hash?: string; callback_id: string; private_metadata?: string; state?: { values?: Record<string, Record<string, Selection>> } };
}
export interface QaSlackActor extends QaActor { team: string; slack_user: string; locale?: string; }
export interface QaSlackSource { team: string; channel: string; thread: string; user: string; issueId?: string; version?: number; intent?: string; projectId?: string; }
export interface QaSlackActions {
  enabled(): Promise<boolean>;
  actor(payload: QaSlackPayload): Promise<QaSlackActor>;
  api<T>(actor: QaSlackActor, body: Record<string, unknown>): Promise<T>;
  projects(actor: QaSlackActor, search: string, includeArchived?: boolean): Promise<ProjectGroup[]>;
  environments(actor: QaSlackActor): Promise<string[]>;
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
    return { team: s.team || '', channel: s.channel || '', thread: s.thread || '', user: s.user || '', issueId: s.issueId, version: s.version, intent: s.intent, projectId:s.projectId };
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
  const workspace = parseQaWorkspaceCommand(raw);
  if (workspace) return workspace;
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
const QA_SEVERITY_NAMES: Record<string, string> = { untriaged: '待判定', low: '低', medium: '中', high: '高' };
export function qaSlackCard(issue: QaIssue, url: string, workflow: QaWorkflow = DEFAULT_QA_WORKFLOW): SlackBlock[] {
  const button = (intent: string, label: string): SlackBlock => ({ type: 'button', action_id: `livo_qa_${intent}`, text: text(label), value: issue.id });
  const summary = issue.targets.map(target => {
    const latest = issue.runs.filter(run => run.fixCycle === issue.fixCycle && run.targetId === target.id).sort((a, b) => b.sequence - a.sequence)[0];
    return `${target.environment} · ${target.build || '版本未填'} · ${!target.deployedAt ? '待部署' : latest?.result?.toUpperCase() || '待驗證'}`;
  }).join('\n');
  // The card is shared by the whole channel, so it offers only the steps this stage allows;
  // each button still checks the person's own permission when pressed.
  const steps: SlackBlock[] = isQaTerminal(issue.state) ? [button('reopen', '重新開啟')]
    : issue.state === 'new' ? issue.assigneeId && issue.qaOwnerId ? [button('fix','回報修復')] : [button('triage','指定責任人')]
    : issue.state === 'verification' ? [...(issue.targets.some(target => !target.deployedAt) ? [button('deploy', '部署完成')] : []), button('pass', '驗證通過'), button('fail', '驗證失敗')]
    : issue.state === 'verified' ? [button('close', '結案')]
    : [button('fix', '回報修復')];
  return [
    { type:'section',text:{type:'mrkdwn',text:`*${qaSlackCurrentState(issue.state,workflow).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}*`} },
    { type: 'header', text: text(`Bug · ${issue.title}`.slice(0, 150)) },
    { type: 'section', text: text(`嚴重度：${QA_SEVERITY_NAMES[issue.severity] || issue.severity} · 修復輪次 ${issue.fixCycle}\nID: ${issue.id}${summary ? '\n' + summary : ''}`.slice(0, 3000)) },
    { type: 'actions', elements: steps },
    { type: 'actions', elements: [{ type: 'button', text: text('查看 LIVO'), url }, button('comment', '新增留言'), button('new', '新增 Bug')] },
  ];
}
export async function qaRequestId(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return 'qa-slack-' + [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const kindFor = (intent: string): QaCommand['type'] | undefined => ({ fix: 'submit_fix', deploy: 'record_deployment', pass: 'record_verification', fail: 'record_verification', blocked: 'record_verification', close: 'close', reopen: 'reopen' } as Record<string, QaCommand['type']>)[intent];
function staleActionNotice(issue:QaIssue,actor:QaSlackActor):string {
  const terminal=isQaTerminal(issue.state),responsible=actor.id===issue.assigneeId||actor.id===issue.qaOwnerId;
  return (terminal ? '這張 Bug 已結案或不處理，舊通知的操作已不適用。' : !responsible ? '這張 Bug 的責任人已有變更，或你目前不是此操作的負責人。' : '這張 Bug 已進入其他階段，此操作目前不適用。')+' 以下顯示最新 Bug 與你目前可使用的操作。';
}
async function openQaForm(p: QaSlackPayload, d: QaSlackActions, intent: string, issueId: string, draft: string) {
  const opening = await d.slack(p.view ? 'views.update' : 'views.open', { ...(p.view ? {view_id:p.view.id} : {trigger_id:p.trigger_id}), view: qaMessageModal('正在載入 LIVO QA…') });
  const opened = p.view || opening.view as { id: string };
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
      const environments = await d.environments(actor);
      if (!environments.length) throw new Error('qa_invalid_environment');
      const observed = defaultObservedEnvironment(environments)!;
      source.projectId=projects[0].id;
      view = modal('新增 QA Bug', [input('project', '專案', { type: 'external_select', min_query_length: 0, initial_option: option(projects[0].id, projects[0].name) }),
        input('assigneeId','修復負責人（可稍後指派）',{type:'external_select',min_query_length:0,placeholder:text('搜尋成員')},true),
        input('qaOwnerId','驗證 QA（可稍後指派）',{type:'external_select',min_query_length:0,placeholder:text('搜尋成員')},true),
        input('severity','嚴重度',{type:'static_select',options:['low','medium','high'].map(value=>option(value,QA_SEVERITY_NAMES[value])),initial_option:option('medium','中')}),
        input('title', '問題標題', field(((p.actions ? '' : p.message?.text) || draft).split('\n')[0], false, 200)),
        input('environment', '發現環境', { type: 'static_select', options: environments.map(env => option(env, env)), initial_option: option(observed, observed) }), input('version', '發現版本（可未知）', field('', false, 200), true),
        input('actual', '實際問題與來源', field(actual, true)), input('steps', '重現步驟', field('', true), true), input('expected', '預期結果', field('', true), true)], source);
    } else {
      const detail = await d.api<QaDetail>(actor, { action: 'get', id: issueId });
      const issue = detail.issue, command = kindFor(intent);
      const scoped={...actor,qaCoordinatorProjectIds:detail.coordination?.coordinatorId===actor.id?[issue.projectId]:[]};
      if (command && !qaSlackOperationAllowed(issue, scoped, command)) {
        const workflow=parseQaWorkflow(await d.api<QaWorkflow>(actor,{action:'get_workflow'}));
        view=qaLatestDetailView(detail,actor,d,workflow,staleActionNotice(issue,actor));
        await d.slack('views.update',{view_id:opened.id,view});return;
      }
      source.issueId = issue.id; source.version = issue.version;
      const blocks: SlackBlock[] = [{ type: 'section', text: text(issue.title.slice(0, 200)) }];
      if (intent === 'fix') {
        const environments = await d.environments(actor);
        if (!environments.length) throw new Error('qa_invalid_environment');
        const initial = environments.filter(env => issue.targets.some(target => target.environment === env) || !issue.targets.length && env === issue.observedEnvironment);
        blocks.push(input('note', '修復說明（選填）', field(draft, true),true), input('build', '修復版本／Commit ID（選填）', field('', false, 200),true),
          input('environment', '需驗證環境', { type: 'multi_static_select', options: environments.map(env => option(env, env)), ...(initial.length ? { initial_options: initial.map(env => option(env, env)) } : {}) }),
          input('component', '元件', field(issue.component, false, 120), true));
      }
      else if (['pass', 'fail', 'blocked', 'deploy'].includes(intent)) {
        const targets = issue.targets.filter(target => intent === 'deploy' || target.deployedAt);
        if (!targets.length) throw new Error(intent === 'deploy' ? '請先回報修復版本，再回報部署。' : '還沒有可驗證的部署，請先回報部署完成。');
        blocks.push(input('target', '驗證環境與版本', { type: 'static_select', options: targets.map(target => option(target.id, `${target.environment} · ${target.component} · ${target.build || '版本未填'}`)) }),
          input('note', intent === 'deploy' ? '部署完成依據（選填）' : '驗證結果與說明（選填）', field(draft, true),true));
      } else if (intent === 'close' && isHistoricalQaPass(issue)) {
        blocks.push(input('historical_pass', '確認歷史 PASS 證據', { type:'checkboxes', options:[option('acknowledge', '我已檢視來源 PASS 證據並確認正式結案；這不代表本次重新驗證。')] }),
          input('note', '正式結案原因（依歷史 PASS 證據）', field(draft, true)));
      } else blocks.push(input('note', intent === 'close' ? '結案說明（檢查所有必要環境通過）' : intent === 'reopen' ? '重開原因' : '留言', field(draft, true), intent === 'close'));
      view = modal(({ fix: '回報修復', deploy: '回報部署', pass: '驗證通過', fail: '驗證失敗', blocked: '驗證受阻', close: 'QA 結案', reopen: '重新開啟 Bug', comment: '留言到 Bug' } as Record<string, string>)[intent] || 'LIVO QA', blocks, source);
    }
    await d.slack('views.update', { view_id: opened.id, view });
  } catch (error) {
    const message=qaSlackError(error);
    try {await d.slack('views.update',{view_id:opened.id,view:qaMessageModal(message)});}
    catch {await d.reply(p,message).catch(()=>{});}
  }
}
export function qaSlackError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = { qa_disabled: 'QA 功能目前關閉，請洽管理員。', qa_forbidden: '你沒有此操作權限，請確認 Bug 的主責與 QA 人員。',
    qa_conflict: 'Bug 已有更新。請重新開啟表單，確認最新版本與環境後再送出。', qa_build_mismatch: '修復版本已改變，請重新開啟表單。',
    qa_verification_required: '尚有必要環境未通過驗證，不能結案。', qa_not_deployed: '此環境尚未回報部署完成。', qa_triage_required: '請先在 LIVO 分流，指定修復者與驗證 QA。',
    qa_invalid_environment: '部署環境清單已更新，請重新開啟表單並選擇可用環境。', qa_member_unavailable: '指定成員無法使用，請重新分派。', qa_required: '請填寫必要欄位。',
    slack_link_disabled: '你已在 LIVO 解除 Slack 連結，LIVO 不會用這個 Slack 帳號替你操作。要恢復，請到 LIVO 的「我的設定 → Slack 連結」重新允許。' };
  if (messages[code]) return messages[code];
  return /[\u3400-\u9fff]/.test(code) && code.length < 300 ? code : '操作未完成，請重新開啟表單再試；可在 LIVO 查看目前狀態。';
}
/**
 * An inbox event that no retry can complete: its author has no (active) LIVO
 * account, may no longer act on the bug, or the bug is gone. Outages retry.
 */
export function isPermanentQaEventError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as Error & { code?: unknown }).code === 'no_account'
    || ['qa_forbidden', 'qa_member_inactive', 'qa_issue_not_found', 'qa_not_found', 'slack_link_disabled'].includes(error.message);
}
async function processQaSlackEvent(p: QaSlackPayload, id: string, d: QaSlackActions): Promise<void> {
  try { await recordQaSlackEvent(p, id, d); }
  catch (error) {
    if (!isPermanentQaEventError(error)) throw error;
    await d.completeEvent(id);
  }
}
async function recordQaSlackEvent(p: QaSlackPayload, id: string, d: QaSlackActions): Promise<void> {
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
    const coordination = await handleQaCoordinationSlack(p,d);
    if (coordination !== undefined) return coordination;
    const workspace = await handleQaWorkspace(p,d);
    if (workspace !== undefined) return workspace;
    if (p.type === 'view_closed') return {};
    if (p.type === 'block_suggestion') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const lookup = (async () => {
          const actor=await d.actor(p), search=String(p.value || '').slice(0,100);
          if (p.action_id==='assigneeId'||p.action_id==='qaOwnerId') {
            const source=sourceOf(p),projectId=p.view?.state?.values?.project?.project?.selected_option?.value || source.projectId;
            if (!projectId) return {options:[]};
            const result=await d.api<{members:Array<{id:string;name:string}>}>(actor,{action:'members',projectId,search,offset:0});
            return {options:result.members.slice(0,100).map(member=>option(member.id,member.name))};
          }
          const groups=await d.projects(actor,search);
          return groups.length ? {option_groups:slackProjectOptionGroups(groups,'未分類')} : {options:[]};
        })();
        return await Promise.race([lookup,new Promise<{options:SlackBlock[]}>(resolve=>{timer=setTimeout(()=>resolve({options:[]}),2200);})]);
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
      const historicalForm = intent === 'close' && Object.prototype.hasOwnProperty.call(values, 'historical_pass');
      const acknowledgement = values.historical_pass?.historical_pass?.selected_options;
      const acknowledgeHistoricalPass = acknowledgement?.length === 1 && acknowledgement[0]?.value === 'acknowledge';
      const chosenEnvironments = values.environment?.environment?.selected_options?.map(item => item.value)
        ?? (intent === 'fix' ? value('environment').split(/[,，\n]/).map(item => item.trim()).filter(Boolean) : [value('environment')]);
      const required = intent === 'new' ? ['project', 'title', 'environment', 'actual'] : intent === 'fix' ? ['environment']
        : ['deploy', 'fail', 'blocked','pass'].includes(intent) ? ['target'] : ['reopen', 'comment'].includes(intent) || historicalForm ? ['note'] : [];
      const errors = Object.fromEntries(required.filter(name => name === 'environment' ? !chosenEnvironments.length || chosenEnvironments.some(env => !env.trim()) : !value(name).trim()).map(name => [name, '請填寫此欄位']));
      if (historicalForm && !acknowledgeHistoricalPass) errors.historical_pass = '請先檢視來源 PASS 證據，再勾選正式結案確認。';
      if (Object.keys(errors).length) return { response_action: 'errors', errors };
      const viewId = p.view.id;
      d.background((async () => {
        let message: string;
        let created:QaIssue|undefined;
        let liveActor:QaSlackActor|undefined,completionView:SlackBlock|undefined;
        try {
          // Slack preserves a submission hash on retry, but replaces it when a
          // new form reuses the same modal. Distinct forms need distinct IDs.
          const actor = await d.actor(p), commandId = await qaRequestId(`${actor.team}:${viewId}:${p.view?.hash || 'submission'}`);
          liveActor=actor;
          if (intent === 'new' || intent === 'fix') {
            const activeEnvironments = await d.environments(actor);
            if (!chosenEnvironments.length || chosenEnvironments.some(env => !activeEnvironments.includes(env))) throw new Error('qa_invalid_environment');
          }
          let issue: QaIssue;
          let deliveryFailed = false;
          if (intent === 'new') {
            const existing = source.thread ? await d.mapped(actor, source) : undefined;
            if (existing) issue = (await d.api<QaDetail>(actor, { action: 'get', id: existing })).issue;
            else {
              const issueId = source.thread ? await qaRequestId(`${actor.team}:${source.channel}:${source.thread}:issue`) : commandId;
              issue = await d.api<QaIssue>(actor, { action: 'create', id: issueId, commandId, input: { projectId: value('project'), title: value('title'), actual: value('actual'),
                observedEnvironment: value('environment'), observedVersion: value('version'), steps: value('steps'), expected: value('expected'),severity:value('severity')||'medium' } });
              created=issue;
              if (value('assigneeId') || value('qaOwnerId')) {
                issue=await d.api<QaIssue>(actor,{action:'command',id:issue.id,expectedVersion:issue.version,commandId:await qaRequestId(`${commandId}:initial_fields`),
                  command:{type:'update_fields',projectId:issue.projectId,assigneeId:value('assigneeId')||null,qaOwnerId:value('qaOwnerId')||null,severity:value('severity')||'medium',priority:issue.priority,dueDate:issue.dueDate}});
              }
              created=undefined;
              try { await d.publish(actor, issue, source); } catch { deliveryFailed = true; }
            }
          } else {
            const detail = await d.api<QaDetail>(actor, { action: 'get', id: source.issueId });
            issue = detail.issue;
            if (intent === 'comment') await d.api(actor, { action: 'comment', id: issue.id, commandId, body: value('note') });
            else {
              let command: QaCommand;
              if (intent === 'fix') command = { type: 'submit_fix', summary: value('note'), targets: chosenEnvironments.map(environment => ({ environment, component: value('component'), build: value('build'), required: true })) };
              else if (intent === 'reopen') command = { type: 'reopen', reason: value('note') };
              else if (intent === 'close') {
                const historical = isHistoricalQaPass(issue);
                // Modal state is advisory. Recheck the trusted aggregate after auth,
                // and leave actor permission / expectedVersion enforcement to the API.
                if (historical && (!acknowledgeHistoricalPass || !value('note').trim())) throw new Error('歷史 PASS 必須明確勾選確認並填寫正式結案原因，請重新開啟結案表單。');
                if (!historical && (historicalForm || acknowledgeHistoricalPass)) throw new Error('Bug 的歷史 PASS 狀態已有變更，請重新開啟結案表單。');
                command = { type: 'close', resolution: 'fixed', reason: value('note'), ...(historical ? {acknowledgeHistoricalPass:true} : {}) };
              }
              else {
                const target = issue.targets.find(item => item.id === value('target'));
                if (!target) throw new Error('qa_build_mismatch');
                command = intent === 'deploy' ? { type: 'record_deployment', targetId: target.id, build: target.build, evidence: value('note') }
                  : { type: 'record_verification', targetId: target.id, build: target.build, result: intent as 'pass' | 'fail' | 'blocked', note: value('note') };
              }
              const scoped={...actor,qaCoordinatorProjectIds:detail.coordination?.coordinatorId===actor.id?[issue.projectId]:[]};
              if(!qaSlackOperationAllowed(issue,scoped,command.type))throw new Error('qa_action_stale');
              issue = await d.api<QaIssue>(actor, { action: 'command', id: issue.id, expectedVersion: source.version, commandId, command });
            }
            try { await d.sync(actor, issue); } catch { deliveryFailed = true; }
          }
          message = `已更新 Bug。\n${d.link(issue)}`;
          if (deliveryFailed) message += `\nLIVO 已儲存；Slack 訊息卡暫未同步。可用 /livo bug link ${issue.id} 重新建立關聯。`;
        } catch (error) {
          message = created ? `Bug 已建立。\n${d.link(created)}\n責任人設定尚未確認，請在最新 Bug 中確認或補設；同一表單重送不會另建 Bug。\n${qaSlackError(error)}` : qaSlackError(error);
          if(created&&liveActor) {
            try {
              const detail=await d.api<QaDetail>(liveActor,{action:'get',id:created.id});
              const workflow=parseQaWorkflow(await d.api<QaWorkflow>(liveActor,{action:'get_workflow'}));
              completionView=qaLatestDetailView(detail,liveActor,d,workflow,message);
            }catch { /* Keep the committed-create receipt even if the fresh read is unavailable. */ }
          }
          if(liveActor&&source.issueId&&intent!=='new'&&error instanceof Error&&['qa_action_stale','qa_forbidden','qa_conflict'].includes(error.message)) {
            try {
              const detail=await d.api<QaDetail>(liveActor,{action:'get',id:source.issueId});
              const workflow=parseQaWorkflow(await d.api<QaWorkflow>(liveActor,{action:'get_workflow'}));
              message=error.message==='qa_conflict' ? `Bug 已有更新，未重送舊操作。請依最新狀態重新操作。\n${d.link(detail.issue)}` : `${staleActionNotice(detail.issue,liveActor)}\n${d.link(detail.issue)}`;
              completionView=qaLatestDetailView(detail,liveActor,d,workflow,message);
            }catch { /* A fresh denied read must not disclose the earlier snapshot. */ }
          }
        }
        await d.slack('views.update', { view_id: viewId, view: completionView||qaMessageModal(message) }).catch(() => {});
        await d.reply({ ...p, channel_id: source.channel }, message).catch(() => {});
      })());
      return { response_action: 'update', view: qaMessageModal('正在儲存 QA 紀錄。關閉視窗不會取消，完成結果會回到原操作位置，僅你可見。') };
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
