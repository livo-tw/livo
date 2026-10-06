// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
import {createWorkData,executeSlackWorkCommand} from '../../docker/volumes/functions/slack-interact/work-backend';
import {workForm,parseWorkSubmission,workPage,workNotice} from '../../docker/volumes/functions/slack-interact/work-ui';
import {handleWork} from '../../docker/volumes/functions/slack-interact/work-handler';
import {TaskWorkError,parseTaskWorkCommand} from '../../docker/volumes/functions/slack-interact/work-core';
import {handleInteraction,type Actions} from '../../docker/volumes/functions/slack-interact/handler';
type Row=Record<string,any>;
const actor={id:'m1',jwt:'verified-member',locale:'en'};
const task:Row={id:'t1',task_key:'EXAMPLE-1',title:'<@everyone>',project_id:'p1',assignee_id:'m1',reviewer_id:'m1',assignee_revision:3,reviewer_revision:7};
const cmd=()=>parseTaskWorkCommand({commandId:'command-example',taskId:'t1',operation:'acknowledge',role:'assignee',expectedRevision:3});
const editCmd=()=>parseTaskWorkCommand({commandId:'delete-example',taskId:'t1',operation:'delete_item',list:'checks',itemId:'i1',expectedVersion:4});
function actions(overrides:Row={}) {
 const jobs:Promise<unknown>[]=[],slack=vi.fn(async(_method:string,_body:Row)=>({view:{id:'Vexample'}})),command=vi.fn(async(_actor:Row,input:Row)=>({commandId:input.commandId,task}));
  const d={work:{command,page:vi.fn(async(_actor:Row,_taskId:string,section:string,page:number)=>({task,section,page,rows:[],hasMore:false})),...overrides},workspace:{detail:vi.fn(async()=>task),comments:vi.fn(async()=>({comments:[],page:0,hasMore:false}))},enabled:async()=>true,actor:vi.fn(async()=>actor),search:vi.fn(async()=>[]),
  background:(p:Promise<unknown>)=>jobs.push(p),slack,reply:vi.fn(async()=>{}),link:()=> 'https://example.com/?task=t1'} as unknown as Actions;
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
 it('shows immediately effective assignments without acknowledgement controls or pending hints',()=>{
  const page=(t:Row)=>workPage({task:t,section:'responsibility',rows:[],page:0,hasMore:false},{locale:'zh-CN'},'m1');
  const buttons=(v:Row)=>v.blocks.flatMap((b:Row)=>b.elements||[]).filter((b:Row)=>b.action_id==='livo_work_ack');
  expect(buttons(page(task))).toHaveLength(0);expect(JSON.stringify(page(task))).toContain('已指派给你');
  expect(JSON.stringify(page(task))).not.toMatch(/未确认|尚未确认|确认接手|livo_work_ack/);
  expect(buttons(page({...task,assignee_acknowledged_at:'now',reviewer_id:'other'}))).toHaveLength(0);
  expect(page(task)).toEqual(page({...task,assignee_acknowledged_at:'now',reviewer_acknowledged_at:'now'}));
 });
 it('uses unique action IDs for section controls and both pagination buttons',()=>{
  const view=workPage({task,section:'checks',rows:[],page:1,hasMore:true},{locale:'en'},'m1');
  for(const block of view.blocks.filter((b:Row)=>b.type==='actions')) {
    const ids=block.elements.map((b:Row)=>b.action_id);expect(new Set(ids).size).toBe(ids.length);
  }
  const ids=view.blocks.flatMap((b:Row)=>b.elements||[]).map((b:Row)=>b.action_id);
  expect(ids).toEqual(expect.arrayContaining(['livo_work_open_checks','livo_work_open_todos','livo_work_open_children','livo_work_open_dependencies','livo_work_open_responsibility','livo_work_open_previous','livo_work_open_next']));
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
 it('retires advanced Slack forms and rechecks member access on each submission without writing',async()=>{
  const a=actions(),view=workForm(editCmd(),task,{locale:'en'}),payload={type:'view_submission',team:{id:'TEXAMPLE'},user:{id:'UEXAMPLE'},view:{...view,id:'Vdedup',hash:'h1',state:{values:{}}}};
  const response=await handleWork(payload,a.d,{locale:'en'});await handleWork(payload,a.d,{locale:'en'});await Promise.all(a.jobs);
  expect(response?.response_action).toBe('update');expect(a.command).not.toHaveBeenCalled();expect(a.d.actor).toHaveBeenCalledTimes(2);expect(a.d.workspace!.detail).toHaveBeenCalledTimes(2);expect(a.d.reply).not.toHaveBeenCalled();
 });
 it('opens the current authorized panel from an obsolete assignment button without an acknowledgement write',async()=>{
  const a=actions();await handleWork({type:'block_actions',trigger_id:'trigger',user:{id:'UEXAMPLE'},actions:[{action_id:'livo_work_ack',value:JSON.stringify({taskId:'t1',role:'assignee',expectedRevision:1})}]},a.d,{locale:'en'});await Promise.all(a.jobs);
  expect(a.command).not.toHaveBeenCalled();expect(a.d.workspace!.detail).toHaveBeenCalledWith(actor,'t1',false);
  expect(JSON.stringify(a.slack.mock.calls)).toContain('Acknowledgement is no longer required');
  expect(JSON.stringify(a.slack.mock.calls)).not.toContain('livo_work_ack');
 });
 it('treats an old acknowledgement form as a fresh read on every submit',async()=>{
  const a=actions(),payload={type:'view_submission',team:{id:'TEXAMPLE'},user:{id:'UEXAMPLE'},view:{id:'Vold',hash:'h1',callback_id:'livo_work_save',private_metadata:JSON.stringify({command:cmd()}),state:{values:{}}}};
  await handleWork(payload,a.d,{locale:'en'});await Promise.all(a.jobs);
  await handleWork(payload,a.d,{locale:'en'});await Promise.all(a.jobs);
  expect(a.command).not.toHaveBeenCalled();expect(a.d.actor).toHaveBeenCalledTimes(2);expect(a.d.workspace!.detail).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(a.slack.mock.calls)).toContain('Acknowledgement is no longer required');
 });
 it('fails closed when an obsolete button no longer has record access',async()=>{
  const a=actions();a.d.workspace!.detail=vi.fn(async()=>{throw new TaskWorkError('work_forbidden',403);});
  await handleWork({type:'block_actions',trigger_id:'trigger',user:{id:'UEXAMPLE'},actions:[{action_id:'livo_work_ack',value:JSON.stringify({taskId:'t1',role:'assignee',expectedRevision:1})}]},a.d,{locale:'en'});await Promise.all(a.jobs);
  expect(a.command).not.toHaveBeenCalled();expect(a.d.work!.page).not.toHaveBeenCalled();expect(JSON.stringify(a.slack.mock.calls)).not.toContain(task.title);
 });
 it.each(['checks','todos','children','dependencies','responsibility','previous','next'])('routes the unique work button %s through the member read contract',async suffix=>{
  const a=actions(),section=['previous','next'].includes(suffix)?'checks':suffix;
  await handleWork({type:'block_actions',trigger_id:'trigger',user:{id:'UEXAMPLE'},actions:[{action_id:`livo_work_open_${suffix}`,value:JSON.stringify({taskId:'t1',section,page:1})}]},a.d,{});await Promise.all(a.jobs);
  expect(a.d.workspace!.detail).toHaveBeenCalledWith(actor,'t1',false);expect(a.d.work!.page).not.toHaveBeenCalled();expect(a.command).not.toHaveBeenCalled();
  const rendered=a.slack.mock.calls.at(-1)![1].view;
  const buttons=rendered.blocks.flatMap((b:Row)=>b.elements||[]).filter((b:Row)=>b.type==='button');
  expect(buttons.map((b:Row)=>b.action_id||b.url)).toEqual(['livo_task_edit','livo_task_comment','https://example.com/?task=t1','livo_task_context','livo_workspace_home']);
  expect(JSON.stringify(rendered)).not.toMatch(/livo_work_|livo_deadline_|livo_reminder_|livo_approval/);
 });
 it('replaces a rejected rich view with a visible static error',async()=>{
  const a=actions();a.slack.mockImplementation(async(method:string,body:Row)=>{
    if(method==='views.update'&&body.view.blocks.some((b:Row)=>b.type==='actions'))throw new Error('invalid_arguments');return {view:{id:'Vexample'}};
  });
  await handleWork({type:'block_actions',trigger_id:'trigger',user:{id:'UEXAMPLE'},actions:[{action_id:'livo_work_open_checks',value:JSON.stringify({taskId:'t1',section:'checks'})}]},a.d,{locale:'en'});await Promise.all(a.jobs);
  expect(JSON.stringify(a.slack.mock.calls.at(-1))).toContain('work panel could not be displayed');expect(a.d.reply).not.toHaveBeenCalled();
 });
 it('replies privately when an old form has been closed, without an advanced write',async()=>{
  const a=actions();a.slack.mockRejectedValue(new Error('view_not_found'));const view=workForm(editCmd(),task,{locale:'en'});
  await handleWork({type:'view_submission',user:{id:'UEXAMPLE'},view:{...view,id:'Vclosed',hash:'h1',state:{values:{}}}},a.d,{locale:'en',channel:'CEXAMPLE'});await Promise.all(a.jobs);
  expect(a.command).not.toHaveBeenCalled();expect(a.d.reply).toHaveBeenCalledWith(expect.objectContaining({channel_id:'CEXAMPLE',user_id:'UEXAMPLE'}),expect.stringContaining('work panel could not be displayed'));
 });
 it('treats historical retry controls as a fresh task read rather than repeating a write',async()=>{
  const a=actions(),retry=workNotice('work_unavailable',{locale:'en'},editCmd());
  await handleWork({type:'block_actions',team:{id:'TEXAMPLE'},user:{id:'UEXAMPLE'},view:{...retry,id:'Vretry',hash:'h2'},actions:[{action_id:'livo_work_retry',value:'{}'}]},a.d,{locale:'en'});await Promise.all(a.jobs);
  expect(a.command).not.toHaveBeenCalled();expect(a.d.workspace!.detail).toHaveBeenCalledWith(actor,'t1',false);
 });
 it('returns a finite safe modal update for malformed historical forms that have no text input block',async()=>{
  const a=actions(),view:Row={type:'modal',id:'Vmalformed',callback_id:'livo_work_save',private_metadata:'invalid-json',blocks:[],state:{values:{}}};
  const response=await handleWork({type:'view_submission',view},a.d,{});
  expect(response).toMatchObject({response_action:'update',view:{type:'modal'}});expect(response).not.toHaveProperty('errors');expect(a.command).not.toHaveBeenCalled();
  expect(a.d.actor).not.toHaveBeenCalled();expect(a.d.workspace!.detail).not.toHaveBeenCalled();expect(a.jobs).toHaveLength(0);
 });
 it('acknowledges unexpected submissions of retired read-only notices without reading or writing a task',async()=>{
  const a=actions(),view=workForm(cmd(),task,{locale:'en'});
  expect(view).not.toHaveProperty('submit');expect(view.callback_id).not.toBe('livo_work_save');
  const response=await handleInteraction({type:'view_submission',team:{id:'TEXAMPLE'},user:{id:'UEXAMPLE'},view},'obsolete-notice',a.d);
  expect(response).toEqual({});expect(a.command).not.toHaveBeenCalled();expect(a.d.actor).not.toHaveBeenCalled();
  expect(a.d.workspace!.detail).not.toHaveBeenCalled();expect(a.jobs).toHaveLength(0);
 });
 it('stores a maximum-size retry payload in private metadata, not button value',()=>{
  const c=parseTaskWorkCommand({commandId:'large-command',taskId:'t1',operation:'add_item',list:'todos',text:'字'.repeat(2000)}),view=workNotice('work_unavailable',{locale:'en'},c);
  expect(view.blocks[1].elements[0].value).toBe('{}');expect(view.private_metadata.length).toBeLessThan(3000);expect(JSON.parse(view.private_metadata).retryCommand).toEqual(c);
 });
});
