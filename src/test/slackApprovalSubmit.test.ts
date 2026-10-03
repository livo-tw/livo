// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
import type {Actions} from '../../docker/volumes/functions/slack-interact/handler';
import {handleApprovalInteraction} from '../../docker/volumes/functions/slack-interact/approval-handler';
import {createApprovalData,executeSlackApprovalCommand,type ApprovalSubmitPreparation,type ApprovalSubmitCommand} from '../../docker/volumes/functions/slack-interact/approval-backend';
import {APPROVAL_TEXT,approvalSubmitButton,approvalSubmitSelectModal,approvalSubmitConfirmModal,approvalSubmitRetryModal,parseApprovalSubmitDraft} from '../../docker/volumes/functions/slack-interact/approval-ui';
import {ApprovalCommandError,type ApprovalCommandResult,type ApprovalExpectedTask} from '../../docker/volumes/functions/approval-command/core';
import type {Row} from '../../docker/volumes/functions/slack-interact/core';

const actor:Row={id:'member-1',locale:'zh-TW',jwt:'synthetic-member-session',team:'TEXAMPLE',slack_user:'UEXAMPLE'};
const source:Row={team:'TEXAMPLE',user:'UEXAMPLE',channel:'CEXAMPLE',locale:'zh-TW'};
const handleInteraction=async(p:Row,_event:string,d:Actions):Promise<Row>=>await handleApprovalInteraction(p,d,source)||{};
const expected:ApprovalExpectedTask={statusId:'todo',requiresApproval:false,currentApprovalId:null,approvalStatus:null};
const prepared:ApprovalSubmitPreparation={task:{id:'task-1',task_key:'EX-1',title:'Private <@UEXAMPLE> title',project_name:'Example project',from_status_name:'Todo'},
 expected,targets:[{id:'done',name:'Done',ruleId:null,ruleSnapshot:null,steps:[{step_order:1,approver_type:'role',approver_role:'admin',approver_user_id:null}]}],cursor:0,nextCursor:null,omitted:0};
const command:ApprovalSubmitCommand={commandId:'slack-approval:synthetic-intent',operation:'submit',taskId:'task-1',expected,toStatusId:'done',expectedRuleId:null,enableRequirement:false};
const result:ApprovalCommandResult={commandId:command.commandId,replayed:false,eventId:'event-1',task:{id:'task-1',status_id:'todo',requires_approval:true,approval_status:'pending_approval',current_approval_id:'request-1'},
 request:{id:'request-1',task_id:'task-1',rule_id:null,requested_by:'member-1',from_status:'todo',to_status:'done',current_step:1,status:'pending',version:1,steps_snapshot:prepared.targets[0].steps,created_at:'2026-01-01',completed_at:null}};
const base:Row={team:{id:source.team},user:{id:source.user},channel:{id:source.channel},trigger_id:'trigger-1'};
function setup(){
 const jobs:Promise<unknown>[]=[];
 const d:Actions={enabled:vi.fn(async()=>true),heartbeat:vi.fn(async()=>{}),actor:vi.fn(async()=>actor),catalog:vi.fn(async()=>({})),search:vi.fn(async()=>[]),task:vi.fn(async()=>undefined),mapped:vi.fn(async()=>undefined),
  slack:vi.fn(async()=>({view:{id:'VIEW1',hash:'loading-hash'}})),reply:vi.fn(async()=>{}),commit:vi.fn(async()=>({})),deliver:vi.fn(async()=>{}),background:job=>jobs.push(job),link:()=> 'https://example.com/?task=EX-1',
  approvals:{prepareSubmit:vi.fn(async()=>prepared),command:vi.fn(async()=>result),list:vi.fn(async()=>({entries:[],cursor:0,nextCursor:null,enabled:true})),detail:vi.fn(async()=>({request:result.request!,task:prepared.task,canAct:false,canWithdraw:true,enabled:true,legacy:false}))}};
 return {d,jobs,flush:async()=>{await Promise.all(jobs);},last:()=>vi.mocked(d.slack).mock.calls.filter(([method])=>method==='views.update').at(-1)?.[1].view as Row};
}
const click=():Row=>({...base,type:'block_actions',actions:[approvalSubmitButton('task-1','en')]});
const select=():Row=>({...base,type:'view_submission',view:{...approvalSubmitSelectModal(prepared,source,command.commandId),id:'VIEW1',state:{values:{approval_target:{target:{selected_option:{value:'0'}}}}}}});
const confirm=(enable=true):Row=>({...base,type:'view_submission',view:{...approvalSubmitConfirmModal(prepared,prepared.targets[0],source,command),id:'VIEW1',state:{values:{approval_requirement:{enable:{selected_options:enable?[{value:'enable'}]:[]}}}}}});

describe('initial Slack approval submission',()=>{
 it.each(['submit EX-1','送簽 EX-1','送签 ex-1'])('opens private selection for %s after consuming trigger',async text=>{
  const {d,flush,last}=setup();await handleInteraction({...base,command:'/livo',text},'event',d);await flush();
  expect(d.slack).toHaveBeenCalledWith('views.open',expect.objectContaining({trigger_id:'trigger-1'}));
  expect(vi.mocked(d.slack).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.actor).mock.invocationCallOrder[0]);
  expect(d.approvals!.prepareSubmit).toHaveBeenCalledWith(actor,'EX-1',{byKey:true,cursor:0});expect(last().callback_id).toBe('livo_approval_submit_select');
  expect(d.reply).not.toHaveBeenCalled();expect(d.approvals!.command).not.toHaveBeenCalled();
 });
 it('button carries task identity only; actor comes from live binding',async()=>{
  const {d,flush}=setup(),p=click();p.actions[0].value=JSON.stringify({taskId:'task-1',actorId:'forged',role:'super_admin'});
  await handleInteraction(p,'event',d);await flush();expect(d.approvals!.prepareSubmit).toHaveBeenCalledWith(actor,'task-1',{byKey:false,cursor:0});
  expect(JSON.parse(approvalSubmitButton('task-1').value)).toEqual({taskId:'task-1'});
 });
 it('target selection never mutates and keeps original expected fields and intent',async()=>{
  const {d,flush,last}=setup();const ack=await handleInteraction(select(),'event',d);expect(ack.response_action).toBe('update');await flush();
  expect(last().callback_id).toBe('livo_approval_submit_confirm');expect(JSON.parse(last().private_metadata).command).toEqual(command);
  expect(d.approvals!.command).not.toHaveBeenCalled();
 });
 it.each(['status','requirement','rule'] as const)('refuses a changed %s instead of upgrading the displayed command',async change=>{
  const {d,flush,last}=setup();vi.mocked(d.approvals!.prepareSubmit!).mockResolvedValue({...prepared,expected:{...expected,...(change==='status'?{statusId:'doing'}:change==='requirement'?{requiresApproval:true}:{})},
    targets:change==='rule'?[{...prepared.targets[0],ruleId:'rule-new'}]:prepared.targets});
  await handleInteraction(select(),'event',d);await flush();expect(last().callback_id).toBe('livo_approval_notice');expect(JSON.stringify(last())).toContain('已變更');expect(d.approvals!.command).not.toHaveBeenCalled();
 });
 it('requires an explicit enable choice when no rule and no existing requirement',async()=>{
  const {d,jobs}=setup();const ack=await handleInteraction(confirm(false),'event',d);
  expect(ack.response_action).toBe('errors');expect(ack.errors.approval_requirement).toBeTruthy();expect(jobs).toHaveLength(0);expect(d.approvals!.command).not.toHaveBeenCalled();
 });
 it('ACKs before lookup and sends exactly the original command plus explicit enable',async()=>{
  const {d,flush,last}=setup();let finish!:(value:boolean)=>void;vi.mocked(d.enabled).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const payload=confirm();const metadata=JSON.parse(payload.view.private_metadata);metadata.actorId='forged';metadata.role='super_admin';payload.view.private_metadata=JSON.stringify(metadata);
  const ack=await handleInteraction(payload,'event',d);expect(ack.response_action).toBe('update');expect(d.actor).not.toHaveBeenCalled();finish(true);await flush();
  expect(d.approvals!.command).toHaveBeenCalledWith(actor,{...command,enableRequirement:true});expect(d.approvals!.prepareSubmit).not.toHaveBeenCalled();expect(JSON.stringify(last())).toContain('已儲存');
 });
 it('matching-rule submission can remain advisory without implicitly enabling requirement',async()=>{
  const {d,flush}=setup(),p=confirm(false),meta=JSON.parse(p.view.private_metadata);meta.command.expectedRuleId='rule-1';p.view.private_metadata=JSON.stringify(meta);
  await handleInteraction(p,'event',d);await flush();expect(d.approvals!.command).toHaveBeenCalledWith(actor,{...command,expectedRuleId:'rule-1',enableRequirement:false});
 });
 it('already-required cards do not offer or implicitly alter the requirement',()=>{
  const view=approvalSubmitConfirmModal(prepared,prepared.targets[0],source,{...command,expected:{...expected,requiresApproval:true}});
  expect(view.blocks.some((block:Row)=>block.block_id==='approval_requirement')).toBe(false);
 });
 it('uncertain result retries the identical command and exposes no cached task content',async()=>{
  const {d,flush,last}=setup();vi.mocked(d.approvals!.command).mockRejectedValueOnce(new ApprovalCommandError('approval_transport_error')).mockResolvedValue(result);
  await handleInteraction(confirm(),'event',d);await flush();const retry=last();expect(retry.callback_id).toBe('livo_approval_submit_retry');expect(JSON.stringify(retry)).not.toContain('Private');
  expect(JSON.parse(retry.private_metadata).command).toEqual({...command,enableRequirement:true});
  await handleInteraction({...base,type:'view_submission',view:{...retry,id:'VIEW1',state:{values:{}}}},'retry',d);await flush();
  expect(vi.mocked(d.approvals!.command).mock.calls[0][1]).toEqual(vi.mocked(d.approvals!.command).mock.calls[1][1]);expect(d.actor).toHaveBeenCalledTimes(2);
 });
 it('success remains success if a follow-up read fails',async()=>{
  const {d,flush,last}=setup();vi.mocked(d.approvals!.detail).mockRejectedValue(new Error('revoked'));
  await handleInteraction(confirm(),'event',d);await flush();expect(JSON.stringify(last())).toContain('已儲存');expect(JSON.stringify(last())).not.toContain('Private');
 });
 it.each(['feature','actor'] as const)('refuses live %s revocation without disclosing the task',async kind=>{
  const {d,flush,last}=setup();if(kind==='feature')vi.mocked(d.enabled).mockResolvedValue(false);else vi.mocked(d.actor).mockRejectedValue(new Error('revoked'));
  await handleInteraction(confirm(),'event',d);await flush();expect(d.approvals!.command).not.toHaveBeenCalled();expect(JSON.stringify(last())).not.toContain('Private');
 });
 it('pagination keeps intent and rejects changed task state',async()=>{
  const {d,flush,last}=setup();const first=approvalSubmitSelectModal({...prepared,nextCursor:8},source,command.commandId);
  const p={...base,type:'block_actions',view:{...first,id:'VIEW1',hash:'old'},actions:[{action_id:'livo_approval_submit_page',value:JSON.stringify({cursor:8})}]};
  vi.mocked(d.approvals!.prepareSubmit!).mockResolvedValue({...prepared,cursor:8});await handleInteraction(p,'page',d);await flush();
  expect(JSON.parse(last().private_metadata).draft.commandId).toBe(command.commandId);expect(d.slack).toHaveBeenCalledWith('views.update',expect.objectContaining({hash:'old'}));
  vi.mocked(d.approvals!.prepareSubmit!).mockResolvedValue({...prepared,cursor:8,expected:{...expected,requiresApproval:true}});
  await handleInteraction(p,'page2',d);await flush();expect(last().callback_id).toBe('livo_approval_notice');
 });
 it('validates malformed selections, intent and fields before background work',async()=>{
  for(const kind of ['selection','command','operation','enable']){
   const {d,jobs}=setup(),p=kind==='selection'?select():confirm();
   if(kind==='selection')p.view.state.values.approval_target.target.selected_option.value='99';
   else if(kind==='enable')p.view.state.values.approval_requirement.enable.selected_options=[{value:'forged'}];
   else {const meta=JSON.parse(p.view.private_metadata);if(kind==='command')meta.command.commandId='short';else meta.command.operation='withdraw';p.view.private_metadata=JSON.stringify(meta);}
   expect((await handleInteraction(p,'invalid',d)).response_action).toBe('update');expect(jobs).toHaveLength(0);
  }
 });
 it('closed modal fallback is generic and ephemeral, never a channel notification',async()=>{
  const {d,flush}=setup();vi.mocked(d.slack).mockRejectedValue(new Error('closed'));await handleInteraction(click(),'event',d);await flush();
  const fallback=vi.mocked(d.slack).mock.calls.find(([method])=>method==='chat.postEphemeral');expect(fallback?.[1].text).toContain('/livo submit');expect(fallback?.[1].text).not.toContain('Private');
  expect(d.reply).not.toHaveBeenCalled();expect(vi.mocked(d.slack).mock.calls.some(([m])=>m==='chat.postMessage')).toBe(false);
 });
 it('uses all three locales, plain text, bounded metadata and no implicit checkbox selection',()=>{
  for(const locale of ['zh-TW','zh-CN','en']){
   const pick=approvalSubmitSelectModal(prepared,{...source,locale},command.commandId),view=approvalSubmitConfirmModal(prepared,prepared.targets[0],{...source,locale},command);
   expect(JSON.stringify(view)).not.toContain('mrkdwn');expect(JSON.stringify(view)).not.toContain('initial_options');expect(view.private_metadata.length).toBeLessThan(3000);
   expect(parseApprovalSubmitDraft(JSON.parse(pick.private_metadata).draft)?.expected).toEqual(expected);expect(approvalSubmitRetryModal(command,{locale}).blocks).toHaveLength(1);
  }
  expect(Object.values(APPROVAL_TEXT).every(value=>value.length===3&&value.every(Boolean))).toBe(true);
  expect(parseApprovalSubmitDraft({...JSON.parse(approvalSubmitSelectModal(prepared,source,command.commandId).private_metadata).draft,actorId:'forged'})).toBeNull();
 });
});

describe('prepare submission through live member RLS',()=>{
 function database(){
  const state:Row={active:true,enabled:true,task:{id:'task-1',task_key:'EX-1',title:'Synthetic',project_id:'project-1',status_id:'todo',requires_approval:false,current_approval_id:null,approval_status:null,projects:{id:'project-1',name:'Example',is_archived:false}},duplicate:false,pending:false,rules:[],steps:[],approverActive:true,
   statuses:[{id:'todo',name:'Todo'},...Array.from({length:10},(_,i)=>({id:`target-${i}`,name:`Target ${i}`}))]};
  const rows=vi.fn(async(table:string,q:Row={})=>{
   if(table==='members')return String(q.id).startsWith('in.')?(state.approverActive?[{id:'reviewer-1',is_active:true}]:[]):state.active?[{id:'member-1',role:'member',is_active:true}]:[];
   if(table==='system_settings')return [{value:{approvals:state.enabled}}];
   if(table==='tasks')return state.task?(state.duplicate?[state.task,{...state.task,id:'duplicate-task'}]:[state.task]):[];
   if(table==='approval_requests')return state.pending?[{id:'legacy-pending'}]:[];
   if(table==='statuses')return String(q.id).startsWith('eq.')?state.statuses.filter((s:Row)=>q.id===`eq.${s.id}`):state.statuses.filter((s:Row)=>s.id!=='todo').slice(Number(q.offset),Number(q.offset)+Number(q.limit));
   if(table==='approval_rules')return state.rules.filter((r:Row)=>r.to_status===String(q.to_status).slice(3)).slice(0,Number(q.limit));
   if(table==='approval_rule_steps')return state.steps.filter((step:Row)=>q.rule_id===`eq.${step.rule_id}`).slice(0,Number(q.limit));
   return [];
  });
  const request=vi.fn(),memberDb=vi.fn(()=>({rows,request})),execute=vi.fn(async()=>result),data=createApprovalData(memberDb,execute);
  return {state,rows,request,memberDb,execute,data,prepare:()=>data.prepareSubmit!(actor,'task-1')};
 }
 it('returns fallback steps without enabling anything and preserves pagination',async()=>{
  const {data,prepare,memberDb,request}=database();const first=await prepare(),second=await data.prepareSubmit!(actor,'task-1',{cursor:first.nextCursor!});
  expect(first.targets).toHaveLength(8);expect(second.targets).toHaveLength(2);expect(second.nextCursor).toBeNull();expect(first.expected.requiresApproval).toBe(false);
  expect(first.targets[0]).toMatchObject({ruleId:null,steps:[{approver_role:'admin'}]});expect(memberDb).toHaveBeenCalledWith(actor);expect(request).not.toHaveBeenCalled();
 });
 it.each(['inactive','disabled','archived','hidden','crossProject','duplicate','pending','legacyPointer'] as const)('rejects %s preparation',async failure=>{
  const {state,data,prepare}=database();
  if(failure==='inactive')state.active=false;if(failure==='disabled')state.enabled=false;if(failure==='archived')state.task.projects.is_archived=true;
  if(failure==='hidden')state.task=null;if(failure==='crossProject')state.task.projects.id='other-project';if(failure==='duplicate')state.duplicate=true;
  if(failure==='pending')state.pending=true;if(failure==='legacyPointer')state.task.current_approval_id='old-request';
  await expect(failure==='duplicate'?data.prepareSubmit!(actor,'EX-1',{byKey:true}):prepare()).rejects.toThrow(/approval_(forbidden|disabled|pending)/);
 });
 it('uses the matching live rule snapshot and validates active named approvers',async()=>{
  const {state,prepare}=database();state.rules=[{id:'rule-1',project_id:'project-1',from_status:'todo',to_status:'target-0',is_active:true}];
  state.steps=[{rule_id:'rule-1',step_order:1,approver_type:'user',approver_user_id:'reviewer-1',approver_role:null}];
  const valid=await prepare();expect(valid.targets[0].ruleSnapshot).toEqual(state.rules[0]);expect(valid.targets[0].steps).toEqual(state.steps);
  state.approverActive=false;const unavailable=await prepare();expect(unavailable.targets.some(target=>target.id==='target-0')).toBe(false);expect(unavailable.omitted).toBe(1);
 });
 it.each(['ambiguous','empty','malformed','overflow'] as const)('does not replace %s rules with administrator fallback',async failure=>{
  const {state,prepare}=database(),rule={id:'rule-1',project_id:'project-1',from_status:'todo',to_status:'target-0',is_active:true};state.rules=failure==='ambiguous'?[rule,{...rule,id:'rule-2'}]:[rule];
  state.steps=failure==='overflow'?Array.from({length:101},(_,i):Row=>({rule_id:'rule-1',step_order:i+1,approver_type:'role',approver_role:'admin',approver_user_id:null})):failure==='malformed'?[{rule_id:'rule-1',step_order:2,approver_type:'role',approver_role:'admin',approver_user_id:null} as Row]:[];
  const value=await prepare();expect(value.targets.some(target=>target.id==='target-0')).toBe(false);expect(value.omitted).toBe(1);expect(value.nextCursor).toBe(8);
 });
 it('retains continuation when every rule on a page is invalid',async()=>{
  const {state,data,prepare}=database();state.rules=Array.from({length:8},(_,i)=>({id:`rule-${i}`,project_id:'project-1',from_status:'todo',to_status:`target-${i}`,is_active:true}));
  const first=await prepare();expect(first.targets).toEqual([]);expect(first.nextCursor).toBe(8);expect((await data.prepareSubmit!(actor,'task-1',{cursor:8})).targets).toHaveLength(2);
 });
 it('does not accept a receipt for a different task after submitting',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(JSON.stringify({...result,task:{...result.task,id:'other-task'}}),{status:200}));
  await expect(executeSlackApprovalCommand({get:key=>key==='SUPABASE_URL'?'https://database.example.com':'public-placeholder'},actor,command,fetcher)).rejects.toThrow('approval_transport_error');
  expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[1][1]?.body);
 });
});
