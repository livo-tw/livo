import {describe,expect,it,vi} from 'vitest';
import {applyQaCommand,createQaIssue,type QaIssue,type QaDetail} from '../lib/qa/domain';
import {handleQaSlack,qaSlackCard,type QaSlackActions,type QaSlackPayload} from '../lib/qa/slack';
import {qaSlackCurrentState,qaLatestDetailView} from '../lib/qa/slackWorkspace';
import {DEFAULT_QA_WORKFLOW} from '../lib/qa/workflow';

type Row=Record<string,any>;
const actor={id:'creator',role:'member' as const,team:'TEXAMPLE',slack_user:'UEXAMPLE',locale:'zh-TW'};
const context=()=>({actor,workspaceId:'default',now:'2026-10-06T00:00:00Z',newId:()=> 'target-example',environmentValues:['Staging','Production'],memberIds:new Set(['creator','developer','tester']),projectIds:new Set(['p','p2']),taskIds:new Set<string>()});
const makeIssue=():QaIssue=>createQaIssue({projectId:'p',title:'Example bug',actual:'Example result',observedEnvironment:'Staging'},'issue-example',context());
function harness(initial=makeIssue()) {
  const jobs:Promise<unknown>[]=[],receipts=new Map<string,QaIssue>();let current=initial,loseCreateResponse=false;
  const api=vi.fn(async(_actor:typeof actor,body:Row):Promise<any>=>{
    if(body.action==='get_workflow')return DEFAULT_QA_WORKFLOW;
    if(body.action==='get')return {issue:current,comments:[],events:[],attachments:[],memberNames:{developer:'Example Developer',tester:'Example Tester'}};
    if(body.action==='members')return {members:[{id:'developer',name:'Example Developer'},{id:'tester',name:'Example Tester'}],hasMore:false};
    if(body.action==='create'){
      if(receipts.has(body.commandId))return receipts.get(body.commandId);
      current=createQaIssue(body.input,body.id,context());receipts.set(body.commandId,current);
      if(loseCreateResponse){loseCreateResponse=false;throw new Error('qa_unavailable');}return current;
    }
    if(body.action==='command'){
      current=applyQaCommand(current,body.command,context());return current;
    }
    return current;
  });
  const d:QaSlackActions={enabled:async()=>true,actor:vi.fn(async()=>actor),api:api as QaSlackActions['api'],
    projects:vi.fn(async()=>[{line:{id:'line',name:'Example line'},projects:[{id:'p',name:'Example project',lineId:'line'},{id:'p2',name:'Second project',lineId:'line'}]}]),
    environments:async()=>['Staging','Production'],mapped:async()=>undefined,publish:vi.fn(async()=>{}),sync:vi.fn(async()=>{}),
    claimNotice:async()=>true,enqueueEvent:async()=> 'event-example',completeEvent:async()=>{},pendingEvents:async()=>[],
    slack:vi.fn(async()=>({view:{id:'VEXAMPLE'}})),reply:vi.fn(async()=>{}),background:job=>jobs.push(job),link:issue=>`https://example.com/?qa=${issue.id}`};
  return {d,api,flush:async()=>{await Promise.all(jobs);},current:()=>current,loseNextCreateResponse:()=>{loseCreateResponse=true;}};
}
const selected=(value:string)=>({selected_option:{value}});
const submit=(id:string,intent:string,values:Row,extra:Row={}):QaSlackPayload=>({type:'view_submission',team_id:'TEXAMPLE',user_id:'UEXAMPLE',view:{id,callback_id:'livo_qa_submit',private_metadata:JSON.stringify({intent,channel:'CEXAMPLE',issueId:'issue-example',version:1,...extra}),state:{values:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{[key]:typeof value==='string'?{value}:value}]))}}});
const createValues=(extra:Row={})=>({project:selected('p'),title:'Example bug',actual:'Example result',environment:selected('Staging'),severity:selected('medium'),...extra});
const lastView=(d:QaSlackActions):Row=>vi.mocked(d.slack).mock.calls.filter(call=>call[0]==='views.update').at(-1)![1].view as Row;

describe('Slack QA assignment, current state and stale action experience',()=>{
  it('offers optional developer and QA selection to an ordinary active member',async()=>{
    const h=harness();await handleQaSlack({command:'/livo',text:'bug new',trigger_id:'example'},'new',h.d);await h.flush();
    const view=lastView(h.d);
    for(const id of ['assigneeId','qaOwnerId'])expect(view.blocks.find((block:Row)=>block.block_id===id)).toMatchObject({optional:true,element:{type:'external_select'}});
    expect(view.blocks.find((block:Row)=>block.block_id==='severity').element.initial_option.value).toBe('medium');
    expect(view.blocks.find((block:Row)=>block.block_id==='qaOwnerId').element.initial_option.value).toBe(actor.id);
    expect(view.blocks.find((block:Row)=>block.block_id==='priority').element.initial_option.value).toBe('3');
    expect(view.blocks.find((block:Row)=>block.block_id==='dueDate').element.type).toBe('datepicker');
    expect(view.blocks.some((block:Row)=>block.block_id==='component')).toBe(false);
  });
  it.each(['assigneeId','qaOwnerId'])('looks up %s via the authorized members action for the current selected project',async action_id=>{
    const h=harness();const result=await handleQaSlack({type:'block_suggestion',action_id,value:'Example',view:{id:'VEXAMPLE',callback_id:'livo_qa_submit',private_metadata:JSON.stringify({projectId:'p'}),state:{values:{project:{project:selected('p2')}}}}},'suggestion',h.d);
    expect(h.api).toHaveBeenCalledWith(actor,{action:'members',projectId:'p2',search:'Example',offset:0});
    expect(result.options).toHaveLength(2);expect(h.d.projects).not.toHaveBeenCalled();
    h.api.mockRejectedValueOnce(new Error('qa_forbidden'));
    expect(await handleQaSlack({type:'block_suggestion',action_id,view:{id:'VEXAMPLE',callback_id:'livo_qa_submit',private_metadata:JSON.stringify({projectId:'unreadable'})}},'denied',h.d)).toEqual({options:[]});
  });
  it.each([{assigneeId:selected('developer')},{qaOwnerId:selected('tester')},{assigneeId:selected('developer'),qaOwnerId:selected('tester')}])('creates owners atomically without fabricated triage or a second assignment write',async owners=>{
    const h=harness();await handleQaSlack(submit('VOWNER','new',createValues(owners)),'owners',h.d);await h.flush();
    const creation=h.api.mock.calls.find(([,body])=>body.action==='create')![1];
    expect(creation.input).toMatchObject({assigneeId:owners.assigneeId?.selected_option.value||null,qaOwnerId:owners.qaOwnerId?.selected_option.value||actor.id,severity:'medium',priority:3,dueDate:null});
    expect(h.api.mock.calls.filter(([,body])=>body.action==='command')).toHaveLength(0);
    expect(h.current()).toMatchObject({state:'new',version:1,runs:[]});expect(h.d.publish).toHaveBeenCalledWith(actor,h.current(),expect.anything());
  });
  it('defaults a legacy new form to the reporter while allowing an explicitly cleared QA owner',async()=>{
    const h=harness();await handleQaSlack(submit('VDEFAULT','new',createValues()),'default',h.d);await h.flush();
    expect(h.current()).toMatchObject({state:'new',assigneeId:null,qaOwnerId:actor.id});
    const cleared=harness();await handleQaSlack(submit('VCLEAR','new',createValues({qaOwnerId:{selected_option:null}})),'clear',cleared.d);await cleared.flush();
    expect(cleared.current().qaOwnerId).toBeNull();
  });
  it('submits selected priority and the Slack datepicker value in the create payload',async()=>{
    const h=harness();await handleQaSlack(submit('VSETTINGS','new',createValues({priority:selected('2'),dueDate:{selected_date:'2026-11-09'}})),'settings',h.d);await h.flush();
    expect(h.current()).toMatchObject({priority:2,dueDate:'2026-11-09',qaOwnerId:actor.id,state:'new',version:1});
  });
  it('recovers a lost create response through the existing receipt without creating or assigning twice',async()=>{
    const h=harness(),payload=submit('VRESUME','new',createValues({assigneeId:selected('developer')}));h.loseNextCreateResponse();
    await handleQaSlack(payload,'attempt-1',h.d);await h.flush();expect(h.current()).toMatchObject({assigneeId:'developer',qaOwnerId:actor.id,version:1});expect(h.d.publish).not.toHaveBeenCalled();
    await handleQaSlack(payload,'attempt-2',h.d);await h.flush();
    const creations=h.api.mock.calls.filter(([,body])=>body.action==='create').map(([,body])=>body);
    expect(creations).toHaveLength(2);expect(creations[0]).toEqual(creations[1]);
    expect(h.api.mock.calls.filter(([,body])=>body.action==='command')).toHaveLength(0);expect(h.current().version).toBe(1);expect(h.d.publish).toHaveBeenCalledTimes(1);
  });
  it('creates distinct bugs when a new form reuses the same Slack modal with a new hash',async()=>{
    const h=harness(),first=submit('VREUSED','new',createValues()),second=submit('VREUSED','new',createValues({title:'Second example bug'}));
    first.view!.hash='form-1';second.view!.hash='form-2';
    await handleQaSlack(first,'first',h.d);await h.flush();await handleQaSlack(second,'second',h.d);await h.flush();
    const creates=h.api.mock.calls.filter(([,body])=>body.action==='create').map(([,body])=>body);
    expect(creates[0].commandId).not.toBe(creates[1].commandId);expect(creates[0].id).not.toBe(creates[1].id);expect(h.current().title).toBe('Second example bug');
  });
  it('allows an empty fix summary/build while preserving the selected verification environment',async()=>{
    const h=harness({...makeIssue(),assigneeId:'creator',qaOwnerId:'tester'});await handleQaSlack({command:'/livo',text:'bug fix issue-example',trigger_id:'example'},'fix',h.d);await h.flush();
    for(const id of ['note','build'])expect(lastView(h.d).blocks.find((block:Row)=>block.block_id===id).optional).toBe(true);
    await handleQaSlack(submit('VFIX','fix',{environment:{selected_options:[{value:'Staging'}]}}),'fix-submit',h.d);await h.flush();
    expect(h.api).toHaveBeenCalledWith(actor,expect.objectContaining({command:{type:'submit_fix',summary:'',targets:[{environment:'Staging',component:'',build:'',required:true}]}}));
    expect(h.current().state).toBe('verification');
  });
  it.each(['deploy','pass','fail','blocked'])('makes %s evidence optional and labels an empty product version explicitly',async intent=>{
    const h=harness({...makeIssue(),state:'verification',fixCycle:1,assigneeId:'creator',qaOwnerId:'creator',targets:[{id:'target-example',environment:'Staging',component:'Web',build:'',required:true,deployedAt:'2026-10-06T00:00:00Z',deployedBy:'creator',deploymentEvidence:''}]});
    await handleQaSlack({command:'/livo',text:`bug ${intent} issue-example`,trigger_id:'example'},`form-${intent}`,h.d);await h.flush();
    expect(lastView(h.d).blocks.find((block:Row)=>block.block_id==='note').optional).toBe(true);expect(JSON.stringify(lastView(h.d))).toContain('版本未填');
    const response=await handleQaSlack(submit(`V${intent}`,intent,{target:selected('target-example')}),`submit-${intent}`,h.d);expect(response.response_action).toBe('update');await h.flush();
    expect(h.api.mock.calls.some(([,body])=>body.action==='command')).toBe(true);
    if(intent!=='deploy')expect(h.current().runs[0]).toMatchObject({result:intent,note:'',testerId:'creator',createdAt:'2026-10-06T00:00:00Z'});
    if(intent==='pass'){expect(h.current()).toMatchObject({state:'closed',resolution:'fixed',closedBy:'creator'});expect(h.d.reply).toHaveBeenCalledWith(expect.anything(),expect.stringContaining('驗證通過並結案。'));}
    else if(intent!=='deploy')expect(h.current().state).not.toBe('closed');
  });
  it.each(['closed','reassigned','changed-stage'])('explains a stale %s fix action using the latest permitted panel',async kind=>{
    const current={...makeIssue(),assigneeId:kind==='reassigned'?'developer':'creator',qaOwnerId:'tester',state:kind==='closed'?'closed':kind==='changed-stage'?'new':'in_progress'} as QaIssue;
    if(kind==='changed-stage')current.qaOwnerId=null;
    const h=harness(current);await handleQaSlack({type:'block_actions',trigger_id:'example',actions:[{action_id:'livo_qa_fix',value:'issue-example'}]},'stale',h.d);await h.flush();
    const view=lastView(h.d);expect(view.callback_id).toBe('livo_qa_workspace');expect(JSON.stringify(view)).toContain('最新 Bug');
    const ids=view.blocks.flatMap((block:Row)=>block.elements||[]).map((button:Row)=>button.action_id);
    expect(ids).not.toContain('livo_qa_fix');expect(ids).toContain('livo_qa_comment');expect(ids).toContain('livo_qa_workspace_back');
    expect(h.api.mock.calls.every(([,body])=>!['create','command','comment'].includes(body.action))).toBe(true);
  });
  it('does not reveal an unreadable bug when an old action is pressed',async()=>{
    const h=harness();h.api.mockRejectedValue(new Error('qa_forbidden'));
    await handleQaSlack({type:'block_actions',trigger_id:'example',actions:[{action_id:'livo_qa_fix',value:'issue-example'}]},'forbidden',h.d);await h.flush();
    expect(JSON.stringify(lastView(h.d))).not.toContain('Example bug');expect(h.api).toHaveBeenCalledTimes(1);
  });
  it('does not authorize deployment from untrusted modal metadata',async()=>{
    const h=harness({...makeIssue(),state:'verification',assigneeId:'developer',qaOwnerId:'tester',fixCycle:1,targets:[{id:'target-example',environment:'Staging',component:'Web',build:'',required:true,deployedAt:null,deployedBy:null,deploymentEvidence:''}]});
    await handleQaSlack(submit('VFORGED','deploy',{target:selected('target-example')},{deploymentOperator:true}),'forged-operator',h.d);await h.flush();
    expect(h.api.mock.calls.some(([,body])=>body.action==='command')).toBe(false);expect(lastView(h.d).callback_id).toBe('livo_qa_workspace');
    expect(JSON.stringify(lastView(h.d))).not.toContain('livo_qa_deploy');
  });
  it('still delivers a private successful completion after the processing modal closes',async()=>{
    const h=harness();vi.mocked(h.d.slack).mockRejectedValue(new Error('view_not_found'));
    const response=await handleQaSlack(submit('VCLOSED','new',createValues()),'closed',h.d);expect(JSON.stringify(response)).toContain('關閉視窗不會取消');await h.flush();
    expect(h.api.mock.calls.filter(([,body])=>body.action==='create')).toHaveLength(1);
    expect(h.d.reply).toHaveBeenCalledWith(expect.objectContaining({channel_id:'CEXAMPLE'}),expect.stringContaining('已更新 Bug'));
  });
  it.each(['new','triaged','in_progress','verification','verified','failed','closed','dismissed'])('puts actual %s state before the shared card title',state=>{
    const blocks=qaSlackCard({...makeIssue(),state} as QaIssue,'https://example.com');expect((blocks[0].text as Row).text).toMatch(/^\*目前狀態：/);
    expect((blocks[0].text as Row).text).toBe(`*${qaSlackCurrentState(state,DEFAULT_QA_WORKFLOW)}*`);
  });
  it.each(['zh-TW','zh-CN','en'])('keeps PASS and closed distinct in %s and fails closed for malformed states',locale=>{
    const verified=qaSlackCurrentState('verified',DEFAULT_QA_WORKFLOW,locale),closed=qaSlackCurrentState('closed',DEFAULT_QA_WORKFLOW,locale);
    expect(verified).toContain('✅');expect(closed).toContain('🏁');expect(verified).not.toBe(closed);
    for(const invalid of ['<!channel>',null,{}])expect(qaSlackCurrentState(invalid,DEFAULT_QA_WORKFLOW,locale)).toContain('❔');
    expect(qaSlackCurrentState('<!channel>',DEFAULT_QA_WORKFLOW,locale)).not.toContain('<!channel>');
  });
  it('does not offer close before a formal PASS in an actor-specific detail',()=>{
    const h=harness({...makeIssue(),qaOwnerId:'creator'});const detail={issue:h.current(),memberNames:{},comments:[],events:[],attachments:[]} as QaDetail;
    expect(JSON.stringify(qaLatestDetailView(detail,actor,h.d,DEFAULT_QA_WORKFLOW))).not.toContain('livo_qa_close');
  });
});
