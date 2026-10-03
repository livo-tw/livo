// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
import {parseKnowledgeWorkCommand,parseKnowledgeWorkQuery,parseKnowledgeDraftPreview,KnowledgeWorkError,knowledgeDraftHtml} from '../../src/lib/knowledgeWork/core';
import {createKnowledgeWorkClient} from '../../src/lib/knowledgeWork/client';
import {assertKnowledgeRestoreSafe,KNOWLEDGE_RESTORE_TABLES} from '../../src/lib/knowledgeWork/restoreGuard';
import {knowledgeWorkHandler} from '../../docker/volumes/functions/knowledge-work/index';
import {handleKnowledgeWork} from '../../docker/volumes/functions/slack-interact/knowledge-work-handler';
import {createKnowledgeWorkData} from '../../docker/volumes/functions/slack-interact/knowledge-work-backend';
const metadata={documentKind:'specification',ownerId:'member',applicability:{productVersion:null,environment:null,summary:null}};
const page={pageId:'page',pageVersion:7,title:'Synthetic private specification',body:'<p>Private draft</p>',projectId:null,parentId:null,privateDraftOwnerId:'member',metadata,publication:null,links:[],linkItems:[],canEdit:true,canShare:true};
const preview={kind:'meeting',title:'Draft',text:'A proposal, not a decision',sourceRefs:[],period:null,coverage:{complete:true,sources:0,unavailable:0,limitations:['selected_sources_only']},previewFingerprint:'[]'};
const intent={operation:'publish',pageId:'page',expectedVersion:7,expectedPublicationId:null,confirmed:true};
describe('knowledge boundary and client',()=>{
 it.each(['actorId','workspaceId','role','mutations'])('rejects caller supplied %s',key=>expect(()=>parseKnowledgeWorkCommand({...intent,commandId:'command-test',[key]:'forged'})).toThrow());
 it('requires explicit sharing and publication confirmation',()=>{expect(()=>parseKnowledgeWorkCommand({...intent,commandId:'command-test',confirmed:false})).toThrow();expect(()=>parseKnowledgeWorkCommand({operation:'share_draft',commandId:'command-test',pageId:'page',expectedVersion:7,projectId:null,parentId:null,confirmed:false})).toThrow();});
 it('rejects incomplete draft saving while allowing safe partial preview wire data',async()=>{
  const partial={...preview,coverage:{...preview.coverage,complete:false,unavailable:1}};
  expect(()=>parseKnowledgeDraftPreview(partial)).toThrow();
  const client=createKnowledgeWorkClient({functions:{invoke:vi.fn(async()=>({data:partial,error:null}))}});
  expect((await client.prepare({kind:'meeting',notes:'',sourceRefs:[]})).coverage.complete).toBe(false);
  expect(()=>client.save({preview:partial,title:'Draft',text:'Draft',confirmed:true})).toThrow();
 });
 it.each([null,{},['not-a-row']])('rejects malformed detail response safely',async data=>{
  const client=createKnowledgeWorkClient({functions:{invoke:vi.fn(async()=>({data,error:null}))}});await expect(client.get('page')).rejects.toThrow(/knowledge_(transport_error|unavailable)/);
 });
 it('coalesces clicks, retries the same command ID after uncertain transport, and strips no actor into body',async()=>{
  const calls=[];let fail=true;const db={functions:{invoke:vi.fn(async(_name,{body})=>{calls.push(body);if(fail)throw new Error('network');return {data:{commandId:body.command.commandId,eventId:'event',replayed:true,page},error:null};})}};
  const client=createKnowledgeWorkClient(db);const first=client.command(intent),same=client.command(intent);expect(first).toBe(same);await expect(first).rejects.toThrow('knowledge_transport_error');fail=false;
  expect((await client.command(intent)).replayed).toBe(true);expect(new Set(calls.map(x=>x.command.commandId)).size).toBe(1);expect(calls).toHaveLength(3);expect(calls[0].command).not.toHaveProperty('actorId');
 });
 it('escapes literal draft text and rejects year zero',()=>{expect(knowledgeDraftHtml('<script>x</script>')).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>');expect(()=>parseKnowledgeWorkQuery({operation:'prepare_draft',input:{kind:'weekly',notes:'',sourceRefs:[],period:{from:'0000-01-01',to:'0000-01-02'}}})).toThrow();});
 it.each([null,{},'invalid'])('restore known non-array KB key fails closed',value=>expect(()=>assertKnowledgeRestoreSafe({kb_pages:value})).toThrow('knowledge_requires_server_restore'));
 it('restore requires a complete, empty authoritative live inventory',()=>{expect(()=>assertKnowledgeRestoreSafe({},{})).toThrow();expect(()=>assertKnowledgeRestoreSafe({},Object.fromEntries(KNOWLEDGE_RESTORE_TABLES.map(k=>[k,[]])))).not.toThrow();});
});

const authId='10000000-0000-0000-0000-000000000001';
const token=(claims={})=>'e30.'+Buffer.from(JSON.stringify({sub:authId,...claims})).toString('base64url')+'.verified-by-gotrue';
const snapshot={generation:1,workspaceId:'default',authId,tables:{members:[{id:'member',auth_id:authId,is_active:true,role:'member'}],kb_pages:[{id:'page',title:'Shared',body:'body',version:1,access_policy:{mode:'inherit'},private_draft_owner_id:null,document_metadata:metadata,project_id:null,parent_id:null}]}};
function httpSetup(options={}){
 const seen=[];const fetcher=vi.fn(async(url,init)=>{seen.push({url,init});if(url.endsWith('/auth/v1/user'))return Response.json(options.auth||{id:authId},{status:options.authStatus||200});if(options.rpcError)return Response.json(options.rpcError,{status:400});return Response.json(snapshot);});
 const env={get:k=>({SUPABASE_URL:'https://db.example.com',SUPABASE_ANON_KEY:'anon',SUPABASE_SERVICE_ROLE_KEY:'service'})[k]};return {seen,fetcher,handler:knowledgeWorkHandler(env,fetcher)};
}
const httpRequest=(jwt=token(),body={type:'query',query:{operation:'detail',pageId:'page'}})=>new Request('https://app.example.com/functions/v1/knowledge-work',{method:'POST',headers:{authorization:'Bearer '+jwt,'content-type':'application/json'},body:JSON.stringify(body)});
describe('GoTrue verified knowledge HTTP adapter',()=>{
 it('verifies GoTrue before using service RPC, carrying only verified auth and complete Slack identity',async()=>{
  const f=httpSetup();const response=await f.handler(httpRequest(token({livo_slack_binding:'binding',livo_slack_team:'TTEST',livo_slack_user:'UTEST'})));expect(response.status).toBe(200);
  expect(f.seen[0].url).toContain('/auth/v1/user');expect(JSON.parse(f.seen[1].init.body)).toMatchObject({p_auth_id:authId,p_slack_identity:{bindingId:'binding',teamId:'TTEST',userId:'UTEST'}});
 });
 it.each([{livo_slack_binding:'binding'},{livo_slack_team:'TTEST'},{livo_slack_user:'UTEST'}])('rejects incomplete signed Slack claims instead of app fallback',async claims=>{const f=httpSetup();expect((await f.handler(httpRequest(token(claims)))).status).toBe(401);expect(f.seen).toHaveLength(1);});
 it('GoTrue failure and service tokens never reach the privileged RPC',async()=>{const f=httpSetup({authStatus:401});expect((await f.handler(httpRequest())).status).toBe(401);expect(f.seen).toHaveLength(1);const g=httpSetup();expect((await g.handler(httpRequest('service'))).status).toBe(401);expect(g.seen).toHaveLength(0);});
 it('ordinary verified app tokens use null Slack identity, body identity is rejected',async()=>{const f=httpSetup();expect((await f.handler(httpRequest())).status).toBe(200);expect(JSON.parse(f.seen[1].init.body).p_slack_identity).toBe(null);expect((await f.handler(httpRequest(token(),{type:'query',query:{operation:'detail',pageId:'page'},actorId:'forged'}))).status).toBe(400);});
 it('SQL errors cannot leak through response',async()=>{const f=httpSetup({rpcError:{message:'SELECT private body or token',code:'XX000'}});const response=await f.handler(httpRequest());expect(await response.json()).toEqual({error:'knowledge_unavailable'});});
 it('receipt lookup passes the exact requested command ID to a live authorized snapshot',async()=>{const f=httpSetup();const response=await f.handler(httpRequest(token(),{type:'query',query:{operation:'command_result',commandId:'prior-command'}}));expect(await response.json()).toEqual({found:false});expect(JSON.parse(f.seen[1].init.body).p_command_id).toBe('prior-command');});
});

function slackSetup(){
 const work=[],calls=[];let actor={id:'member',binding_id:'binding',team:'TTEST',slack_user:'UTEST',jwt:'verified',locale:'en'},currentPage=structuredClone(page),fail=false;
 const request=vi.fn(async(_actor,type,value)=>{if(type==='command'){if(fail)throw new KnowledgeWorkError('knowledge_transport_error',503);return {page:currentPage};}if(value.operation==='prepare_draft')return preview;if(value.operation==='detail')return currentPage;return {items:[],nextCursor:null,coverage:preview.coverage};});
 const d={enabled:vi.fn(async()=>true),actor:vi.fn(async()=>actor),knowledgeWork:{request,link:id=>'https://app.example.com/?knowledge='+id},search:vi.fn(async()=>[]),link:()=>'',slack:vi.fn(async(method,body)=>{calls.push({method,body});return {view:{id:'view'}};}),reply:vi.fn(async()=>{}),background:p=>work.push(p)};
 return {d,request,calls,setActor:a=>actor=a,setPage:p=>currentPage=p,setFail:v=>fail=v,flush:async()=>{while(work.length)await work.shift();},view:()=>calls.filter(c=>c.method==='views.update').at(-1).body.view};
}
const slash=text=>({command:'/livo',text,trigger_id:'trigger',user_id:'UTEST',team_id:'TTEST'});
const submit=(view,values={})=>({type:'view_submission',team:{id:'TTEST'},user:{id:'UTEST'},view:{id:'view',hash:'hash',callback_id:'livo_knowledge_work',private_metadata:view.private_metadata,state:{values}}});
const action=(view,id,value={})=>({type:'block_actions',team:{id:'TTEST'},user:{id:'UTEST'},actions:[{action_id:id,value:JSON.stringify(value)}],view:{id:'view',private_metadata:view.private_metadata}});
const confirmState={confirm:{confirm:{selected_options:[{value:'yes'}]}}};
describe('private Slack knowledge workflows',()=>{
 it('preview is read only; only explicit confirmation saves an owner-only draft',async()=>{
  const f=slackSetup();await handleKnowledgeWork(slash('meeting'),f.d,{});await f.flush();let view=f.view();
  const p=submit(view,{notes:{notes:{value:'Proposal'}},livo_kw_sources:{livo_kw_sources:{selected_options:[]}}});const ack=await handleKnowledgeWork(p,f.d,JSON.parse(view.private_metadata));expect(ack.response_action).toBe('update');await f.flush();view=f.view();
  expect(f.request.mock.calls.filter(c=>c[1]==='command')).toHaveLength(0);expect(view.submit.text).toBe('Save private draft');
  const denied=await handleKnowledgeWork(submit(view),f.d,JSON.parse(view.private_metadata));expect(denied.response_action).toBe('errors');
  await handleKnowledgeWork(submit(view,confirmState),f.d,JSON.parse(view.private_metadata));await f.flush();expect(f.request.mock.calls.find(c=>c[1]==='command')[2]).toMatchObject({operation:'save_draft',confirmed:true});expect(f.d.reply).not.toHaveBeenCalled();
 });
 it('binding changes cannot reuse cached private preview',async()=>{const f=slackSetup();await handleKnowledgeWork(slash('meeting'),f.d,{});await f.flush();const view=f.view();f.setActor({id:'member',binding_id:'other-binding',team:'TTEST',slack_user:'UTEST',locale:'en'});await handleKnowledgeWork(submit(view,{notes:{notes:{value:'secret'}}}),f.d,JSON.parse(view.private_metadata));await f.flush();expect(f.request).not.toHaveBeenCalled();expect(JSON.stringify(f.view())).not.toContain('secret');});
 it('worker replacement preserves a reviewed form without persisting retrieved source bodies',async()=>{
  const f=slackSetup();await handleKnowledgeWork(slash('meeting'),f.d,{});await f.flush();let view=f.view();await handleKnowledgeWork(submit(view,{notes:{notes:{value:'My note'}}}),f.d,JSON.parse(view.private_metadata));await f.flush();view=f.view();expect(view.private_metadata).not.toContain(preview.text);
  vi.resetModules();const restarted=await import('../../docker/volumes/functions/slack-interact/knowledge-work-handler');await restarted.handleKnowledgeWork(submit(view,confirmState),f.d,JSON.parse(view.private_metadata));await f.flush();expect(f.request.mock.calls.filter(c=>c[1]==='command')).toHaveLength(1);
 });
 it('never silently replaces a confirmed preview with new source content',async()=>{
  const f=slackSetup();await handleKnowledgeWork(slash('meeting'),f.d,{});await f.flush();let view=f.view();await handleKnowledgeWork(submit(view,{notes:{notes:{value:'My note'}}}),f.d,JSON.parse(view.private_metadata));await f.flush();view=f.view();f.request.mockImplementation(async(_actor,type,q)=>type==='query'&&q.operation==='command_result'?{found:false}:{...preview,text:'Unreviewed changed content'});
  await handleKnowledgeWork(submit(view,confirmState),f.d,JSON.parse(view.private_metadata));await f.flush();expect(f.request.mock.calls.filter(c=>c[1]==='command')).toHaveLength(0);expect(JSON.stringify(f.view())).not.toContain('Unreviewed changed content');
 });
 it('a successful prior save is recovered before changed sources are reconstructed',async()=>{
  const f=slackSetup();await handleKnowledgeWork(slash('meeting'),f.d,{});await f.flush();let view=f.view();await handleKnowledgeWork(submit(view,{notes:{notes:{value:'My note'}}}),f.d,JSON.parse(view.private_metadata));await f.flush();view=f.view();f.setFail(true);await handleKnowledgeWork(submit(view,confirmState),f.d,JSON.parse(view.private_metadata));await f.flush();view=f.view();const id=f.request.mock.calls.find(c=>c[1]==='command')[2].commandId;
  f.request.mockImplementation(async(_actor,type,q)=>{expect(type).toBe('query');expect(q).toEqual({operation:'command_result',commandId:id});return {found:true,result:{commandId:id,replayed:true,page}};});await handleKnowledgeWork(action(view,'livo_kw_retry'),f.d,JSON.parse(view.private_metadata));await f.flush();expect(JSON.stringify(f.view())).toContain('Saved in LIVO');expect(f.request.mock.calls.filter(c=>c[1]==='command')).toHaveLength(1);
 });
 it('publication freezes the version displayed for explicit review and retries uncertain outcome with same command ID',async()=>{
  const f=slackSetup();await handleKnowledgeWork(action({private_metadata:'{}'},'livo_kw_open',{pageId:'page'}),f.d,{});await f.flush();let view=f.view();await handleKnowledgeWork(action(view,'livo_kw_publish'),f.d,JSON.parse(view.private_metadata));await f.flush();view=f.view();f.setPage({...page,pageVersion:9});f.setFail(true);await handleKnowledgeWork(submit(view,confirmState),f.d,JSON.parse(view.private_metadata));await f.flush();const first=f.request.mock.calls.find(c=>c[1]==='command')[2];expect(first.expectedVersion).toBe(7);view=f.view();f.setFail(false);await handleKnowledgeWork(action(view,'livo_kw_retry'),f.d,JSON.parse(view.private_metadata));await f.flush();expect(f.request.mock.calls.filter(c=>c[1]==='command').map(c=>c[2].commandId)).toEqual([first.commandId,first.commandId]);
 });
 it('suggestions require live actor and enabled integration',async()=>{const f=slackSetup();f.d.enabled.mockResolvedValue(false);expect(await handleKnowledgeWork({type:'block_suggestion',action_id:'livo_kw_source',value:''},f.d,{})).toEqual({options:[]});expect(f.request).not.toHaveBeenCalled();});
 it('member backend sends member JWT only and fails closed if identity is missing',async()=>{const fetcher=vi.fn(async()=>Response.json({items:[]}));const d=createKnowledgeWorkData({get:k=>({SUPABASE_URL:'https://db.example.com',SUPABASE_ANON_KEY:'anon'})[k]},fetcher);await expect(d.request({jwt:'member'},'query',{operation:'drafts',cursor:0})).rejects.toThrow('knowledge_forbidden');await d.request({jwt:'member',binding_id:'binding',team:'TTEST',slack_user:'UTEST'},'query',{operation:'drafts',cursor:0});expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer member');});
});
