import { describe, expect, it, vi } from 'vitest';
import { handleInteraction, type Actions } from '../../docker/volumes/functions/slack-interact/handler';
import { applyQaCommand, createQaIssue, type QaIssue } from '../lib/qa/domain';
import { drainQaSlackInbox, handleQaSlack, isQaSlackPayload, parseQaSlackCommand, qaMessageIntent, qaRequestId, type QaSlackActions, type QaSlackPayload } from '../lib/qa/slack';

const issue = (): QaIssue => ({ ...createQaIssue({projectId:'p',title:'Bug',actual:'Broken',observedEnvironment:'Stage'},'bug-a',{
  actor:{id:'reporter',role:'member'},workspaceId:'default',now:'2026-10-02T00:00:00Z',newId:()=> 'x',memberIds:new Set(['reporter']),projectIds:new Set(['p']),taskIds:new Set(),
}), assigneeId:'rd',qaOwnerId:'qa',state:'verification',version:4,fixCycle:1,
targets:[{id:'t',environment:'Stage',component:'Web',build:'v4',required:true,deployedAt:'now',deployedBy:'rd',deploymentEvidence:'ok'}] });
function harness() {
  const work: Promise<unknown>[] = [];
  const api = vi.fn(async (_actor, body) => body.action === 'get' ? {issue:issue(),comments:[],events:[],attachments:[]} : body.action === 'create' ? {...issue(),id:body.id} : issue());
  const d: QaSlackActions = {
    enabled:vi.fn(async()=>true),actor:vi.fn(async()=>({id:'qa',role:'member',team:'T1',slack_user:'U1'})),api:api as QaSlackActions['api'],
    environments:vi.fn(async()=>['Dev','QA','Stage','Live Staging','Prod']),projects:vi.fn(async()=>[{line:{id:'l',name:'Line'},projects:[{id:'p',name:'Project',lineId:'l'}]}]),mapped:vi.fn(async()=> 'bug-a'),publish:vi.fn(async()=>{}),sync:vi.fn(async()=>{}),
    claimNotice:vi.fn(async()=>true),slack:vi.fn(async()=>({view:{id:'V1'},permalink:'https://slack.example/message'})),reply:vi.fn(async()=>{}),background:p=>work.push(p),link:()=> 'https://livo.example/?qa=bug-a',
    enqueueEvent:vi.fn(async()=> 'event-1'),completeEvent:vi.fn(async()=>{}),pendingEvents:vi.fn(async()=>[]),
  };
  return {d,api,flush:()=>Promise.all(work)};
}
const event = (text:string):QaSlackPayload => ({type:'event_callback',team_id:'T1',event:{type:'message',user:'U1',channel:'C1',thread_ts:'100.1',ts:'101.1',text}});
describe('QA Slack automation',()=>{
  it('loads the configured catalog for creation and repair, without offering historic values',async()=>{
    const {d,flush}=harness();vi.mocked(d.environments).mockResolvedValue(['Preview','Production']);
    await handleQaSlack({command:'/livo',text:'bug new',trigger_id:'tr'},'new-env',d);await flush();
    expect(d.slack).toHaveBeenCalledWith('views.update',expect.objectContaining({view:expect.objectContaining({blocks:expect.arrayContaining([
      expect.objectContaining({block_id:'environment',element:expect.objectContaining({type:'static_select',options:[{text:{type:'plain_text',text:'Preview'},value:'Preview'},{text:{type:'plain_text',text:'Production'},value:'Production'}]})}),
    ])})}));
    vi.mocked(d.actor).mockResolvedValue({id:'rd',role:'member',team:'T1',slack_user:'U2'});
    await handleQaSlack({command:'/livo',text:'bug fix bug-a',trigger_id:'tr'},'fix-env',d);await flush();
    expect(d.slack).toHaveBeenLastCalledWith('views.update',expect.objectContaining({view:expect.objectContaining({blocks:expect.arrayContaining([
      expect.objectContaining({block_id:'environment',element:expect.objectContaining({type:'multi_static_select',options:expect.arrayContaining([expect.objectContaining({value:'Preview'})])})}),
    ])})}));
    const fixView=vi.mocked(d.slack).mock.calls.at(-1)?.[1];
    expect(JSON.stringify(fixView)).not.toContain('"value":"Stage"');
  });
  it.each(['multi','legacy'] as const)('accepts configured repair environments from %s submissions',async mode=>{
    const {d,api,flush}=harness();vi.mocked(d.environments).mockResolvedValue(['Preview','Production']);
    const values={note:{note:{value:'fixed'}},build:{build:{value:'v5'}},environment:{environment:mode==='multi'?{selected_options:[{value:'Preview'},{value:'Production'}]}:{value:'Preview, Production'}}};
    await handleQaSlack({type:'view_submission',view:{id:'V1',callback_id:'livo_qa_submit',private_metadata:JSON.stringify({intent:'fix',issueId:'bug-a',version:4}),state:{values}}},'env-submit',d);await flush();
    expect(api).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({action:'command',command:expect.objectContaining({type:'submit_fix',targets:[{environment:'Preview',component:'',build:'v5',required:true},{environment:'Production',component:'',build:'v5',required:true}]})}));
  });
  it('rejects stale or forged environment choices before a write',async()=>{
    const {d,api,flush}=harness();vi.mocked(d.environments).mockResolvedValue(['Preview']);
    await handleQaSlack({type:'view_submission',view:{id:'V1',callback_id:'livo_qa_submit',private_metadata:JSON.stringify({intent:'fix',issueId:'bug-a',version:4}),state:{values:{note:{note:{value:'fixed'}},build:{build:{value:'v5'}},environment:{environment:{selected_options:[{value:'arbitrary'}]}}}}}},'bad-env',d);await flush();
    expect(api).not.toHaveBeenCalled();
    expect(d.slack).toHaveBeenCalledWith('views.update',expect.objectContaining({view:expect.objectContaining({blocks:expect.arrayContaining([expect.objectContaining({text:expect.objectContaining({text:expect.stringContaining('部署環境清單已更新')})})])})}));
  });
  it('uses the shared project groups for suggestions and preserves initial project IDs',async()=>{
    const {d,flush}=harness();
    expect(await handleQaSlack({type:'block_suggestion'},'suggestion',d)).toEqual({option_groups:[{
      label:{type:'plain_text',text:'Line'},options:[{text:{type:'plain_text',text:'Project'},value:'p'}],
    }]});
    await handleQaSlack({command:'/livo',text:'bug new',trigger_id:'tr'},'new',d);await flush();
    expect(d.slack).toHaveBeenCalledWith('views.update',expect.objectContaining({view:expect.objectContaining({blocks:expect.arrayContaining([
      expect.objectContaining({block_id:'project',element:expect.objectContaining({initial_option:expect.objectContaining({value:'p'})})}),
    ])})}));
    vi.mocked(d.projects).mockResolvedValue([]);
    expect(await handleQaSlack({type:'block_suggestion'},'empty',d)).toEqual({options:[]});
  });
  it.each([
    {command:'/livo',text:'bug new Wallet',trigger_id:'tr'},
    event('Follow-up'),
  ])('keeps QA routing ahead of task workspace routing',async payload=>{
    const {d,api,flush}=harness();const taskEnabled=vi.fn(async()=>true);
    const actions={qa:d,enabled:taskEnabled} as unknown as Actions;
    await handleInteraction(payload,'envelope',actions);await flush();
    expect(taskEnabled).not.toHaveBeenCalled();
    if ('command' in payload) expect(d.slack).toHaveBeenCalledWith('views.open',expect.anything());
    else expect(api).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({action:'comment'}));
  });
  it('records private Slack file permalinks without fetching or exposing the binary',async()=>{
    const {d,api,flush}=harness();const payload=event('');payload.event!.subtype='file_share';payload.event!.files=[{name:'bug.mp4',permalink:'https://files.slack.com/private/file'}];
    await handleQaSlack(payload,'e',d);await flush();expect(api).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({action:'comment',body:expect.stringContaining('https://files.slack.com/private/file')}));
  });
  it('does not ACK an event whose durable enqueue failed',async()=>{
    const {d}=harness();vi.mocked(d.enqueueEvent).mockRejectedValue(new Error('offline'));
    await expect(handleQaSlack(event('PASS'),'e',d)).rejects.toThrow('offline');expect(d.completeEvent).not.toHaveBeenCalled();
  });
  it('retries a persisted event without enqueueing it again',async()=>{
    const {d,api}=harness();vi.mocked(d.pendingEvents).mockResolvedValue([{id:'queued-1',payload:event('Follow-up')}]);
    await drainQaSlackInbox(d);expect(d.enqueueEvent).not.toHaveBeenCalled();expect(api).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({action:'comment'}));expect(d.completeEvent).toHaveBeenCalledWith('queued-1');
  });
  it('ACKs slash commands while identity lookup is still pending',async()=>{
    const {d,flush}=harness();let release!: (value:any)=>void;
    vi.mocked(d.actor).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
    const result=await handleQaSlack({command:'/livo',text:'bug new',trigger_id:'tr'},'e',d);
    expect(result).toEqual({});expect(d.projects).not.toHaveBeenCalled();
    release({id:'qa',role:'member',team:'T1',slack_user:'U1'});await flush();
  });
  it('routes QA while leaving normal task commands alone',()=>{
    expect(isQaSlackPayload({command:'/livo',text:'bug new Wallet'})).toBe(true);
    expect(isQaSlackPayload({command:'/livo',text:'new Wallet'})).toBe(false);
    expect(parseQaSlackCommand('bug fix bug-a rounding')).toEqual({intent:'fix',issueId:'bug-a',value:'rounding'});
  });
  it('matches only bounded positive intent and distinguishes RD from QA',()=>{
    expect(qaMessageIntent('已修正',issue(),{id:'rd',role:'member'})).toBe('fix');
    expect(qaMessageIntent('已修正',issue(),{id:'qa',role:'member'})).toBe('pass');
    for(const text of ['尚未修正','不是已修正','PASS? 還要再測','昨天已修正但今天又壞了']) expect(qaMessageIntent(text,issue(),{id:'qa',role:'member'})).toBeUndefined();
  });
  it('disabled QA performs no writes or actor lookups',async()=>{
    const {d,api,flush}=harness();vi.mocked(d.enabled).mockResolvedValue(false);
    await handleQaSlack(event('PASS'),'e',d);await flush();expect(api).not.toHaveBeenCalled();expect(d.actor).not.toHaveBeenCalled();
  });
  it('ignores bots, edits and unrelated unbound threads',async()=>{
    const {d,api,flush}=harness();const p=event('PASS');p.event!.bot_id='B1';
    await handleQaSlack(p,'e',d);expect(d.actor).not.toHaveBeenCalled();
    vi.mocked(d.mapped).mockResolvedValue(undefined);await handleQaSlack(event('PASS'),'e2',d);await flush();expect(api).not.toHaveBeenCalled();
  });
  it('mirrors a thread reply with stable idempotency and prompts for target, never guesses a PASS',async()=>{
    const {d,api,flush}=harness();await handleQaSlack(event('已修正'),'e',d);await flush();
    expect(api.mock.calls.map(call=>call[1].action)).toEqual(['get','comment']);
    const comment=api.mock.calls[1][1];expect(comment.id).toBe('bug-a');expect(comment.commandId).toBe(await qaRequestId('T1:C1:101.1'));
    expect(d.slack).toHaveBeenCalledWith('chat.postEphemeral',expect.objectContaining({channel:'C1',user:'U1',thread_ts:'100.1'}));
  });
  it('rejects malformed modal input before scheduling a write',async()=>{
    const {d,api,flush}=harness();const result=await handleQaSlack({type:'view_submission',view:{id:'V1',callback_id:'livo_qa_submit',private_metadata:JSON.stringify({intent:'new'}),state:{values:{}}}},'e',d);
    await flush();expect(result.response_action).toBe('errors');expect(api).not.toHaveBeenCalled();
  });
  it('submits selected environment and displayed version through the same command API',async()=>{
    const {d,api,flush}=harness();const result=await handleQaSlack({type:'view_submission',team_id:'T1',user_id:'U1',view:{id:'V1',callback_id:'livo_qa_submit',private_metadata:JSON.stringify({intent:'pass',issueId:'bug-a',version:4,team:'T1',channel:'C1'}),state:{values:{target:{target:{selected_option:{value:'t'}}}}}}},'e',d);
    expect(result.response_action).toBe('update');await flush();expect(api).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({action:'command',id:'bug-a',expectedVersion:4,command:{type:'record_verification',targetId:'t',build:'v4',result:'pass',note:''}}));
  });
  it('offers an unchecked required confirmation and reason for a historical PASS close',async()=>{
    const {d,api,flush}=harness();
    const historical:QaIssue={...issue(),state:'verified' as const,fixCycle:0,targets:[],runs:[],legacySource:{system:'slack_list',originalStatus:'PASS',recordId:'RecHISTORY123',snapshotSha256:'a'.repeat(64)}};
    api.mockResolvedValue({issue:historical,comments:[],events:[],attachments:[]} as never);
    await handleQaSlack({command:'/livo',text:'bug close bug-a',trigger_id:'tr'},'historical-open',d);await flush();
    const view=vi.mocked(d.slack).mock.calls.find(call=>call[0]==='views.update')?.[1].view as {blocks:Array<{block_id?:string;optional?:boolean;element?:{type:string;initial_options?:unknown}}>};
    const confirmation=view.blocks.find(block=>block.block_id==='historical_pass');
    expect(confirmation?.optional).toBe(false);expect(confirmation?.element?.type).toBe('checkboxes');expect(confirmation?.element).not.toHaveProperty('initial_options');
    expect(view.blocks.find(block=>block.block_id==='note')?.optional).toBe(false);
  });
  it.each([{checked:false,note:'Reviewed'},{checked:true,note:''}])('requires explicit historical confirmation and a reason: $checked/$note',async({checked,note})=>{
    const {d,api,flush}=harness();
    const response=await handleQaSlack({type:'view_submission',view:{id:'V1',callback_id:'livo_qa_submit',private_metadata:JSON.stringify({intent:'close',issueId:'bug-a',version:4}),state:{values:{historical_pass:{historical_pass:{selected_options:checked?[{value:'acknowledge'}]:[]}},note:{note:{value:note}}}}}},'history-required',d);
    await flush();expect(response.response_action).toBe('errors');expect(api).not.toHaveBeenCalled();
  });
  it('submits an acknowledged historical close through the real domain guard without inventing verification',async()=>{
    const {d,api,flush}=harness();
    const historical:QaIssue={...issue(),state:'verified' as const,fixCycle:0,targets:[],runs:[],legacySource:{system:'slack_list',originalStatus:'PASS',recordId:'RecHISTORY123',snapshotSha256:'a'.repeat(64)}};
    api.mockImplementation(async(actor,body)=>body.action==='get'?{issue:historical,comments:[],events:[],attachments:[]}:applyQaCommand(historical,body.command,{actor,workspaceId:'default',now:'2026-10-03T00:00:00Z',newId:()=> 'unused',memberIds:new Set(['qa','rd','reporter']),projectIds:new Set(['p']),taskIds:new Set<string>()}));
    await handleQaSlack({type:'view_submission',view:{id:'V1',callback_id:'livo_qa_submit',private_metadata:JSON.stringify({intent:'close',issueId:'bug-a',version:4,channel:'C1'}),state:{values:{historical_pass:{historical_pass:{selected_options:[{value:'acknowledge'}]}},note:{note:{value:'Reviewed the original evidence'}}}}}},'historical-close',d);await flush();
    expect(api).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({action:'command',expectedVersion:4,command:{type:'close',resolution:'fixed',reason:'Reviewed the original evidence',acknowledgeHistoricalPass:true}}));
    expect(d.sync).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({state:'closed',fixCycle:0,targets:[],runs:[]}));
  });
  it.each(['missing-checkbox','changed-source'] as const)('rechecks trusted evidence on historical submission: %s',async mode=>{
    const {d,api,flush}=harness();
    const historical:QaIssue={...issue(),state:'verified' as const,fixCycle:0,targets:[],runs:[],legacySource:{system:'slack_list',originalStatus:mode==='changed-source'?'FAIL':'PASS',recordId:'RecHISTORY123',snapshotSha256:'a'.repeat(64)}};
    api.mockResolvedValue({issue:historical,comments:[],events:[],attachments:[]} as never);
    await handleQaSlack({type:'view_submission',view:{id:'V1',callback_id:'livo_qa_submit',private_metadata:JSON.stringify({intent:'close',issueId:'bug-a',version:4}),state:{values:{note:{note:{value:'Reviewed'}},...(mode==='changed-source'?{historical_pass:{historical_pass:{selected_options:[{value:'acknowledge'}]}}}:{})}}}},'historical-recheck',d);await flush();
    expect(api.mock.calls.map(call=>call[1].action)).toEqual(['get']);expect(d.sync).not.toHaveBeenCalled();
  });
  it('keeps the normal live close command free of historical acknowledgement',async()=>{
    const {d,api,flush}=harness();
    await handleQaSlack({type:'view_submission',view:{id:'V1',callback_id:'livo_qa_submit',private_metadata:JSON.stringify({intent:'close',issueId:'bug-a',version:4}),state:{values:{note:{note:{value:'Reviewed'}}}}}},'normal-close',d);await flush();
    expect(api).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({action:'command',command:{type:'close',resolution:'fixed',reason:'Reviewed'}}));
  });
  it('reports a committed update as saved even when Slack card refresh fails',async()=>{
    const {d,flush}=harness();vi.mocked(d.sync).mockRejectedValue(new Error('Slack offline'));
    await handleQaSlack({type:'view_submission',team_id:'T1',user_id:'U1',view:{id:'V1',callback_id:'livo_qa_submit',private_metadata:JSON.stringify({intent:'comment',issueId:'bug-a',version:4,team:'T1',channel:'C1'}),state:{values:{note:{note:{value:'Follow up'}}}}}},'e',d);
    await flush();expect(d.reply).toHaveBeenCalledWith(expect.anything(),expect.stringContaining('LIVO 已儲存'));
  });
  it('retains source message and permalink on message shortcut',async()=>{
    const {d,flush}=harness();vi.mocked(d.mapped).mockResolvedValue(undefined);
    await handleQaSlack({type:'message_action',callback_id:'livo_qa_new',team:{id:'T1'},user:{id:'U1'},channel:{id:'C1'},trigger_id:'tr',message:{text:'Wallet mismatch',ts:'100.1'}},'e',d);
    await flush();expect(d.slack).toHaveBeenNthCalledWith(1,'views.open',expect.anything());
    const view=vi.mocked(d.slack).mock.calls.find(call=>call[0]==='views.update')![1].view;
    expect(JSON.stringify(view)).toContain('https://slack.example/message');expect(JSON.stringify(view)).toContain('Wallet mismatch');
  });
  it('card new button starts a fresh thread rather than cloning bot text',async()=>{
    const {d,flush}=harness();await handleQaSlack({type:'block_actions',trigger_id:'tr',team:{id:'T1'},user:{id:'U1'},channel:{id:'C1'},message:{text:'Bot card',ts:'100.1'},actions:[{action_id:'livo_qa_new',value:'bug-a'}]},'e',d);await flush();
    expect(d.mapped).not.toHaveBeenCalled();const view=vi.mocked(d.slack).mock.calls.find(call=>call[0]==='views.update')![1].view;
    expect(JSON.stringify(view)).not.toContain('Bot card');expect(JSON.stringify(view)).toContain('新增 QA Bug');
  });
});
