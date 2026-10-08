import { describe, expect, it, vi } from 'vitest';
import { createQaIssue, type QaIssue } from '../lib/qa/domain';
import { DEFAULT_QA_WORKFLOW } from '../lib/qa/workflow';
import { defaultQaDisplaySettings } from '../lib/qa/displaySettings';
import { handleQaSlack, isQaSlackPayload, parseQaSlackCommand, type QaSlackActions, type QaSlackActor, type QaSlackPayload, type SlackBlock } from '../lib/qa/slack';

const fixture = (): QaIssue => ({...createQaIssue({projectId:'project-1',title:'Synthetic bug',actual:'A visible failure',observedEnvironment:'Stage'},'issue-1',{
  actor:{id:'reporter',role:'member'},workspaceId:'default',now:'2026-10-03T00:00:00Z',newId:()=> 'id',memberIds:new Set(['reporter']),projectIds:new Set(['project-1']),taskIds:new Set(),
}),state:'triaged',assigneeId:'developer',qaOwnerId:'tester',steps:'Step one',expected:'Expected outcome'});
const actor: QaSlackActor = {id:'developer',role:'member',team:'T1',slack_user:'U1',locale:'en-US'};
function harness(locale = 'en-US') {
  const work: Promise<unknown>[]=[];
  const api=vi.fn(async (_actor:QaSlackActor,body:Record<string,unknown>):Promise<unknown> => body.action==='get_workflow' ? DEFAULT_QA_WORKFLOW
    : body.action==='get' ? {issue:fixture(),comments:[],events:[],attachments:[]} : {issues:[fixture()],total:21,hasMore:true});
  const d:QaSlackActions={
    enabled:vi.fn(async()=>true),actor:vi.fn(async()=>({...actor,locale})),api:api as QaSlackActions['api'],
    projects:vi.fn(async()=>[{line:{id:'line-1',name:'Product line'},projects:[{id:'project-1',name:'Project',lineId:'line-1'}]}]),
    environments:vi.fn(async()=>['Stage']),mapped:vi.fn(async()=>undefined),publish:vi.fn(async()=>{}),sync:vi.fn(async()=>{}),claimNotice:vi.fn(async()=>true),
    enqueueEvent:vi.fn(async()=>''),completeEvent:vi.fn(async()=>{}),pendingEvents:vi.fn(async()=>[]),
    slack:vi.fn(async()=>({view:{id:'V1'}})),reply:vi.fn(async()=>{}),background:promise=>work.push(promise),link:()=> 'https://livo.example/?qa=issue-1',
  };
  const flush=async()=>{await Promise.all(work.splice(0));};
  const lastView=()=>vi.mocked(d.slack).mock.calls.filter(call=>call[0]==='views.update').at(-1)?.[1].view as SlackBlock;
  return {d,api,flush,lastView};
}
const slash=(text:string):QaSlackPayload=>({command:'/livo',text,trigger_id:'trigger',team_id:'T1',user_id:'U1'});
const action=(view:SlackBlock,id:string,value=''):QaSlackPayload=>({type:'block_actions',trigger_id:'trigger',team:{id:'T1'},user:{id:'U1'},
  view:{id:'V1',callback_id:String(view.callback_id),private_metadata:String(view.private_metadata)},actions:[{action_id:id,value}]});

describe('private QA Slack workspace',()=>{
  it.each(['list','search','my','triage'])('reserves %s commands and routes home buttons',async mode=>{
    expect(parseQaSlackCommand(`bug ${mode} example`)).toEqual({intent:mode,issueId:'',value:'example'});
    const {d,api,flush,lastView}=harness();
    const payload:QaSlackPayload={type:'block_actions',trigger_id:'trigger',actions:[{action_id:`livo_qa_workspace_${mode}`} ]};
    expect(isQaSlackPayload(payload)).toBe(true);
    expect(await handleQaSlack(payload,'entry',d)).toEqual({}); await flush();
    const input=api.mock.calls.find(call=>call[1].action==='list')?.[1].input;
    expect(input).toEqual(expect.objectContaining({offset:0,limit:10,...(mode==='my'?{mine:'assigned'}:{}),...(mode==='triage'?{state:'new'}:{})}));
    expect(api.mock.calls.every(call=>['list','get_workflow'].includes(String(call[1].action)))).toBe(true);
    expect(d.publish).not.toHaveBeenCalled();expect(d.sync).not.toHaveBeenCalled();expect(d.reply).not.toHaveBeenCalled();
    expect(lastView().callback_id).toBe('livo_qa_workspace');
  });
  it.each([['en-US','Search titles','Assigned to me'],['zh-TW','搜尋標題','我負責修復'],['zh-CN','搜索标题','我负责修复']])('uses the verified member locale %s',async(locale,search,mine)=>{
    const {d,flush,lastView}=harness(locale);await handleQaSlack(slash('bug my'),'locale',d);await flush();
    expect(JSON.stringify(lastView())).toContain(search);expect(JSON.stringify(lastView())).toContain(mine);
  });
  it('ACKs immediately and opens an empty loading view before identity resolution',async()=>{
    const {d,api,flush,lastView}=harness();let release:((value:QaSlackActor)=>void) | undefined;
    vi.mocked(d.actor).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
    expect(await handleQaSlack(slash('bug list'),'slow',d)).toEqual({});
    expect(api).not.toHaveBeenCalled();expect(JSON.stringify(vi.mocked(d.slack).mock.calls)).not.toContain('Synthetic bug');
    release?.(actor);await flush();expect(JSON.stringify(lastView())).toContain('Synthetic bug');
  });
  it('revalidates identity for every page and preserves filters without trusting metadata actor or limit',async()=>{
    const {d,api,flush,lastView}=harness();await handleQaSlack(slash('bug search wallet'),'first',d);await flush();
    const first=lastView();const metadata=JSON.parse(String(first.private_metadata));
    const payload=action({...first,private_metadata:JSON.stringify({...metadata,mine:'testing',projectId:'archived-project',projectLabel:'Archived',actor:'other',limit:999})},'livo_qa_workspace_page','10');
    vi.mocked(d.actor).mockResolvedValue({...actor,id:'fresh-member'});
    await handleQaSlack(payload,'page',d);await flush();
    expect(d.actor).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenCalledWith(expect.objectContaining({id:'fresh-member'}),{action:'list',input:{offset:10,limit:10,search:'wallet',projectId:'archived-project',mine:'testing'}});
    const rendered=lastView(),last=JSON.stringify(rendered);expect(last).toContain('Previous');expect(last).toContain('Next');
    const actionBlocks=(rendered.blocks as SlackBlock[]).filter(block=>block.type==='actions');
    for(const block of actionBlocks){
      const ids=(block.elements as Array<{action_id?:string}>).map(element=>element.action_id).filter(Boolean);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const pageBlocks=actionBlocks.filter(block=>(block.elements as Array<{action_id?:string}>).some(element=>element.action_id==='livo_qa_workspace_page'));
    expect(pageBlocks).toHaveLength(2);
    expect(pageBlocks.map(block=>(block.elements as Array<{value:string}>).find(element=>element.value==='0'||element.value==='20')?.value)).toEqual(['0','20']);
  });
  it('applies modal filters, clears project selection and resets pagination',async()=>{
    const {d,api,flush,lastView}=harness();await handleQaSlack(slash('bug list'),'first',d);await flush();
    const page=action(lastView(),'livo_qa_workspace_page','10');await handleQaSlack(page,'page',d);await flush();
    const payload:QaSlackPayload={...action(lastView(),'unused'),type:'view_submission',actions:undefined};
    payload.view!.state={values:{qa_query:{qa_query:{value:'  fresh  '}},qa_state:{qa_state:{selected_option:{value:'verified'}}},qa_mine:{qa_mine:{selected_option:{value:'reported'}}},qa_project:{qa_project:{}}}};
    expect((await handleQaSlack(payload,'filter',d)).response_action).toBe('update');await flush();
    expect(api).toHaveBeenLastCalledWith(expect.anything(),{action:'list',input:{offset:0,limit:10,search:'fresh',mine:'reported',state:'verified'}});
  });
  it('offers archived projects only in read filters, grouped by the same product line helper',async()=>{
    const {d}=harness();const payload={type:'block_suggestion',value:'old',view:{id:'V1',callback_id:'livo_qa_workspace'}} as QaSlackPayload;
    const result=await handleQaSlack(payload,'suggest',d);
    expect(d.projects).toHaveBeenCalledWith(expect.objectContaining({id:'developer'}),'old',true);
    expect(result).toEqual({option_groups:[{label:{type:'plain_text',text:'Product line'},options:[{text:{type:'plain_text',text:'Project'},value:'project-1'}]}]});
  });
  it.each(['member','admin','super_admin'])('passes %s identity through the existing API on read-only routes',async role=>{
    const {d,api,flush}=harness();vi.mocked(d.actor).mockResolvedValue({...actor,role});
    await handleQaSlack(slash('bug list'),'role',d);await flush();
    expect(api).toHaveBeenCalledWith(expect.objectContaining({id:'developer',role}),expect.objectContaining({action:'list'}));
    expect(api.mock.calls.every(call=>['list','get_workflow'].includes(String(call[1].action)))).toBe(true);
  });
  it.each(['feature-off','inactive','API-revoked'])('fails closed for %s without publishing any result',async mode=>{
    const {d,api,flush,lastView}=harness();
    if(mode==='feature-off')vi.mocked(d.enabled).mockResolvedValue(false);
    else if(mode==='inactive')vi.mocked(d.actor).mockRejectedValue(new Error('private-account-data'));
    else api.mockRejectedValue(new Error('private-backend-data'));
    await handleQaSlack(slash('bug list'),'deny',d);await flush();
    if(mode==='feature-off')expect(d.actor).not.toHaveBeenCalled();
    if(mode!=='API-revoked')expect(api).not.toHaveBeenCalled();
    expect(JSON.stringify(lastView() || {})).not.toContain('Synthetic bug');expect(JSON.stringify(lastView() || {})).not.toContain('private-');
    expect(d.publish).not.toHaveBeenCalled();
  });
  it.each(['-10','100001','NaN','1.5'])('rejects forged page offset %s before querying',async offset=>{
    const {d,api,flush,lastView}=harness();await handleQaSlack(slash('bug list'),'first',d);await flush();api.mockClear();
    await handleQaSlack(action(lastView(),'livo_qa_workspace_page',offset),'bad-page',d);await flush();
    expect(api).not.toHaveBeenCalled();expect(JSON.stringify(lastView())).toContain('filters are no longer valid');
  });
  it('shows complete issue text privately and only permitted existing action buttons',async()=>{
    const {d,api,flush,lastView}=harness();await handleQaSlack(slash('bug list'),'first',d);await flush();
    const long=fixture();long.actual='<@U2> ' + 'a'.repeat(6100);long.expected='End of expected';
    api.mockImplementation(async(_actor,body)=>body.action==='get' ? {issue:long,comments:[],events:[],attachments:[]} : DEFAULT_QA_WORKFLOW);
    await handleQaSlack(action(lastView(),'livo_qa_workspace_detail','issue-1'),'detail',d);await flush();
    const detail=lastView();const blocks=detail.blocks as SlackBlock[];
    const strings=blocks.map(block=>(block.text as {text?:string})?.text || '');
    expect(strings.join('')).toContain(long.actual);expect(strings).toContain('End of expected');
    expect(blocks[0]).toMatchObject({text:{type:'mrkdwn',text:expect.stringContaining('Current state')}});
    // Only the escaped state heading uses formatting; all user-authored bodies stay plain text.
    expect(blocks.slice(1).every(block=>!block.text || (block.text as {type:string}).type==='plain_text')).toBe(true);
    expect(JSON.stringify(detail)).toContain('livo_qa_fix');expect(JSON.stringify(detail)).not.toContain('livo_qa_close');
    expect(d.publish).not.toHaveBeenCalled();expect(d.reply).not.toHaveBeenCalled();
    // Existing mutations must escape the read router even when clicked inside its modal.
    await handleQaSlack(action(detail,'livo_qa_fix','issue-1'),'fix',d);await flush();
    expect(lastView().callback_id).toBe('livo_qa_submit');
    expect(vi.mocked(d.slack).mock.calls.filter(call=>call[0]==='views.open')).toHaveLength(1);
  });
  it('uses configured state labels while retaining canonical filters and no false next page',async()=>{
    const {d,api,flush,lastView}=harness();
    api.mockImplementation(async(_actor,body)=>body.action==='get_workflow' ? {...DEFAULT_QA_WORKFLOW,labels:{...DEFAULT_QA_WORKFLOW.labels,triaged:'Ready'}} : {issues:[fixture()],total:1,hasMore:false});
    await handleQaSlack(slash('bug triage'),'triage',d);await flush();
    expect(JSON.stringify(lastView())).toContain('Ready');expect(JSON.stringify(lastView())).not.toContain('livo_qa_workspace_page');
    expect(api).toHaveBeenCalledWith(expect.anything(),{action:'list',input:{offset:0,limit:10,state:'new'}});
  });

  it.each(['en-US','zh-TW','zh-CN'])('hides severity in list and detail using fresh display settings for %s',async locale=>{
    const {d,flush,lastView}=harness(locale);
    d.displaySettings=vi.fn(async()=>({...defaultQaDisplaySettings(),showSeverity:false}));
    await handleQaSlack(slash('bug list'),'display-list',d);await flush();
    const list=lastView(),row=(list.blocks as SlackBlock[]).find(block=>(block.text as {text?:string})?.text?.startsWith('Synthetic bug\n'));
    expect((row?.text as {text:string}).text).not.toContain(locale==='en-US'?'Untriaged':'待判定');
    await handleQaSlack(action(list,'livo_qa_workspace_detail','issue-1'),'display-detail',d);await flush();
    const body=JSON.stringify(lastView());
    expect(body).not.toContain(locale==='en-US'?'Untriaged':'待判定');expect(body).toContain('A visible failure');expect(body).toContain('Stage');
    expect(d.displaySettings).toHaveBeenCalledTimes(2);expect(d.publish).not.toHaveBeenCalled();expect(d.reply).not.toHaveBeenCalled();
  });
  it('reloads display settings for page and detail instead of trusting private metadata',async()=>{
    const {d,flush,lastView}=harness();
    d.displaySettings=vi.fn(async()=>({...defaultQaDisplaySettings(),showSeverity:false}));
    await handleQaSlack(slash('bug list'),'display-first',d);await flush();const first=lastView();
    vi.mocked(d.displaySettings).mockResolvedValue({...defaultQaDisplaySettings(),showSeverity:true});
    const forged={...first,private_metadata:JSON.stringify({...JSON.parse(String(first.private_metadata)),showSeverity:false})};
    vi.mocked(d.actor).mockResolvedValue({...actor,id:'fresh-member'});
    await handleQaSlack(action(forged,'livo_qa_workspace_page','10'),'display-page',d);await flush();
    expect(JSON.stringify(lastView())).toContain('Untriaged');
    vi.mocked(d.displaySettings).mockResolvedValue({...defaultQaDisplaySettings(),showSeverity:false});
    await handleQaSlack(action(lastView(),'livo_qa_workspace_detail','issue-1'),'display-detail',d);await flush();
    expect(JSON.stringify(lastView())).not.toContain('Untriaged');expect(d.displaySettings).toHaveBeenCalledTimes(3);
    expect(d.displaySettings).toHaveBeenLastCalledWith(expect.objectContaining({id:'fresh-member'}));
  });
  it.each(['transport-error','invalid-setting'])('fails closed when display settings produce %s',async failure=>{
    const {d,api,flush,lastView}=harness();
    d.displaySettings=vi.fn(async()=>{
      if(failure==='transport-error')throw new Error('private-settings-error');
      return {version:1,showSeverity:'bad',hiddenPriorityChoices:[],hiddenBoardStates:[]} as never;
    });
    await handleQaSlack(slash('bug list'),'display-failed',d);await flush();
    const rendered=JSON.stringify(lastView());
    expect(rendered).toContain('QA could not be loaded');expect(rendered).not.toContain('Synthetic bug');expect(rendered).not.toContain('private-settings-error');
    expect(api.mock.calls.every(call=>['list','get_workflow'].includes(String(call[1].action)))).toBe(true);
    expect(d.publish).not.toHaveBeenCalled();expect(d.reply).not.toHaveBeenCalled();
  });

});
