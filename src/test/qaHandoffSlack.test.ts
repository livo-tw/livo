import {describe,it,expect,vi} from 'vitest';
import {handleQaSlack,type QaSlackActions,type QaSlackPayload} from '../lib/qa/slack';
import {createQaIssue,type QaIssue} from '../lib/qa/domain';
import { defaultQaDisplaySettings } from '../lib/qa/displaySettings';
const seed=():QaIssue=>createQaIssue({projectId:'p',title:'<Synthetic & safe>',actual:'Example',observedEnvironment:'Stage'},'issue',{actor:{id:'reporter',role:'member'},workspaceId:'default',now:'2026-10-03T00:00:00.000Z',newId:()=> 'x',memberIds:new Set(['reporter']),projectIds:new Set(['p']),taskIds:new Set()});
function fixture(){let issue=seed();const jobs:Promise<unknown>[]=[],actor={id:'coord',role:'member',team:'T1',slack_user:'U1',locale:'en'};
 const api=vi.fn(async(_actor,body)=>body.action==='get'?{issue,coordination:{projectId:'p',coordinatorId:'coord',version:1},events:[],comments:[],attachments:[]}:body.action==='members'?{members:[{id:'rd',name:'Developer'}],hasMore:false}:issue);
 const d={enabled:vi.fn(async()=>true),actor:vi.fn(async()=>actor),api,slack:vi.fn(async()=>({view:{id:'V1'}})),background:(job:Promise<unknown>)=>jobs.push(job),reply:vi.fn(async()=>{}),link:()=> 'https://example.test',sync:vi.fn(),publish:vi.fn()} as unknown as QaSlackActions;
 return {d,api,actor,set:(value:QaIssue)=>{issue=value;},flush:()=>Promise.all(jobs)};
}
const values=(data:Record<string,string>)=>Object.fromEntries(Object.entries(data).map(([key,value])=>[key,{[key]:{value}}]));
const submit=(kind:string,state:Record<string,Record<string,unknown>>={},extra={})=>({type:'view_submission',view:{id:'V1',callback_id:'livo_qa_coordination',private_metadata:JSON.stringify({kind,issueId:'issue',projectId:'p',version:1,locale:'en',...extra}),state:{values:state}}}) as QaSlackPayload;
describe('Slack QA private coordination forms',()=>{
 it.each(['triage','hold','request_handoff'])('opens %s privately before reading actor',async kind=>{const {d,flush}=fixture();await handleQaSlack({command:'/livo',text:`bug ${kind} issue`,trigger_id:'trigger'},'e',d);await flush();expect(vi.mocked(d.slack).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.actor).mock.invocationCallOrder[0]);expect(d.slack).toHaveBeenCalledWith('views.update',expect.objectContaining({view:expect.objectContaining({callback_id:'livo_qa_coordination'})}));expect(d.reply).not.toHaveBeenCalled();});
 it('keeps the original form version after fresh lookup, and actor is live',async()=>{const {d,set,api,flush}=fixture();set({...seed(),version:9});await handleQaSlack(submit('hold',values({reason:'Waiting'}),{actor:{id:'admin'},user:'fake'}),'e',d);await flush();expect(api).toHaveBeenCalledWith(expect.objectContaining({id:'coord'}),expect.objectContaining({action:'command',expectedVersion:1,command:{type:'hold',reason:'Waiting'}}));expect(d.reply).not.toHaveBeenCalled();});
 it('triage requires explicit RD/QA/severity/priority and retains optional date',async()=>{const {d,api,flush}=fixture();const input=values({rd:'rd',qa:'qa',severity:'high',priority:'2'});input.due={due:{selected_date:'2026-10-05'}} as never;await handleQaSlack(submit('triage',input),'e',d);await flush();expect(api).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({command:{type:'triage',assigneeId:'rd',qaOwnerId:'qa',severity:'high',priority:2,dueDate:'2026-10-05'}}));});
 it('requires next owner, reason and nonempty resolve evidence',async()=>{for(const kind of ['request_handoff','resolve_handoff']){const {d,api}=fixture();expect(await handleQaSlack(submit(kind),'e',d)).toMatchObject({response_action:'errors'});expect(api).not.toHaveBeenCalled();}});
 it('request converts Slack selected time to exact UTC ISO and never sets RD or QA',async()=>{const {d,api,flush}=fixture();const input=values({reason:'Need decision',owner:'rd',external:'Ticket ABC'});input.reply={reply:{selected_date_time:1791158400}} as never;await handleQaSlack(submit('request_handoff',input),'e',d);await flush();expect(api).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({command:{type:'request_handoff',reason:'Need decision',nextOwnerId:'rd',externalDependency:'Ticket ABC',replyBy:new Date(1791158400000).toISOString()}}));});
 it('settings revocation after opening suppresses mutation',async()=>{const {d,api,flush}=fixture();api.mockImplementation(async()=>({issue:seed(),coordination:{projectId:'p',coordinatorId:null,version:2}}) as never);await handleQaSlack(submit('hold',values({reason:'Waiting'})),'e',d);await flush();expect(api.mock.calls.filter(c=>c[1].action==='command')).toHaveLength(0);});
 it('member suggestions use live scoped API and no public reply',async()=>{const {d,api}=fixture();const result=await handleQaSlack({type:'block_suggestion',view:{id:'V1',callback_id:'livo_qa_coordination',private_metadata:JSON.stringify({projectId:'p'})},value:'dev'} as QaSlackPayload,'e',d);expect(result).toMatchObject({options:[{value:'rd',text:{type:'plain_text',text:'Developer'}}]});expect(api).toHaveBeenCalledWith(expect.anything(),{action:'members',projectId:'p',search:'dev'});});
 it.each(['en','zh-CN','zh-TW'])('offers translated confirmation in %s',async language=>{const {d,actor,flush}=fixture();actor.locale=language;await handleQaSlack({command:'/livo',text:'bug request_handoff issue',trigger_id:'tr'},'e',d);await flush();const modal=vi.mocked(d.slack).mock.calls.at(-1)![1].view as {title:{text:string};blocks:Array<{text?:{type:string;text:string}}>};expect(modal.title.text).toBe(language==='en'?'Request handoff':language==='zh-CN'?'建立交接':'建立交接');expect(modal.blocks.filter(b=>b.text).every(b=>b.text?.type==='plain_text')).toBe(true);});
 it('feature off refuses submission before authorization or writes',async()=>{const {d,api}=fixture();vi.mocked(d.enabled).mockResolvedValue(false);expect(await handleQaSlack(submit('hold',values({reason:'Wait'})),'e',d)).toMatchObject({response_action:'update'});expect(api).not.toHaveBeenCalled();});

 it.each([2,1])('uses configured triage choices while retaining current priority %s',async priority=>{
  const {d,set,flush}=fixture(),issue={...seed(),priority};set(issue);const original=JSON.stringify(issue);
  d.displaySettings=vi.fn(async()=>({...defaultQaDisplaySettings(),showSeverity:false,hiddenPriorityChoices:[1,5]}));
  await handleQaSlack({command:'/livo',text:'bug triage issue',trigger_id:'trigger'},'display-open',d);await flush();
  const modal=vi.mocked(d.slack).mock.calls.at(-1)![1].view as {blocks:Array<{block_id?:string;element?:{options?:Array<{value:string}>;initial_option?:{value:string}}}>};
  expect(modal.blocks.some(block=>block.block_id==='severity')).toBe(false);
  const element=modal.blocks.find(block=>block.block_id==='priority')!.element!;
  expect(element.options!.map(option=>option.value)).toEqual(priority===1?['1','2','3','4']:['2','3','4']);expect(element.initial_option?.value).toBe(String(priority));
  expect(d.displaySettings).toHaveBeenCalledWith(expect.objectContaining({id:'coord'}));expect(JSON.stringify(issue)).toBe(original);expect(d.reply).not.toHaveBeenCalled();
 });
 it.each(['untriaged','low','high'] as const)('preserves fresh hidden severity %s and original CAS version',async severity=>{
  const {d,set,api,flush}=fixture(),issue={...seed(),severity,version:9};set(issue);const original=JSON.stringify(issue);
  d.displaySettings=vi.fn(async()=>({...defaultQaDisplaySettings(),showSeverity:false}));
  await handleQaSlack(submit('triage',values({rd:'rd',qa:'qa',priority:'3'}),{showSeverity:true,severity:'low'}),'display-submit',d);await flush();
  expect(api).toHaveBeenCalledWith(expect.objectContaining({id:'coord'}),expect.objectContaining({action:'command',expectedVersion:1,command:{type:'triage',assigneeId:'rd',qaOwnerId:'qa',severity,priority:3,dueDate:null}}));
  expect(d.displaySettings).toHaveBeenCalledTimes(1);expect(JSON.stringify(issue)).toBe(original);expect(d.reply).not.toHaveBeenCalled();
 });
 it('rereads configuration on submit and ignores stale severity input',async()=>{
  const {d,set,api,flush}=fixture();set({...seed(),severity:'high'});
  d.displaySettings=vi.fn(async()=>defaultQaDisplaySettings());
  await handleQaSlack({command:'/livo',text:'bug triage issue',trigger_id:'trigger'},'display-open',d);await flush();
  const opened=JSON.stringify(vi.mocked(d.slack).mock.calls.at(-1)![1].view);expect(opened).toContain('"block_id":"severity"');
  vi.mocked(d.displaySettings).mockResolvedValue({...defaultQaDisplaySettings(),showSeverity:false});
  await handleQaSlack(submit('triage',values({rd:'rd',qa:'qa',priority:'3',severity:'low'})),'display-submit',d);await flush();
  expect(d.displaySettings).toHaveBeenCalledTimes(2);
  expect(api).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({command:expect.objectContaining({type:'triage',severity:'high'})}));
 });
 it('does not trust metadata to hide a freshly required severity field',async()=>{
  const {d,api,flush}=fixture();d.displaySettings=vi.fn(async()=>defaultQaDisplaySettings());
  expect(await handleQaSlack(submit('triage',values({rd:'rd',qa:'qa',priority:'3'}),{showSeverity:false}),'forged-setting',d)).toMatchObject({response_action:'update'});
  await flush();expect(api.mock.calls.filter(call=>call[1].action==='command')).toHaveLength(0);
  expect(JSON.stringify(vi.mocked(d.slack).mock.calls.at(-1)![1].view)).toContain('Unable to complete');expect(d.reply).not.toHaveBeenCalled();
 });
 it.each(['open','submit'])('does not fall back to defaults after a display-setting failure on %s',async phase=>{
  const {d,api,flush}=fixture();d.displaySettings=vi.fn(async()=>{throw new Error('private-setting-error');});
  const payload=phase==='open'?{command:'/livo',text:'bug triage issue',trigger_id:'trigger'}:submit('triage',values({rd:'rd',qa:'qa',severity:'high',priority:'2'}));
  await handleQaSlack(payload,'display-failure',d);await flush();
  expect(api.mock.calls.filter(call=>call[1].action==='command')).toHaveLength(0);
  const shown=JSON.stringify(vi.mocked(d.slack).mock.calls.at(-1)![1].view);
  expect(shown).not.toContain('private-setting-error');expect(shown).not.toContain('"block_id":"severity"');expect(d.reply).not.toHaveBeenCalled();
 });

});
