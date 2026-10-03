// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
import {createWorkData,executeSlackWorkCommand} from '../../docker/volumes/functions/slack-interact/work-backend';
import {workForm,parseWorkSubmission,workPage,workNotice} from '../../docker/volumes/functions/slack-interact/work-ui';
import {handleWork} from '../../docker/volumes/functions/slack-interact/work-handler';
import {TaskWorkError,parseTaskWorkCommand} from '../../docker/volumes/functions/slack-interact/work-core';
import type {Actions} from '../../docker/volumes/functions/slack-interact/handler';
type Row=Record<string,any>;
const actor={id:'m1',jwt:'verified-member',locale:'en'};
const task:Row={id:'t1',task_key:'EXAMPLE-1',title:'<@everyone>',project_id:'p1',assignee_id:'m1',reviewer_id:'m1',assignee_revision:3,reviewer_revision:7};
const cmd=()=>parseTaskWorkCommand({commandId:'command-example',taskId:'t1',operation:'acknowledge',role:'assignee',expectedRevision:3});
function actions(overrides:Row={}) {
 const jobs:Promise<unknown>[]=[],slack=vi.fn(async(_method:string,_body:Row)=>({view:{id:'Vexample'}})),command=vi.fn(async(_actor:Row,input:Row)=>({commandId:input.commandId,task}));
 const d={work:{command,...overrides},workspace:{detail:vi.fn(async()=>task)},enabled:async()=>true,actor:vi.fn(async()=>actor),search:vi.fn(async()=>[]),
  background:(p:Promise<unknown>)=>jobs.push(p),slack,reply:vi.fn(async()=>{})} as unknown as Actions;
 return {d,jobs,slack,command};
}
describe('Slack TaskWork private forms and live reads',()=>{
 it('keeps task and item text plain, limits pagination, and binds edit CAS to the original row',()=>{
  const view=workPage({task,section:'checks',rows:[{id:'i1',text:'<!channel>',version:4}],page:1,hasMore:true},{locale:'en'},'m1');
  expect(view.blocks.filter((b:Row)=>b.type==='section').every((b:Row)=>b.text.type==='plain_text')).toBe(true);
  const edit=view.blocks.flatMap((b:Row)=>b.elements||[]).find((b:Row)=>b.action_id==='livo_work_edit');expect(JSON.parse(edit.value)).toMatchObject({expectedVersion:4,itemId:'i1'});
  const form=workForm({commandId:'edit-command',taskId:'t1',operation:'update_item',list:'checks',itemId:'i1',expectedVersion:4},task,{}, {text:'Old',is_done:false});
  const parsed=parseWorkSubmission({...form,state:{values:{text:{value:{value:'New'}},done:{value:{selected_option:{value:'true'}}}}}});
  expect(parsed).toMatchObject({expectedVersion:4,text:'New',isDone:true});
 });
 it('shows both own responsibilities and hides already acknowledged or other-person actions',()=>{
  const page=(t:Row)=>workPage({task:t,section:'responsibility',rows:[],page:0,hasMore:false},{locale:'zh-CN'},'m1');
  const buttons=(v:Row)=>v.blocks.flatMap((b:Row)=>b.elements||[]).filter((b:Row)=>b.action_id==='livo_work_ack');
  expect(buttons(page(task)).map((b:Row)=>JSON.parse(b.value).expectedRevision)).toEqual([3,7]);
  expect(buttons(page({...task,assignee_acknowledged_at:'now',reviewer_id:'other'}))).toHaveLength(0);
 });
 it('reads through member JWT/RLS, pages 8+1, and refuses missing JWT without service fallback',async()=>{
  const rows=vi.fn(async(table:string,_params:Row):Promise<Row[]>=>table==='tasks'?[task]:Array.from({length:9},(_,i)=>({id:`i${i}`,version:0})));
  const factory=vi.fn(()=>({rows,request:vi.fn()})),execute=vi.fn(),data=createWorkData(factory,execute);
  const page=await data.page(actor,'t1','checks',2);expect(page.rows).toHaveLength(8);expect(page.hasMore).toBe(true);
  expect(rows).toHaveBeenCalledWith('task_checks',expect.objectContaining({task_id:'eq.t1',offset:'16',limit:'9'}));
  expect(factory).toHaveBeenCalledWith(actor);
  await expect(data.page({id:'m1'},'t1','checks',0)).rejects.toThrow('work_forbidden');
  await expect(data.item(actor,'t1','checks','i1',2)).rejects.toThrow('work_conflict');
 });
 it('refuses unsupported required fields before constructing a child form',async()=>{
  const rows=vi.fn(async(table:string):Promise<Row[]>=>table==='tasks'?[task]:table==='system_settings'?[{value:{description:true}}]:[]);
  const data=createWorkData(()=>({rows,request:vi.fn()}),vi.fn());
  await expect(data.childConfig(actor,'t1')).rejects.toThrow('work_required_fields');
 });
 it('rechecks both dependency endpoints through RLS before invoking the endpoint',async()=>{
  const rows=vi.fn(async(_table:string,params:Row):Promise<Row[]>=>params.id==='eq.t1'?[task]:[]),execute=vi.fn();
  const data=createWorkData(()=>({rows,request:vi.fn()}),execute);
  await expect(data.command(actor,parseTaskWorkCommand({commandId:'dependency-example',taskId:'t1',operation:'add_dependency',dependsOnTaskId:'secret'}))).rejects.toThrow('work_unavailable');expect(execute).not.toHaveBeenCalled();
 });
 it('sends only the verified member bearer and preserves uncertain transport status',async()=>{
  const env={get:(name:string)=>name==='SUPABASE_URL'?'https://example.com':'example-anon'};
  const fetcher=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({commandId:cmd().commandId,task}));
  await executeSlackWorkCommand(env,actor,cmd(),fetcher);
  expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({Authorization:'Bearer verified-member'});
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(cmd());
  await expect(executeSlackWorkCommand(env,actor,cmd(),async()=>Response.json({error:'internal secret'},{status:500}))).rejects.toMatchObject({code:'work_unavailable',status:503});
 });
 it('ACKs promptly, resolves live actor, and collapses duplicate Slack submissions',async()=>{
  const a=actions(),view=workForm(cmd(),task,{locale:'en'}),payload={type:'view_submission',team:{id:'TEXAMPLE'},user:{id:'UEXAMPLE'},view:{...view,id:'Vdedup',hash:'h1',state:{values:{}}}};
  const response=await handleWork(payload,a.d,{locale:'en'});await handleWork(payload,a.d,{locale:'en'});await Promise.all(a.jobs);
  expect(response?.response_action).toBe('update');expect(a.command).toHaveBeenCalledTimes(1);expect(a.command).toHaveBeenCalledWith(actor,cmd());expect(a.d.reply).not.toHaveBeenCalled();
 });
 it('rejects an old assignment button without upgrading its displayed revision',async()=>{
  const a=actions();await handleWork({type:'block_actions',trigger_id:'trigger',user:{id:'UEXAMPLE'},actions:[{action_id:'livo_work_ack',value:JSON.stringify({taskId:'t1',role:'assignee',expectedRevision:1})}]},a.d,{locale:'en'});await Promise.all(a.jobs);
  expect(a.command).not.toHaveBeenCalled();expect(JSON.stringify(a.slack.mock.calls)).toContain('data changed');
 });
 it('retries an uncertain save with exactly the original command ID and body',async()=>{
  let attempt=0;const captured:Row[]=[];const a=actions({command:async(_actor:Row,c:Row)=>{captured.push(c);if(!attempt++)throw new TaskWorkError('work_unavailable',503);return {};}});
  const view=workForm(cmd(),task,{locale:'en'}),payload={type:'view_submission',team:{id:'TEXAMPLE'},user:{id:'UEXAMPLE'},view:{...view,id:'Vretry',hash:'h1',state:{values:{}}}};
  await handleWork(payload,a.d,{locale:'en'});await Promise.all(a.jobs);
  const retry=a.slack.mock.calls[a.slack.mock.calls.length-1][1].view;
  expect(JSON.parse(retry.private_metadata).retryCommand).toEqual(cmd());
  await handleWork({type:'block_actions',team:payload.team,user:payload.user,view:{...retry,id:'Vretry',hash:'h2'},actions:[{action_id:'livo_work_retry',value:'{}'}]},a.d,{locale:'en'});await Promise.all(a.jobs);
  expect(captured).toEqual([cmd(),cmd()]);
 });
 it('returns a valid modal update for malformed forms that have no text input block',async()=>{
  const a=actions(),view=workForm(cmd(),task,{});const response=await handleWork({type:'view_submission',view:{...view,private_metadata:'invalid-json'}},a.d,{});
  expect(response).toMatchObject({response_action:'update',view:{type:'modal'}});expect(response).not.toHaveProperty('errors');expect(a.command).not.toHaveBeenCalled();
 });
 it('stores a maximum-size retry payload in private metadata, not button value',()=>{
  const c=parseTaskWorkCommand({commandId:'large-command',taskId:'t1',operation:'add_item',list:'todos',text:'字'.repeat(2000)}),view=workNotice('work_unavailable',{locale:'en'},c);
  expect(view.blocks[1].elements[0].value).toBe('{}');expect(view.private_metadata.length).toBeLessThan(3000);expect(JSON.parse(view.private_metadata).retryCommand).toEqual(c);
 });
});
