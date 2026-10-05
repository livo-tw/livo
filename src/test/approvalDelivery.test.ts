// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import {currentPersonalPayload,deliverJob,notificationMessage,type DeliveryStore,type Job,type Row} from '../../docker/volumes/functions/slack-deliver/core';
import {deliveryStore} from '../../docker/volumes/functions/slack-deliver/backend';
const request:Row={id:'request-example',task_id:'task-example',rule_id:'rule-example',requested_by:'requester',from_status:'todo',status:'pending',version:2,current_step:2,
  steps_snapshot:[{step_order:1,approver_type:'role',approver_role:'admin',approver_user_id:null},{step_order:2,approver_type:'user',approver_role:null,approver_user_id:'reviewer'}]};
const task={id:'task-example',current_approval_id:'request-example',approval_status:'pending_approval',status_id:'todo',approval_request:request,
  approval_member:{id:'reviewer',role:'member',is_active:true}};
const job:Job={id:1,team_id:'TEXAMPLE',task_id:'task-example',target_type:'member',target_id:'reviewer',attempts:1,payload:{kind:'approval',taskKey:'EX-1',taskTitle:'Example <task>',
  projectName:'Example',actorName:'Example Admin',approvalRecipient:'approver',approval:{requestId:'request-example',version:2,currentStep:2,status:'pending',eventType:'step_approved',
    fromStatusName:'Todo',toStatusName:'Done',operation:'approve'}}};
describe('approval delivery live authorization and formatting',()=>{
  it('keeps title and versioned confirmation buttons within Slack five-button limit',()=>{
    const message=notificationMessage(job.payload,'https://example.com');
    expect(message.text).toContain('EX-1 - Example &lt;task&gt;');
    const actions=message.blocks[1] as Row;
    expect(actions.elements).toHaveLength(5);
    expect(JSON.parse(actions.elements.find((b:Row)=>b.action_id==='approval_approve').value)).toEqual({requestId:'request-example',version:2,step:2,operation:'approve'});
    expect(JSON.parse(actions.elements.find((b:Row)=>b.action_id==='livo_approval_open').value).operation).toBe('open');
  });
  it('terminal or stale channel event has no decision buttons',()=>{
    for(const payload of [{...job.payload,approvalActionable:false},{...job.payload,approval:{...job.payload.approval,status:'approved',eventType:'approved'}}]){
      const actions=(notificationMessage(payload,'https://example.com').blocks[1] as Row).elements;
      expect(actions.map((b:Row)=>b.action_id).filter(Boolean)).toEqual(['livo_approval_open']);
    }
  });
  it('requires same request, version, task status, step, and active named member',()=>{
    expect(currentPersonalPayload(job,task)).toEqual(job.payload);
    for(const changed of [undefined,{...task,current_approval_id:null},{...task,status_id:'done'},
      {...task,approval_member:{...task.approval_member,is_active:false}},
      {...task,approval_request:{...request,version:3}}, {...task,approval_request:{...request,current_step:3}},
      {...task,approval_member:{id:'another',role:'super_admin',is_active:true}}, {...task,approval_request:{...request,steps_snapshot:null}}]){
      expect(currentPersonalPayload(job,changed)).toBeUndefined();
    }
  });
  it('exact role does not permit super-admin bypass; manual fallback does',()=>{
    const roleRequest={...request,current_step:1};const roleJob={...job,target_id:'owner',payload:{...job.payload,approval:{...job.payload.approval,currentStep:1}}};
    const roleTask={...task,approval_member:{id:'owner',role:'super_admin',is_active:true},approval_request:roleRequest};
    expect(currentPersonalPayload(roleJob,roleTask)).toBeUndefined();
    expect(currentPersonalPayload(roleJob,{...roleTask,approval_request:{...roleRequest,rule_id:null}})).toEqual(roleJob.payload);
  });
  it('outcome DM is only the current requester; cancelled does not notify',()=>{
    const outcome={...job,target_id:'requester',payload:{...job.payload,approvalRecipient:'requester',approval:{...job.payload.approval,status:'approved'}}};
    const result={...task,approval_member:{id:'requester',role:'member',is_active:true},approval_request:{...request,status:'approved'}};
    expect(currentPersonalPayload(outcome,result)).toEqual(outcome.payload);
    expect(currentPersonalPayload(outcome,{...result,approval_request:{...result.approval_request,requested_by:'other'}})).toBeUndefined();
    expect(currentPersonalPayload({...outcome,payload:{...outcome.payload,approval:{...outcome.payload.approval,status:'cancelled'}}},
      {...result,approval_request:{...result.approval_request,status:'cancelled'}})).toBeUndefined();
  });
  it('rechecks role after Slack user/channel lookups and sends nothing after a change',async()=>{
    const posted:Row[]=[];let reads=0;const finish=vi.fn(async()=>true);
    const store:DeliveryStore={config:async()=>({enabled:true,teamId:'TEXAMPLE',dmEnabled:true,routes:[{projectId:'p',channelId:'CEXAMPLE'}]}),
      claim:async()=>job,token:async()=>'example-test-token',project:async()=>({id:'p'}),canReadTask:async()=>true,binding:async()=>'UEXAMPLE',thread:async()=>undefined,
      currentTask:async()=>++reads===1?task:{...task,approval_request:{...request,version:3}},queueWeekly:async()=>0,weeklyTasks:async()=>[],canSend:async()=>true,finish};
    const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);
      if(url.includes('auth.test'))return Response.json({ok:true,team_id:'TEXAMPLE'});
      if(url.includes('users.info'))return Response.json({ok:true,user:{id:'UEXAMPLE',team_id:'TEXAMPLE'}});
      if(url.includes('conversations.members'))return Response.json({ok:true,members:['UEXAMPLE']});
      if(url.includes('conversations.open'))return Response.json({ok:true,channel:{id:'DEXAMPLE'}});
      posted.push(JSON.parse(String(init?.body)));return Response.json({ok:true,ts:'1800000000.000001'});
    }) as typeof fetch;
    expect(await deliverJob(job,'owner',store,'https://example.com',fetcher)).toBe('skipped');
    expect(posted).toHaveLength(0);expect(reads).toBe(2);
  });
  it('loads the exact task-bound request and live recipient role from PostgREST',async()=>{
    const urls:string[]=[];vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);urls.push(url);
      return Response.json(url.includes('/tasks?')?[task]:url.includes('/approval_requests?')?[request]:[{id:'reviewer',role:'member',is_active:true}]);
    }));
    try{
      const store=deliveryStore({get:(key:string)=>({SUPABASE_URL:'https://example.com',SUPABASE_SERVICE_ROLE_KEY:'example-service',SUPABASE_ANON_KEY:'example-anon'}[key])});
      expect((await store.currentTask('task-example','request-example','reviewer'))?.approval_request.id).toBe('request-example');
      const query=new URL(urls.find(url=>url.includes('/approval_requests?'))!).searchParams;
      expect(query.get('task_id')).toBe('eq.task-example');expect(query.get('id')).toBe('eq.request-example');
      expect(new URL(urls.find(url=>url.includes('/members?'))!).searchParams.get('is_active')).toBe('eq.true');
    }finally{vi.unstubAllGlobals();}
  });
});
