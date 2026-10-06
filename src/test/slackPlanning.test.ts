import { describe,it,expect,vi } from 'vitest';
import { planningForm,parsePlanning,planningList } from '../../docker/volumes/functions/slack-interact/planning-ui';
import { createPlanningData } from '../../docker/volumes/functions/slack-interact/planning-backend';
import { handlePlanning } from '../../docker/volumes/functions/slack-interact/planning-handler';
import { memberJwt } from '../../docker/volumes/functions/slack-interact/backend';
import type { Actions } from '../../docker/volumes/functions/slack-interact/handler';
const task={id:'t1',task_key:'DEMO-1',title:'<@everyone>',due_date:'2026-10-10',due_date_kind:'committed',due_date_version:4};
describe('private Slack deadline and reminder forms',()=>{
 it('keeps an untouched deadline and kind, requires a reason for a commitment delay',()=>{
   const view=planningForm('deadline',task,{},{});
   expect(parsePlanning({...view,state:{values:{}}}).fields).toMatchObject({date:'2026-10-10',kind:'committed',version:4});
   expect(()=>parsePlanning({...view,state:{values:{date:{date:{selected_date:'2026-10-11'}}}}})).toThrow('planning_reason_required');
   expect(parsePlanning({...view,state:{values:{date:{date:{selected_date:'2026-10-11'}},reason:{reason:{value:'dependency delayed'}}}}}).fields)
     .toMatchObject({date:'2026-10-11',reason:'dependency delayed',version:4});
 });
 it('does not generate any pause or resume controls, including from historical builder routes',()=>{
   const view=planningForm('reminder',task,{version:2},{locale:'en',timezone:'America/New_York'});
   expect(JSON.stringify(view)).toContain('Personal reminder pauses have been removed');
   expect((view.blocks as Array<{type:string}>).some(block=>block.type==='input')).toBe(false);
   const list=planningList([{task_id:'t1',tasks:task,snoozed_until:'2026-11-01T00:00:00.000Z',version:2}],0,false,{locale:'zh-CN'});
   expect(JSON.stringify(list)).toContain('个人暂停提醒已移除');
   expect(JSON.stringify(list)).not.toContain('livo_reminder');
   expect(JSON.stringify(list)).toContain('livo_workspace_home');
 });
 it('uses only the member database and exact displayed CAS without body actor fields',async()=>{
   const request=vi.fn(async()=>({id:'t1',due_date_version:5})),rows=vi.fn(async()=>[]);
   const memberDb=vi.fn(()=>({request,rows})),data=createPlanningData(memberDb),actor={id:'m1',jwt:'verified-member-jwt'};
   await data.save(actor,'deadline',{taskId:'t1',version:4,date:'2026-10-11',kind:'committed',reason:'waiting',actor:'forged'});
   expect(memberDb).toHaveBeenCalledWith(actor);
   expect(request).toHaveBeenCalledWith('/rest/v1/rpc/livo_set_task_deadline','POST',{p_task_id:'t1',p_expected_version:4,p_due_date:'2026-10-11',p_kind:'committed',p_reason:'waiting'});
   await expect(data.list({id:'m1'},0)).rejects.toThrow('planning_forbidden');
   await data.list(actor,1);expect(rows).toHaveBeenCalledWith('task_reminder_preferences',expect.objectContaining({member_id:'eq.m1',offset:'10',limit:'11'}));
 });
 it('ACKs immediately, resolves the actor fresh, and deduplicates one submission in flight',async()=>{
   const jobs:Promise<unknown>[]=[],save=vi.fn(async(_actor:Record<string,unknown>,_kind:string,_fields:Record<string,unknown>)=>({})),slack=vi.fn(async()=>({view:{id:'V1'}}));
   const d={planning:{save},workspace:{},enabled:async()=>true,actor:vi.fn(async()=>({id:'m1',jwt:'real',locale:'en'})),
     background:(p:Promise<unknown>)=>jobs.push(p),slack,reply:vi.fn()} as unknown as Actions;
   const view=planningForm('deadline',task,{},{});
   const p={type:'view_submission',team:{id:'T1'},user:{id:'U1'},view:{...view,id:'Vuniqueplanning',hash:'h1',state:{values:{}}}};
   const ack=await handlePlanning(p,d,{});await handlePlanning(p,d,{});
   expect(ack?.response_action).toBe('update');await Promise.all(jobs);
   expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0][2].version).toBe(4);
   expect(d.reply).not.toHaveBeenCalled();expect(slack).toHaveBeenCalledWith('views.update',expect.objectContaining({view_id:'Vuniqueplanning'}));
 });
 it('refuses partial Slack claims even when source metadata supplies the missing identity',async()=>{
   await expect(memberJwt('x'.repeat(40),{auth_id:'auth1'},{id:'bind1'},{team:'T1',user:'U1'})).rejects.toThrow();
 });
});


describe('obsolete reminder controls are non-writing',()=>{
 it.each([
   {command:'/livo',text:'pause DEMO-1',trigger_id:'example-trigger'},
   {command:'/livo',text:'reminders',trigger_id:'example-trigger'},
   {type:'block_actions',trigger_id:'example-trigger',actions:[{action_id:'livo_reminder_resume',value:JSON.stringify({taskId:'t1',version:2})}]},
   {type:'view_submission',view:{callback_id:'livo_planning_reminder',id:'old-reminder-view',private_metadata:JSON.stringify({taskId:'t1',version:2}),state:{values:{}}}},
 ])('shows a private notice for an old route and never reads or writes preferences',async payload=>{
   const jobs:Promise<unknown>[]=[],save=vi.fn(),list=vi.fn(),preference=vi.fn(),slack=vi.fn(async()=>({view:{id:'Vexample'}}));
   const d={planning:{save,list,preference},workspace:{detail:vi.fn(async()=>task)},enabled:async()=>true,actor:vi.fn(async()=>({id:'member-example',locale:'en'})),
     background:(job:Promise<unknown>)=>jobs.push(job),slack,reply:vi.fn()} as unknown as Actions;
   await handlePlanning(payload,d,{});await Promise.all(jobs);
   expect(d.actor).toHaveBeenCalled();expect(save).not.toHaveBeenCalled();expect(list).not.toHaveBeenCalled();expect(preference).not.toHaveBeenCalled();
   expect(JSON.stringify(slack.mock.calls)).toContain('Personal reminder pauses have been removed');
   expect(JSON.stringify(slack.mock.calls)).not.toContain('livo_reminder_resume');
   expect(d.reply).not.toHaveBeenCalled();
 });
});
