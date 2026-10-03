// @vitest-environment node
import { describe,expect,it,vi } from 'vitest';
import { deliverRelease,releaseMessage,type ReleaseDeliveryState,type ReleaseDeliveryStore,type ReleaseDeliveryJob } from '../../docker/volumes/functions/slack-deliver/release-core';
import { DeliveryError } from '../../docker/volumes/functions/slack-deliver/core';
const job:ReleaseDeliveryJob={id:'outbox-1',event_id:'event-1',batch_id:'release-1',workspace_id:'default',attempts:1};
const state=():ReleaseDeliveryState=>({batch:{id:'release-1',title:'Example release',version:5,manifestRevision:2,status:'active',components:[{id:'component-1',name:'Server',projectId:'project-1',targets:[{environment:'Prod',build:'b1',config:'c1',data:'d1'}]}],closureNote:'SECRET CLOSURE',evidence:[{note:'SECRET EVIDENCE',url:'https://secret.example.com'}],exceptions:[{reason:'SECRET EXCEPTION'}],maintenance:[{impact:'SECRET IMPACT'}]},
 event:{id:'event-1',operation:'record_result',version:4},publication:{team_id:'TEXAMPLE',channel_id:'CEXAMPLE'},projects:[{id:'project-1',name:'Example project',line_id:'line-1',is_archived:false}],ownerName:'Example owner',publisherUser:'UPUBLISHER'});
function setup(){
 const current=state(),posts:Record<string,unknown>[]=[];
 const store:ReleaseDeliveryStore={config:async()=>({enabled:true,teamId:'TEXAMPLE',routes:[{lineId:'line-1',channelId:'CEXAMPLE'}]}),claim:async()=>job,snapshot:async()=>current,token:async()=>'synthetic-token',canSend:vi.fn(async()=>true),finish:vi.fn(async()=>true)};
 const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
  const name=new URL(String(url)).pathname.split('/').at(-1);
  if(name==='auth.test')return Response.json({ok:true,team_id:'TEXAMPLE',user_id:'UBOT'});
  if(name==='users.info')return Response.json({ok:true,user:{id:'UPUBLISHER',team_id:'TEXAMPLE',is_bot:false,deleted:false}});
  if(name==='conversations.members')return Response.json({ok:true,members:['UPUBLISHER','UBOT'],response_metadata:{next_cursor:''}});
  posts.push(JSON.parse(String(init?.body)));return Response.json({ok:true,ts:'1900000000.000001'});
 }) as unknown as typeof fetch;
 return{current,posts,store,fetcher};
}
describe('explicit release publication delivery',()=>{
 it('uses a stable batch thread even when its root is older than the task window',async()=>{
  const t=setup();t.current.thread='1600000000.000001';
  expect(await deliverRelease(job,'lease-owner',t.store,'http://example.com/work',t.fetcher)).toBe('sent');
  expect(t.posts[0].thread_ts).toBe('1600000000.000001');
  expect(t.store.canSend).toHaveBeenCalledWith(job,'lease-owner',t.current);
  expect(t.store.finish).toHaveBeenCalledWith(job,'lease-owner',expect.objectContaining({threadTs:'1600000000.000001'}));
 });
 it('creates a root only after an explicit publication exists',async()=>{
  const t=setup();t.store.snapshot=async()=>undefined;
  expect(await deliverRelease(job,'lease-owner',t.store,'https://example.com',t.fetcher)).toBe('skipped');
  expect(t.fetcher).not.toHaveBeenCalled();expect(t.posts).toHaveLength(0);
 });
 it('requires all component projects to share the authorized destination',async()=>{
  const t=setup();t.current.batch.components.push({id:'component-2',projectId:'other-project',name:'Other',targets:[]});
  expect(await deliverRelease(job,'lease-owner',t.store,'https://example.com',t.fetcher)).toBe('skipped');expect(t.posts).toHaveLength(0);
 });
 it('does not post after authorization, binding or version changes during membership checks',async()=>{
  const t=setup();t.store.canSend=vi.fn(async()=>false);
  expect(await deliverRelease(job,'lease-owner',t.store,'https://example.com',t.fetcher)).toBe('skipped');expect(t.posts).toHaveLength(0);
 });
 it('does not send a bot from another Slack workspace',async()=>{
  const t=setup();t.fetcher=vi.fn(async()=>Response.json({ok:true,team_id:'TOTHER',user_id:'UBOT'})) as unknown as typeof fetch;
  expect(await deliverRelease(job,'lease-owner',t.store,'https://example.com',t.fetcher)).toBe('failed');expect(t.posts).toHaveLength(0);
 });
 it('checks later membership pages and rejects a publisher who has left',async()=>{
  const t=setup();let membership=0;
  t.fetcher=vi.fn(async(url:RequestInfo|URL)=>{
   const u=new URL(String(url));if(u.pathname.endsWith('auth.test'))return Response.json({ok:true,team_id:'TEXAMPLE',user_id:'UBOT'});
   if(u.pathname.endsWith('users.info'))return Response.json({ok:true,user:{team_id:'TEXAMPLE',deleted:false,is_bot:false}});
   membership++;return Response.json({ok:true,members:['UOTHER'],response_metadata:{next_cursor:membership===1?'next':''}});
  }) as unknown as typeof fetch;
  expect(await deliverRelease(job,'lease-owner',t.store,'https://example.com',t.fetcher)).toBe('failed');
  expect(membership).toBe(2);expect(t.posts).toHaveLength(0);
 });
 it('never sends private notes or evidence content and preserves the configured path',()=>{
  const message=releaseMessage(state(),'http://example.com/customer/');
  const wire=JSON.stringify(message);
  expect(wire).not.toContain('SECRET');expect(wire).not.toContain('secret.example.com');
  expect(wire).toContain('http://example.com/customer/?release=release-1');
  expect(wire).toContain('Example release');expect(wire).toContain('b1');
 });
 it('keeps the summary disclosure within the block budget without cutting escaped text',()=>{
  const s=state();s.batch.title='😀&'.repeat(100);s.ownerName='😀&'.repeat(70);
  s.batch.components=Array.from({length:6},(_,index)=>({id:'c'+index,name:'&'.repeat(100),projectId:'project-1',targets:Array.from({length:3},()=>({environment:'&'.repeat(60),build:'&'.repeat(60),config:'&'.repeat(60),data:'&'.repeat(60)}))}));
  const message=releaseMessage(s,'https://example.com');
  expect(message.text.length).toBeLessThan(2800);
  expect(message.text.endsWith('此為摘要，完整清單與紀錄請開啟批次查看。')).toBe(true);
  expect(message.text.replaceAll('&amp;','')).not.toMatch(/&(?!lt;|gt;)/);
 });
 it('marks a lost Slack receipt for review instead of an automatic resend',async()=>{
  const t=setup(),base=t.fetcher;
  t.fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{if(String(url).endsWith('chat.postMessage'))throw new Error('connection lost');return base(url,init);}) as unknown as typeof fetch;
  expect(await deliverRelease(job,'lease-owner',t.store,'https://example.com',t.fetcher)).toBe('review');
  expect(t.store.finish).toHaveBeenCalledWith(job,'lease-owner',expect.objectContaining({status:'review'}));
 });
 it('does not translate a post-success database failure into a pending retry',async()=>{
  const t=setup();t.store.finish=vi.fn(async()=>{throw new Error('database unavailable');});
  await expect(deliverRelease(job,'lease-owner',t.store,'https://example.com',t.fetcher)).rejects.toThrow('database unavailable');
  expect(t.posts).toHaveLength(1);expect(t.store.finish).toHaveBeenCalledTimes(1);
 });
 it('rejects a lost send lease after posting without repeating the post',async()=>{
  const t=setup();t.store.finish=vi.fn(async()=>false);
  await expect(deliverRelease(job,'lease-owner',t.store,'https://example.com',t.fetcher)).rejects.toBeInstanceOf(DeliveryError);
  expect(t.posts).toHaveLength(1);
 });
});
