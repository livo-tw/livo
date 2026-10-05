// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
import {currentPersonalPayload,notificationMessage,deliverJob,type Job,type DeliveryStore} from '../../docker/volumes/functions/slack-deliver/core';
type Row=Record<string,any>;
const task:Row={id:'t1',assignee_id:'m1',reviewer_id:'m1',assignee_revision:2,reviewer_revision:4,status_id:'s1'};
const job:Job={id:1,team_id:'TEXAMPLE',task_id:'t1',target_type:'member',target_id:'m1',attempts:1,payload:{kind:'personal',taskId:'t1',taskKey:'EXAMPLE-1',taskTitle:'<@everyone>',
  recipientRules:[{role:'assignee',code:'assigned',assignmentRevision:2},{role:'reviewer',code:'reviewer_assigned',assignmentRevision:4}],responsibilities:[{role:'assignee',expectedRevision:2},{role:'reviewer',expectedRevision:4}]}};
const buttons=(payload:Row)=>notificationMessage(payload,'https://example.com').blocks.flatMap((b:Row)=>b.elements||[]).filter((b:Row)=>b.action_id==='livo_work_ack');
describe('live responsibility snapshots in Slack delivery',()=>{
 it('offers both roles in separate valid action blocks and escapes titles',()=>{
  const current=currentPersonalPayload(job,task)!;expect(buttons(current).map((b:Row)=>JSON.parse(b.value))).toEqual([{taskId:'t1',role:'assignee',expectedRevision:2},{taskId:'t1',role:'reviewer',expectedRevision:4}]);
  const message=notificationMessage(current,'https://example.com');expect(message.text).toContain('&lt;@everyone&gt;');
  for(const block of message.blocks.filter((b:Row)=>b.type==='actions')){const ids=block.elements.map((e:Row)=>e.action_id).filter(Boolean);expect(new Set(ids).size).toBe(ids.length);}
 });
 it('removes acknowledged buttons without hiding the responsibility notification',()=>{
  const current=currentPersonalPayload(job,{...task,assignee_acknowledged_at:'now'})!;
  expect(buttons(current).map((b:Row)=>JSON.parse(b.value).role)).toEqual(['reviewer']);expect(current.recipientRules).toHaveLength(2);
 });
 it('does not revive an old A to B to A notification after the member returns',()=>{
  expect(currentPersonalPayload(job,{...task,assignee_revision:4,reviewer_revision:6})).toBeUndefined();
 });
 it.each([undefined,[{role:'assignee',code:'assigned'}],[{role:'assignee',code:'status_changed',assignmentRevision:2}]])('cannot manufacture acknowledgment buttons from legacy or nonassignment rules %j',rules=>{
  const current=currentPersonalPayload({...job,payload:{...job.payload,recipientRules:rules}},task)!;
  expect(buttons(current)).toHaveLength(0);
 });
 it('rechecks ack and identity immediately before send after opening the DM',async()=>{
  let acknowledged=false;const posts:Row[]=[];
  const store:DeliveryStore={config:async()=>({enabled:true,dmEnabled:true,teamId:'TEXAMPLE',routes:[{projectId:'p1',channelId:'CEXAMPLE'}]}),
   claim:async()=>job,finish:vi.fn(async()=>true),token:async()=>'fixture',project:async()=>({id:'p1',is_archived:false}),canReadTask: async () => true, binding:async()=>'UEXAMPLE',thread:async()=>undefined,
   currentTask:async()=>({...task,assignee_acknowledged_at:acknowledged?'now':null,reviewer_acknowledged_at:acknowledged?'now':null}),queueWeekly:async()=>0,weeklyTasks:async()=>[],canSend:async()=>true};
  const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
   const path=String(input);if(path.endsWith('auth.test'))return Response.json({ok:true,team_id:'TEXAMPLE'});
   if(path.includes('/users.info'))return Response.json({ok:true,user:{team_id:'TEXAMPLE'}});
   if(path.includes('/conversations.members'))return Response.json({ok:true,members:['UEXAMPLE']});
   if(path.endsWith('conversations.open')){acknowledged=true;return Response.json({ok:true,channel:{id:'DEXAMPLE'}});}
   posts.push(JSON.parse(String(init?.body)));return Response.json({ok:true,ts:'1791158400.000001'});
  });
  expect(await deliverJob(job,'owner',store,'https://example.com',fetcher)).toBe('sent');
  expect(posts).toHaveLength(1);expect(JSON.stringify(posts[0])).not.toContain('livo_work_ack');expect(store.currentTask).toBeDefined();
 });
 it('skips an assignment invalidated while the DM is opening',async()=>{
  let moved=false;const posts:Row[]=[];
  const store:DeliveryStore={config:async()=>({enabled:true,dmEnabled:true,teamId:'TEXAMPLE',routes:[{projectId:'p1',channelId:'CEXAMPLE'}]}),claim:async()=>job,finish:vi.fn(async()=>true),token:async()=>'fixture',project:async()=>({id:'p1'}),canReadTask: async () => true, binding:async()=>'UEXAMPLE',thread:async()=>undefined,
   currentTask:async()=>({...task,assignee_revision:moved?4:2,reviewer_revision:moved?6:4}),queueWeekly:async()=>0,weeklyTasks:async()=>[],canSend:async()=>true};
  const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{const path=String(input);
   if(path.endsWith('auth.test'))return Response.json({ok:true,team_id:'TEXAMPLE'});if(path.includes('/users.info'))return Response.json({ok:true,user:{team_id:'TEXAMPLE'}});
   if(path.includes('/conversations.members'))return Response.json({ok:true,members:['UEXAMPLE']});if(path.endsWith('conversations.open')){moved=true;return Response.json({ok:true,channel:{id:'DEXAMPLE'}});}
   posts.push(JSON.parse(String(init?.body)));return Response.json({ok:true,ts:'1791158400.000001'});});
  expect(await deliverJob(job,'owner',store,'https://example.com',fetcher)).toBe('skipped');expect(posts).toHaveLength(0);
 });
});
