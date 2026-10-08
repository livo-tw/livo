/** Private QA coordination forms. Actor and authorization never come from metadata. */
import { canQaCommand, type QaCommand, type QaDetail, type QaIssue } from './domain.ts';
import { getQaSlackDisplaySettings, type QaSlackActions, type QaSlackPayload, type SlackBlock } from './slack.ts';
import { getQaPriorityChoices } from './displaySettings.ts';
import { qaPriorityText } from './notificationText.ts';
const messages={
 'zh-TW':{triage:'分流 Bug',start_fix:'開始修復',hold:'記錄卡關',request_handoff:'建立交接',accept_handoff:'接收交接',resolve_handoff:'解除交接',
 loading:'正在載入 QA…',saving:'正在儲存 QA…',saved:'QA 已儲存',failed:'操作未完成。請重新開啟表單確認最新資料與權限。',conflict:'Bug 已更新；請重新開啟表單確認，不會覆蓋其他人的變更。',
 rd:'修復負責人',qa:'驗證 QA',severity:'嚴重程度',priority:'優先級',due:'任務期限（選填）',reason:'卡關／交接原因',owner:'下一位內部責任人',reply:'預期回覆時間（選填，依你的 Slack 時區）',external:'外部依賴（選填）',evidence:'解除依據／證據',submit:'確認',cancel:'取消',required:'請填寫必要欄位',
 confirm:'此操作只更新所列 QA 紀錄。接收交接不代表完成驗證；解除交接不會標記 PASS 或結案。',low:'低',medium:'中',high:'高'},
 'en':{triage:'Triage bug',start_fix:'Start fixing',hold:'Record blocker',request_handoff:'Request handoff',accept_handoff:'Accept handoff',resolve_handoff:'Resolve handoff',
 loading:'Loading QA…',saving:'Saving QA…',saved:'QA saved',failed:'Unable to complete. Reopen the form to review current data and permissions.',conflict:'The bug changed. Reopen the form to review it; other changes were not overwritten.',
 rd:'Developer',qa:'Verification owner',severity:'Severity',priority:'Priority',due:'Task due date (optional)',reason:'Blocker / handoff reason',owner:'Next internal owner',reply:'Reply by (optional, Slack timezone)',external:'External dependency (optional)',evidence:'Resolution evidence',submit:'Confirm',cancel:'Cancel',required:'Complete this field',
 confirm:'This only updates the stated QA record. Accepting a handoff is not verification; resolving it does not mark PASS or close the bug.',low:'Low',medium:'Medium',high:'High'},
 'zh-CN':{triage:'分流 Bug',start_fix:'开始修复',hold:'记录阻塞',request_handoff:'建立交接',accept_handoff:'接收交接',resolve_handoff:'解除交接',
 loading:'正在加载 QA…',saving:'正在保存 QA…',saved:'QA 已保存',failed:'操作未完成。请重新打开表单确认最新数据与权限。',conflict:'Bug 已更新；请重新打开表单确认，不会覆盖其他人的变更。',
 rd:'修复负责人',qa:'验证 QA',severity:'严重程度',priority:'优先级',due:'任务期限（选填）',reason:'阻塞／交接原因',owner:'下一位内部责任人',reply:'预期回复时间（选填，依你的 Slack 时区）',external:'外部依赖（选填）',evidence:'解除依据／证据',submit:'确认',cancel:'取消',required:'请填写必要字段',
 confirm:'此操作只更新所列 QA 记录。接收交接不代表完成验证；解除交接不会标记 PASS 或结案。',low:'低',medium:'中',high:'高'}
};
const locale=(value?:string)=>value?.startsWith('en')?'en':value==='zh-CN'||value==='zh_CN'?'zh-CN':'zh-TW';
const text=(value:string)=>({type:'plain_text',text:value});
const option=(value:string,label:string)=>({value,text:text(label.slice(0,75))});
const field=(id:string,label:string,element:SlackBlock,optional=false)=>({type:'input',block_id:id,label:text(label),optional,element:{...element,action_id:id}});
const message=(body:string)=>({type:'modal',callback_id:'livo_qa_coordination_result',title:text('LIVO QA'),close:text('OK'),blocks:[{type:'section',text:text(body)}]});
const kinds=['triage','start_fix','hold','request_handoff','accept_handoff','resolve_handoff'] as const;
type Kind=typeof kinds[number];
const recognized=(value:string):value is Kind=>kinds.includes(value as Kind);
export const qaCoordinationButtons=(issue:QaIssue,actor:Parameters<typeof canQaCommand>[1],userLocale?:string):SlackBlock[]=>{
 const t=messages[locale(userLocale)];
 return kinds.filter(kind=>canQaCommand(issue,actor,kind)).map(kind=>({type:'button',action_id:`livo_qa_${kind}`,value:issue.id,text:text(t[kind])}));
};
export function qaHandoffBlocks(issue:QaIssue,names:Record<string,string>={},userLocale?:string):SlackBlock[]{
 const h=issue.handoff;if(!h)return [];const t=messages[locale(userLocale)],blocks:SlackBlock[]=[];
 const body=[`${t.request_handoff} · ${h.id}`,`${t.owner}: ${names[h.nextOwnerId]||h.nextOwnerId}`,`${t.reply}: ${h.replyBy||'—'}`,
  `${t.reason}: ${h.reason}`,h.externalDependency?`${t.external}: ${h.externalDependency}`:'',
  h.acceptedAt?`${t.accept_handoff}: ${names[h.acceptedBy||'']||h.acceptedBy} · ${h.acceptedAt}`:'',
  h.resolvedAt?`${t.resolve_handoff}: ${names[h.resolvedBy||'']||h.resolvedBy} · ${h.resolvedAt}\n${t.evidence}: ${h.resolutionEvidence}`:''].filter(Boolean).join('\n');
 let chunk='';for(const char of body){if(chunk.length+char.length>2800){blocks.push({type:'section',text:text(chunk)});chunk='';}chunk+=char;}if(chunk)blocks.push({type:'section',text:text(chunk)});return blocks;
}
export async function handleQaCoordinationSlack(p:QaSlackPayload,d:QaSlackActions):Promise<Record<string,unknown>|undefined>{
 const callback=p.view?.callback_id;
 if(p.type==='block_suggestion'&&callback==='livo_qa_coordination'){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{const lookup=(async()=>{const meta=JSON.parse(p.view!.private_metadata||'{}'),actor=await d.actor(p);
    if(!await d.enabled())return {options:[]};
    const data=await d.api<{members:Array<{id:string;name:string}>}>(actor,{action:'members',projectId:meta.projectId,search:String((p as unknown as {value?:string}).value||'')});
    return {options:data.members.slice(0,100).map(m=>option(m.id,m.name))};
   })();return await Promise.race([lookup,new Promise<{options:SlackBlock[]}>(resolve=>{timer=setTimeout(()=>resolve({options:[]}),2200);})]);
  }catch{return {options:[]};}finally{if(timer)clearTimeout(timer);}
 }
 if(p.type==='view_submission'&&callback==='livo_qa_coordination'){
  const meta=JSON.parse(p.view!.private_metadata||'{}'),values=p.view!.state?.values||{},t=messages[locale(meta.locale)];
  const selected=(key:string)=>values[key]?.[key] as {value?:string;selected_option?:{value:string};selected_date?:string;selected_date_time?:number}|undefined;
  const value=(key:string)=>selected(key)?.value??selected(key)?.selected_option?.value??'';
  if(!recognized(meta.kind)||typeof meta.issueId!=='string'||!Number.isSafeInteger(meta.version))return {response_action:'update',view:message(t.failed)};
  // Severity is checked after loading the live display setting, never from metadata.
  const required=meta.kind==='triage'?['rd','qa','priority']:meta.kind==='request_handoff'?['reason','owner']:meta.kind==='hold'?['reason']:meta.kind==='resolve_handoff'?['evidence']:[];
  const errors=Object.fromEntries(required.filter(k=>!value(k).trim()).map(k=>[k,t.required]));
  if(Object.keys(errors).length)return {response_action:'errors',errors};
  const viewId=p.view!.id;
  d.background((async()=>{let result:string;
   try{if(!await d.enabled())throw new Error('qa_disabled');const actor=await d.actor(p);
    const detail=await d.api<QaDetail>(actor,{action:'get',id:meta.issueId});
    const scoped={...actor,qaCoordinatorProjectIds:detail.coordination?.coordinatorId===actor.id?[detail.issue.projectId]:[]};
    if(!canQaCommand(detail.issue,scoped,meta.kind))throw new Error('qa_forbidden');
    let command:QaCommand;
    if(meta.kind==='triage'){
     const display=await getQaSlackDisplaySettings(d,actor);
     if(display.showSeverity&&!value('severity').trim())throw new Error('qa_required');
     command={type:'triage',assigneeId:value('rd'),qaOwnerId:value('qa'),severity:display.showSeverity?value('severity') as QaIssue['severity']:detail.issue.severity,priority:Number(value('priority')),dueDate:selected('due')?.selected_date||null};
    }
    else if(meta.kind==='request_handoff'){const stamp=selected('reply')?.selected_date_time;command={type:'request_handoff',reason:value('reason'),nextOwnerId:value('owner'),replyBy:stamp==null?null:new Date(stamp*1000).toISOString(),externalDependency:value('external')};}
    else if(meta.kind==='accept_handoff')command={type:'accept_handoff',handoffId:meta.handoffId};
    else if(meta.kind==='resolve_handoff')command={type:'resolve_handoff',handoffId:meta.handoffId,evidence:value('evidence')};
    else command=meta.kind==='hold'?{type:'hold',reason:value('reason')}:{type:'start_fix'};
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`qa-coordination:${actor.team}:${viewId}`));
    const commandId='qa-slack-'+[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
    const issue=await d.api<QaIssue>(actor,{action:'command',id:meta.issueId,expectedVersion:meta.version,commandId,command});
    result=`${t.saved}: ${issue.title}`; // Result stays private; no new public message.
   }catch(e){result=e instanceof Error&&/conflict/.test(e.message)?t.conflict:t.failed;}
   await d.slack('views.update',{view_id:viewId,view:message(result)}).catch(()=>{});
  })());
  return {response_action:'update',view:message(t.saving)};
 }
 const command=p.command?/^bug\s+(triage|start_fix|hold|request_handoff|accept_handoff|resolve_handoff)\s+(\S+)\s*$/i.exec(p.text||''):null;
 const action=p.actions?.find(a=>recognized(a.action_id.replace(/^livo_qa_/,'')));
 const kind=command?.[1]?.toLowerCase()||action?.action_id.replace(/^livo_qa_/,''),issueId=command?.[2]||action?.value;
 if(!kind||!recognized(kind)||!issueId)return undefined;
 // Consume trigger before authorization/network reads; the view is private.
 const open=await d.slack(p.view?'views.update':'views.open',{...(p.view?{view_id:p.view.id}:{trigger_id:p.trigger_id}),view:message(messages['zh-TW'].loading)});
 const viewId=p.view?.id||(open.view as {id:string}).id;
 d.background((async()=>{
  try{if(!await d.enabled())throw new Error('qa_disabled');const actor=await d.actor(p),t=messages[locale(actor.locale)];
   const detail=await d.api<QaDetail>(actor,{action:'get',id:issueId}),issue=detail.issue;
   const scoped={...actor,qaCoordinatorProjectIds:detail.coordination?.coordinatorId===actor.id?[issue.projectId]:[]};
   if(!canQaCommand(issue,scoped,kind))throw new Error('qa_forbidden');
   const blocks:SlackBlock[]=[{type:'section',text:text(issue.title)},{type:'section',text:text(t.confirm)}];
   const person=(key:string,label:string)=>field(key,label,{type:'external_select',min_query_length:0});
   const note=(key:string,label:string,max=3000,optional=false)=>field(key,label,{type:'plain_text_input',multiline:true,max_length:max},optional);
   if(kind==='triage'){
    const display=await getQaSlackDisplaySettings(d,actor);
    blocks.push(person('rd',t.rd),person('qa',t.qa));
    if(display.showSeverity)blocks.push(field('severity',t.severity,{type:'static_select',options:['low','medium','high'].map(s=>option(s,t[s as 'low']))}));
    blocks.push(field('priority',t.priority,{type:'static_select',options:getQaPriorityChoices(display,issue.priority).map(n=>option(String(n),qaPriorityText(n,actor.locale))),initial_option:option(String(issue.priority),qaPriorityText(issue.priority,actor.locale))}),field('due',t.due,{type:'datepicker',...(issue.dueDate?{initial_date:issue.dueDate}:{})},true));
   }
   else if(kind==='hold')blocks.push(note('reason',t.reason));
   else if(kind==='request_handoff')blocks.push(note('reason',t.reason),person('owner',t.owner),field('reply',t.reply,{type:'datetimepicker'},true),note('external',t.external,2000,true));
   else if(kind==='resolve_handoff')blocks.push(note('evidence',t.evidence));
   if(issue.handoff&&['accept_handoff','resolve_handoff'].includes(kind)){let chunk='';for(const char of issue.handoff.reason){if(chunk.length+char.length>2800){blocks.push({type:'section',text:text(chunk)});chunk='';}chunk+=char;}if(chunk)blocks.push({type:'section',text:text(chunk)});}
   await d.slack('views.update',{view_id:viewId,view:{type:'modal',callback_id:'livo_qa_coordination',title:text(t[kind]),submit:text(t.submit),close:text(t.cancel),
    private_metadata:JSON.stringify({kind,issueId,projectId:issue.projectId,version:issue.version,handoffId:issue.handoff?.id,locale:actor.locale}),blocks}});
  }catch{await d.slack('views.update',{view_id:viewId,view:message(messages['zh-TW'].failed)});}
 })());return {};
}
