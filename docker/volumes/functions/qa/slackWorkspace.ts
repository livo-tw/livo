import { qaCoordinationButtons, qaHandoffBlocks } from './slackHandoff.ts';
/** Private, read-only QA browsing shared by HTTP and Socket Mode. */
import { canQaCommand, QA_STATES, type QaDetail, type QaIssue, type QaListInput, type QaListResult, type QaState } from './domain.ts';
import { getQaStateLabel, parseQaWorkflow, type QaWorkflow } from './workflow.ts';
import { slackProjectOptionGroups } from './projectGroups.ts';
import type { QaSlackActions, QaSlackActor, QaSlackPayload, SlackBlock } from './slack.ts';

type Mode = 'list' | 'search' | 'my' | 'triage';
interface Query { mode: Mode; search: string; state: QaState | 'active' | 'all'; mine: NonNullable<QaListInput['mine']> | 'all'; projectId: string; projectLabel: string; offset: number; }
const PAGE_SIZE = 10;
const CALLBACK = 'livo_qa_workspace';
const PREFIX = CALLBACK + '_';
const copy = {
  'zh-TW': { title:'LIVO QA', loading:'正在載入 QA…', close:'關閉', apply:'查詢', search:'搜尋標題', project:'專案（含封存）', chooseProject:'全部專案；輸入名稱篩選', ungrouped:'未分類', state:'狀態', mine:'與我的關係', all:'全部', active:'尚未結案', assigned:'我負責修復', testing:'我負責驗證', reported:'我回報的', list:'Bug 清單', searchMode:'搜尋 Bug', my:'我的 Bug', triage:'待分流', empty:'沒有符合條件的 Bug。', count:'筆結果', page:'目前顯示', previous:'上一頁', next:'下一頁', refresh:'重新整理', detail:'查看詳情', back:'回到清單', web:'在 LIVO 開啟', env:'回報環境', build:'回報版本', actual:'實際結果', steps:'重現步驟', expected:'預期結果', repair:'修復摘要', hold:'暫停原因', unassigned:'尚未指派', due:'期限', readOnly:'開啟 Bug 詳情後，可依權限分流及指定修復者與驗證 QA。', error:'無法讀取 QA。請確認 LIVO 帳號與權限，再重新開啟。', invalid:'查詢條件已失效，請重新開啟 QA 清單。', fix:'回報修復', deploy:'部署完成', pass:'驗證通過', fail:'驗證失敗', blocked:'驗證受阻', closeIssue:'結案', reopen:'重新開啟', comment:'新增留言', severity:{untriaged:'待分級',low:'低',medium:'中',high:'高'}, states:{new:'新回報',triaged:'已分流',in_progress:'修復中',verification:'待部署／驗證',verified:'驗證通過待結案',failed:'驗證未通過',closed:'完成',dismissed:'不處理'} },
  'zh-CN': { title:'LIVO QA', loading:'正在加载 QA…', close:'关闭', apply:'查询', search:'搜索标题', project:'项目（含归档）', chooseProject:'全部项目；输入名称筛选', ungrouped:'未分类', state:'状态', mine:'与我的关系', all:'全部', active:'尚未结案', assigned:'我负责修复', testing:'我负责验证', reported:'我报告的', list:'Bug 列表', searchMode:'搜索 Bug', my:'我的 Bug', triage:'待分流', empty:'没有符合条件的 Bug。', count:'条结果', page:'当前显示', previous:'上一页', next:'下一页', refresh:'刷新', detail:'查看详情', back:'返回列表', web:'在 LIVO 打开', env:'报告环境', build:'报告版本', actual:'实际结果', steps:'重现步骤', expected:'预期结果', repair:'修复摘要', hold:'暂停原因', unassigned:'尚未指派', due:'截止日期', readOnly:'打开 Bug 详情后，可依权限分流及指定修复者与验证 QA。', error:'无法读取 QA。请确认 LIVO 账号与权限，再重新打开。', invalid:'查询条件已失效，请重新打开 QA 列表。', fix:'报告修复', deploy:'部署完成', pass:'验证通过', fail:'验证失败', blocked:'验证受阻', closeIssue:'结案', reopen:'重新打开', comment:'添加评论', severity:{untriaged:'待分级',low:'低',medium:'中',high:'高'}, states:{new:'新报告',triaged:'已分流',in_progress:'修复中',verification:'待部署／验证',verified:'验证通过待结案',failed:'验证未通过',closed:'完成',dismissed:'不处理'} },
  en: { title:'LIVO QA', loading:'Loading QA…', close:'Close', apply:'Search', search:'Search titles', project:'Project (including archived)', chooseProject:'All projects; type a name to filter', ungrouped:'Ungrouped', state:'State', mine:'My involvement', all:'All', active:'Open', assigned:'Assigned to me', testing:'For me to verify', reported:'Reported by me', list:'Bug list', searchMode:'Search bugs', my:'My bugs', triage:'Needs triage', empty:'No bugs match these filters.', count:'results', page:'Showing', previous:'Previous', next:'Next', refresh:'Refresh', detail:'View details', back:'Back to list', web:'Open in LIVO', env:'Reported environment', build:'Reported build', actual:'Actual result', steps:'Steps to reproduce', expected:'Expected result', repair:'Fix summary', hold:'Hold reason', unassigned:'Unassigned', due:'Due', readOnly:'Open a bug to triage and assign its developer and QA owner when authorized.', error:'QA could not be loaded. Check your LIVO account and permissions, then reopen.', invalid:'These filters are no longer valid. Reopen the QA list.', fix:'Report fix', deploy:'Deployed', pass:'Verify PASS', fail:'Verify FAIL', blocked:'Verification blocked', closeIssue:'Close issue', reopen:'Reopen', comment:'Add comment', severity:{untriaged:'Untriaged',low:'Low',medium:'Medium',high:'High'}, states:{new:'New',triaged:'Triaged',in_progress:'In progress',verification:'Deployment / verification',verified:'Verified, awaiting closure',failed:'Verification failed',closed:'Closed',dismissed:'Dismissed'} },
};
type Copy = typeof copy.en;
const words = (locale?: string): Copy => /^zh[-_](?:CN|SG|Hans)/i.test(locale || '') ? copy['zh-CN'] : /^zh/i.test(locale || '') || !locale ? copy['zh-TW'] : copy.en;
const plain = (text: string) => ({ type:'plain_text', text });
const option = (value: string, label: string) => ({ value, text:plain(label.slice(0,75)) });
const button = (id: string, label: string, value = ''): SlackBlock => ({ type:'button', action_id:PREFIX + id, text:plain(label), value:value || id });
const section = (value: string): SlackBlock => ({ type:'section', text:plain(value.slice(0,3000)) });
const input = (id: string, label: string, element: SlackBlock): SlackBlock => ({ type:'input', block_id:id, label:plain(label), optional:true, element:{...element,action_id:id} });
const initial = (mode: Mode, search = ''): Query => ({ mode, search:search.slice(0,100), state:mode === 'triage' ? 'new' : mode === 'search' ? 'all' : 'active', mine:mode === 'my' ? 'assigned' : 'all', projectId:'', projectLabel:'', offset:0 });

/** Reserved read commands must never fall through into bug creation. */
export function parseQaWorkspaceCommand(raw: string): { intent: Mode; issueId: string; value: string } | undefined {
  const match = /^bug\s+(list|search|my|triage)(?:\s+([\s\S]*))?$/i.exec(raw.trim());
  return match ? { intent:match[1].toLowerCase() as Mode, issueId:'', value:(match[2] || '').trim() } : undefined;
}
function queryOf(p: QaSlackPayload): Query {
  const raw = JSON.parse(p.view?.private_metadata || '{}') as Partial<Query>;
  if (!raw || typeof raw !== 'object' || !['list','search','my','triage'].includes(raw.mode || '')
    || !['active','all',...QA_STATES].includes(raw.state || '') || !['all','assigned','testing','reported'].includes(raw.mine || '')
    || typeof raw.search !== 'string' || raw.search.length > 100 || typeof raw.projectId !== 'string' || raw.projectId.length > 200
    || typeof raw.projectLabel !== 'string' || raw.projectLabel.length > 75 || !Number.isInteger(raw.offset) || raw.offset! < 0 || raw.offset! > 100000) throw new Error('qa_workspace_query');
  return { mode:raw.mode!, search:raw.search, state:raw.state!, mine:raw.mine!, projectId:raw.projectId, projectLabel:raw.projectLabel, offset:raw.offset! };
}
function listInput(query: Query): QaListInput {
  return { offset:query.offset, limit:PAGE_SIZE, ...(query.search ? {search:query.search} : {}), ...(query.projectId ? {projectId:query.projectId} : {}),
    ...(query.mine === 'all' ? {} : {mine:query.mine}), ...(query.state === 'active' ? {states:QA_STATES.filter(state => state !== 'closed' && state !== 'dismissed')} : query.state === 'all' ? {} : {state:query.state}) };
}
function view(c: Copy, query: Query, blocks: SlackBlock[], filters = false): SlackBlock {
  return { type:'modal', callback_id:CALLBACK, title:plain(c.title), close:plain(c.close), ...(filters ? {submit:plain(c.apply)} : {}), private_metadata:JSON.stringify(query), blocks };
}
function resultView(result: QaListResult, workflow: QaWorkflow, query: Query, c: Copy): SlackBlock {
  const states = [option('active',c.active),option('all',c.all),...workflow.order.map(state => option(state,getQaStateLabel(workflow,state,value=>c.states[value])))];
  const mine = [option('all',c.all),option('assigned',c.assigned),option('testing',c.testing),option('reported',c.reported)];
  const blocks: SlackBlock[] = [
    section(c[query.mode === 'search' ? 'searchMode' : query.mode]),
    input('qa_query',c.search,{type:'plain_text_input',max_length:100,...(query.search ? {initial_value:query.search} : {})}),
    input('qa_project',c.project,{type:'external_select',min_query_length:0,placeholder:plain(c.chooseProject),...(query.projectId ? {initial_option:option(query.projectId,query.projectLabel || query.projectId)} : {})}),
    input('qa_state',c.state,{type:'static_select',options:states,initial_option:states.find(item=>item.value===query.state)}),
    input('qa_mine',c.mine,{type:'static_select',options:mine,initial_option:mine.find(item=>item.value===query.mine)}),
    section(`${result.total} ${c.count}${result.issues.length ? ` · ${c.page} ${query.offset + 1}–${query.offset + result.issues.length}` : ''}`),
  ];
  if (query.mode === 'triage') blocks.push(section(c.readOnly));
  if (!result.issues.length) blocks.push(section(c.empty));
  for (const issue of result.issues) blocks.push({ ...section(`${issue.title}\n${getQaStateLabel(workflow,issue.state,state=>c.states[state])} · ${c.severity[issue.severity]}${issue.dueDate ? ` · ${c.due}: ${issue.dueDate}` : ''}\n${issue.id}`), accessory:button('detail',c.detail,issue.id) });
  blocks.push({type:'actions',elements:[...(query.offset > 0 ? [button('page',c.previous,String(Math.max(0,query.offset-PAGE_SIZE)))] : []),
    button('refresh',c.refresh),...(result.hasMore && query.offset + PAGE_SIZE <= 100000 ? [button('page',c.next,String(query.offset+PAGE_SIZE))] : [])]});
  return view(c,query,blocks,true);
}
function detailView(issue: QaIssue, workflow: QaWorkflow, query: Query, actor: QaSlackActor, d: QaSlackActions, c: Copy, names:Record<string,string>={}): SlackBlock {
  const blocks: SlackBlock[] = [section(issue.title),section(`${issue.id}\n${getQaStateLabel(workflow,issue.state,state=>c.states[state])} · ${c.severity[issue.severity]}\n${c.env}: ${issue.observedEnvironment}\n${c.build}: ${issue.observedVersion || '—'}`)];
  for (const [label,body] of [[c.actual,issue.actual],[c.steps,issue.steps],[c.expected,issue.expected],[c.repair,issue.fixSummary],[c.hold,issue.holdReason]]) {
    if (!body) continue;
    blocks.push(section(label));
    for (let start=0;start<body.length;start+=3000) blocks.push(section(body.slice(start,start+3000)));
  }
  blocks.push(...qaHandoffBlocks(issue,names,actor.locale));
  const operations: Array<[string,string,Parameters<typeof canQaCommand>[2]]> = [['fix',c.fix,'submit_fix'],['deploy',c.deploy,'record_deployment'],['pass',c.pass,'record_verification'],['fail',c.fail,'record_verification'],['blocked',c.blocked,'record_verification'],['close',c.closeIssue,'close'],['reopen',c.reopen,'reopen']];
  const buttons = operations.filter(([, ,kind])=>canQaCommand(issue,actor,kind)).map(([intent,label])=>({type:'button',action_id:`livo_qa_${intent}`,text:plain(label),value:issue.id}));
  buttons.push(...qaCoordinationButtons(issue,actor,actor.locale) as typeof buttons);
  buttons.push({type:'button',action_id:'livo_qa_comment',text:plain(c.comment),value:issue.id});
  for (let start=0;start<buttons.length;start+=5) blocks.push({type:'actions',elements:buttons.slice(start,start+5)});
  blocks.push({type:'actions',elements:[button('back',c.back),{type:'button',text:plain(c.web),url:d.link(issue)}]});
  return view(c,query,blocks);
}

/** Every page, suggestion and detail lookup resolves the live member again. */
export async function handleQaWorkspace(p: QaSlackPayload, d: QaSlackActions): Promise<Record<string,unknown> | undefined> {
  const command = p.command ? parseQaWorkspaceCommand(p.text || '') : undefined;
  const action = p.actions?.find(item=>item.action_id.startsWith(PREFIX));
  const ownView = p.view?.callback_id === CALLBACK && ['view_submission','view_closed','block_suggestion'].includes(p.type || '');
  if (!command && !action && !ownView) return undefined;
  if (p.type === 'view_closed') return {};
  if (p.type === 'block_suggestion') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const lookup = (async () => {
        const actor = await d.actor(p), c=words(actor.locale);
        const search = String((p as unknown as Record<string,unknown>).value || '').slice(0,100);
        const groups = await d.projects(actor,search,true);
        return groups.length ? {option_groups:slackProjectOptionGroups(groups,c.ungrouped)} : {options:[] as SlackBlock[]};
      })();
      return await Promise.race([lookup,new Promise<{options:SlackBlock[]}>(resolve=>{timer=setTimeout(()=>resolve({options:[]}),2200);})]);
    } catch { console.warn('qa_workspace_project_lookup_failed'); return {options:[]}; }
    finally { if (timer) clearTimeout(timer); }
  }
  // The loading view contains no data or user-controlled error details before auth.
  const pending = view(words(),initial('list'),[section(words().loading)]);
  const submitted = p.type === 'view_submission';
  d.background((async () => {
    let viewId=p.view?.id, c=words();
    try {
      if (!viewId) {
        const opening=await d.slack('views.open',{trigger_id:p.trigger_id,view:pending});
        const opened=opening.view as {id?:unknown} | undefined;
        if (typeof opened?.id !== 'string') throw new Error('qa_workspace_open');
        viewId=opened.id;
      } else if (!submitted) await d.slack('views.update',{view_id:viewId,view:pending});
      const actor=await d.actor(p); c=words(actor.locale);
      const intent=action?.action_id.slice(PREFIX.length);
      let query=command ? initial(command.intent,command.value) : intent && ['list','search','my','triage'].includes(intent) ? initial(intent as Mode) : queryOf(p);
      if (submitted) {
        const values=p.view?.state?.values || {};
        const selection=(name:string)=>values[name]?.[name];
        const project=selection('qa_project')?.selected_option;
        const label=(project as {text?:{text?:unknown}} | undefined)?.text?.text;
        query={...query,search:(selection('qa_query')?.value || '').trim(),state:(selection('qa_state')?.selected_option?.value || 'all') as Query['state'],
          mine:(selection('qa_mine')?.selected_option?.value || 'all') as Query['mine'],projectId:project?.value || '',projectLabel:typeof label === 'string' ? label.slice(0,75) : '',offset:0};
        query=queryOf({view:{id:viewId,callback_id:CALLBACK,private_metadata:JSON.stringify(query)}});
      } else if (intent === 'page') {
        const offset=Number(action?.value);
        if (!/^\d+$/.test(action?.value || '') || !Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error('qa_workspace_query');
        query={...query,offset};
      }
      const workflowPromise=d.api<QaWorkflow>(actor,{action:'get_workflow'}).then(parseQaWorkflow);
      let next:SlackBlock;
      if (intent === 'detail') {
        const [detail,workflow]=await Promise.all([d.api<QaDetail>(actor,{action:'get',id:action?.value}),workflowPromise]);
        next=detailView(detail.issue,workflow,query,{...actor,qaCoordinatorProjectIds:detail.coordination?.coordinatorId===actor.id?[detail.issue.projectId]:[]},d,c,detail.memberNames);
      } else {
        const [result,workflow]=await Promise.all([d.api<QaListResult>(actor,{action:'list',input:listInput(query)}),workflowPromise]);
        next=resultView(result,workflow,query,c);
      }
      await d.slack('views.update',{view_id:viewId,view:next});
    } catch (error) {
      const message=error instanceof Error && error.message==='qa_workspace_query' ? c.invalid : c.error;
      const failure=view(c,initial('list'),[section(message)]);
      try {
        if (viewId) await d.slack('views.update',{view_id:viewId,view:failure});
        else await d.reply(p,message);
      } catch { console.warn('qa_workspace_delivery_failed'); }
    }
  })());
  return submitted ? {response_action:'update',view:pending} : {};
}
