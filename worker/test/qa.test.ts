// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { qaCheckSignature, qaFileInput, qaRange } from '../src/qaStorage';
import { canonicalQaJson, executeQaAction, qaErrorResponse } from '../src/qa';
import { QaError, type QaIssue } from '../src/qa/domain';
import type { Env, AuthCtx } from '../src/env';
import { createCloudQaSlackActions } from '../src/qaSlack';
import { DEFAULT_QA_WORKFLOW, type QaWorkflow } from '../src/qa/workflow';

describe('QA D1 transaction invariants (real SQLite triggers)',()=>{
  let db:DatabaseSync;
  beforeEach(()=>{
    db=new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
    db.exec(`INSERT INTO product_lines(workspace_id,id,name) VALUES('ws-a','line-a','Line'),('ws-b','line-b','Line');
      INSERT INTO projects(workspace_id,id,line_id,name,key) VALUES('ws-a','project-a','line-a','A','A'),('ws-b','project-b','line-b','B','B');
      INSERT INTO members(workspace_id,id,name,avatar,role,email) VALUES('ws-a','member-a','A','','admin','a@test'),('ws-b','member-b','B','','admin','b@test');
      INSERT INTO system_settings(workspace_id,key,value) VALUES('ws-a','feature_toggles','{"qa":true}'),('ws-b','feature_toggles','{"qa":true}');
      INSERT INTO workspaces(id,name,storage_limit_mb) VALUES('ws-a','A',100);`);
  });
  afterEach(()=>{db.close();vi.unstubAllGlobals();});
  type FixtureIssue=Pick<QaIssue,'id'|'workspaceId'|'projectId'|'state'|'version'|'title'|'reporterId'|'assigneeId'|'qaOwnerId'|'taskIds'|'duplicateOfId'>;
  const issue=(version=1,extra:Partial<FixtureIssue>={}):FixtureIssue=>({id:'issue-a',workspaceId:'ws-a',projectId:'project-a',state:'new',version,title:'Issue',reporterId:'member-a',assigneeId:null,qaOwnerId:null,taskIds:[],duplicateOfId:null,...extra});
  function putIssue(){db.prepare('INSERT INTO qa_issues(workspace_id,id,project_id,state,reporter_id,title,version,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?)').run('ws-a','issue-a','project-a','new','member-a','Issue',1,'now',JSON.stringify(issue()));}
  function claim(id:string,expected:number,data=issue(expected+1)){
    db.prepare('INSERT INTO qa_commands(workspace_id,id,issue_id,actor_id,actor_role,expected_version,operation,request_hash,issue_data,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('ws-a',id,'issue-a','member-a','admin',expected,'edit','hash',JSON.stringify(data),JSON.stringify(data),'now');
  }
  function atomic(fn:()=>void){db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
  it('rejects a stale command before any receipt, state, or event can commit',()=>{
    putIssue();
    expect(()=>atomic(()=>{claim('stale',0);db.exec("INSERT INTO qa_events VALUES('ws-a','ev','issue-a','member-a','edit','',2,'now')");})).toThrow('qa_conflict');
    expect(db.prepare('SELECT COUNT(*) AS n FROM qa_commands').get()?.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM qa_events').get()?.n).toBe(0);
    expect(db.prepare("SELECT version FROM qa_issues WHERE workspace_id='ws-a' AND id='issue-a'").get()?.version).toBe(1);
  });
  it('rolls back the command receipt when a later SQL statement fails',()=>{
    putIssue();expect(()=>atomic(()=>{claim('valid',1);db.exec("INSERT INTO qa_events VALUES('ws-a','ev','missing','member-a','edit','',2,'now')");})).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM qa_commands').get()?.n).toBe(0);
  });
  it('enforces disabled feature, changed actor role, and cross-workspace references inside commit',()=>{
    putIssue();db.exec("UPDATE system_settings SET value='{}' WHERE workspace_id='ws-a'");expect(()=>claim('disabled',1)).toThrow('qa_disabled');
    db.exec("UPDATE system_settings SET value='{\"qa\":true}' WHERE workspace_id='ws-a'; UPDATE members SET role='member' WHERE id='member-a'");
    expect(()=>claim('role',1)).toThrow('qa_forbidden');db.exec("UPDATE members SET role='admin' WHERE id='member-a'");
    expect(()=>claim('member',1,issue(2,{qaOwnerId:'member-b'}))).toThrow('qa_invalid_member');
    expect(()=>claim('project',1,issue(2,{projectId:'project-b'}))).toThrow('qa_invalid_project');
    expect(()=>claim('task',1,issue(2,{taskIds:['foreign-task']}))).toThrow('qa_invalid_task');
  });
  it('makes command identity unique per workspace',()=>{putIssue();claim('same',1);expect(()=>claim('same',1)).toThrow(/UNIQUE/);});
  function reserve(id:string,size:number){db.prepare('INSERT INTO qa_upload_sessions(workspace_id,id,issue_id,actor_id,file_name,mime_type,expected_size,storage_key,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('ws-a',id,'issue-a','member-a','a.mp4','video/mp4',size,`qa/ws-a/issue-a/${id}`,'now','later');}
  it('atomically counts reservations and transfers a completed upload into usage once',()=>{
    putIssue();reserve('upload-a',70*1048576);expect(()=>reserve('upload-b',40*1048576)).toThrow('qa_storage_quota');
    db.exec("UPDATE qa_upload_sessions SET state='finalizing' WHERE workspace_id='ws-a' AND id='upload-a'");
    const finalize=()=>db.prepare('INSERT INTO qa_attachments(workspace_id,id,issue_id,uploaded_by,file_name,mime_type,size,storage_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('ws-a','upload-a','issue-a','member-a','a.mp4','video/mp4',70*1048576,'qa/ws-a/issue-a/upload-a','now');
    finalize();expect(()=>finalize()).toThrow();
    expect(db.prepare("SELECT storage_used_bytes AS n FROM workspaces WHERE id='ws-a'").get()?.n).toBe(70*1048576);
    expect(db.prepare("SELECT state FROM qa_upload_sessions WHERE workspace_id='ws-a' AND id='upload-a'").get()?.state).toBe('complete');
    expect(()=>reserve('upload-b',40*1048576)).toThrow('qa_storage_quota');
  });
  it('cannot finalize another uploader or exceed quota changed by another upload path',()=>{
    putIssue();reserve('upload-a',70*1048576);db.exec("UPDATE qa_upload_sessions SET state='finalizing' WHERE workspace_id='ws-a';UPDATE workspaces SET storage_used_bytes=40*1048576 WHERE id='ws-a'");
    expect(()=>db.prepare('INSERT INTO qa_attachments(workspace_id,id,issue_id,uploaded_by,file_name,mime_type,size,storage_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('ws-a','upload-a','issue-a','member-a','a.mp4','video/mp4',70*1048576,'qa/ws-a/issue-a/upload-a','now')).toThrow('qa_storage_quota');
    expect(db.prepare('SELECT COUNT(*) AS n FROM qa_attachments').get()?.n).toBe(0);
  });
  function environment(beforeRun?:(sql:string)=>void):Env {
    const statement=(sql:string,args:unknown[]=[])=>({
      bind:(...params:unknown[])=>statement(sql,params),
      all:async()=>({results:db.prepare(sql).all(...args as never[]),success:true}),
      first:async()=>db.prepare(sql).get(...args as never[])??null,
      run:async()=>{beforeRun?.(sql);return {success:true,meta:{changes:Number(db.prepare(sql).run(...args as never[]).changes)}};},
      execute:()=>({results:db.prepare(sql).all(...args as never[]),success:true}),
    });
    return {DB:{prepare:(sql:string)=>statement(sql),batch:async(stmts:Array<{execute:()=>unknown}>)=>{let out:unknown[]=[];atomic(()=>{out=stmts.map(s=>s.execute());});return out;}},
      REALTIME:{idFromName:(name:string)=>name,get:()=>({fetch:async()=>new Response('ok')})},
      ATTACHMENTS:{head:async():Promise<null>=>null},
    } as unknown as Env;
  }
  const auth:AuthCtx={userId:'auth-a',email:'a@test',member:{id:'member-a',role:'admin',email:'a@test',name:'A',workspaceId:'ws-a'}};
  const create={action:'create',id:'new-issue',commandId:'create-1',input:{projectId:'project-a',title:'QA bug',actual:'Broken',observedEnvironment:'Stage'}};
  it('returns recorded builds only from the selected tenant and project, never CAS versions',async()=>{
    putIssue();
    db.prepare('UPDATE qa_issues SET data=? WHERE id=?').run(JSON.stringify({...issue(),observedVersion:' v2 ',targets:[{build:'v10'}],runs:[{build:'v1'},{build:'v2'}]}),'issue-a');
    db.prepare("INSERT INTO projects(workspace_id,id,line_id,name,key) VALUES('ws-a','other-project','line-a','Other','OTHER')").run();
    for(const [ws,project,reporter,id,value] of [['ws-a','other-project','member-a','other-issue','private-project-build'],['ws-b','project-b','member-b','tenant-issue','private-tenant-build']]) {
      const data={...issue(),workspaceId:ws,projectId:project,reporterId:reporter,id,observedVersion:value};
      db.prepare('INSERT INTO qa_issues(workspace_id,id,project_id,state,reporter_id,title,version,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(ws,id,project,'new',reporter,'Issue',1,'now',JSON.stringify(data));
    }
    expect(await executeQaAction(environment(),auth,{action:'versions',projectId:'project-a'})).toEqual(['v1','v2','v10']);
    await expect(executeQaAction(environment(),auth,{action:'versions',projectId:'project-b'})).rejects.toMatchObject({code:'qa_project_unavailable'});
    await expect(executeQaAction(environment(),auth,{action:'versions',projectId:''})).rejects.toMatchObject({code:'qa_invalid_id'});
    db.exec("UPDATE system_settings SET value='{\"qa\":false}' WHERE workspace_id='ws-a' AND key='feature_toggles'");
    await expect(executeQaAction(environment(),auth,{action:'versions',projectId:'project-a'})).rejects.toMatchObject({code:'qa_disabled'});
  });
  const customWorkflow=():QaWorkflow=>({version:1,order:['verification','new','triaged','in_progress','closed'],labels:{new:'待確認',triaged:'已排入',in_progress:'修復處理',verification:'等待復驗',closed:'結案完成'}});
  it('returns workflow defaults without creating settings and falls back from invalid stored data',async()=>{
    const env=environment();expect(await executeQaAction(env,auth,{action:'get_workflow'})).toEqual(DEFAULT_QA_WORKFLOW);
    expect(db.prepare("SELECT COUNT(*) AS n FROM system_settings WHERE workspace_id='ws-a' AND key='qa_workflow'").get()?.n).toBe(0);
    db.prepare("INSERT INTO system_settings(workspace_id,key,value) VALUES('ws-a','qa_workflow',?)").run('{"version":1,"order":["made_up"],"labels":{}}');
    expect(await executeQaAction(env,auth,{action:'get_workflow'})).toEqual(DEFAULT_QA_WORKFLOW);
  });
  it('saves company workflow labels and order for admin and super-admin without changing state IDs',async()=>{
    const env=environment(),workflow=customWorkflow();workflow.labels.new='  待確認  ';
    expect(await executeQaAction(env,auth,{action:'save_workflow',workflow})).toEqual(customWorkflow());
    expect(await executeQaAction(env,auth,{action:'get_workflow'})).toEqual(customWorkflow());
    db.exec("UPDATE members SET role='super_admin' WHERE workspace_id='ws-a' AND id='member-a'");
    const superAuth={...auth,member:{...auth.member,role:'super_admin'}};
    const updated=customWorkflow();updated.order=['closed','new','triaged','in_progress','verification'];
    expect(await executeQaAction(env,superAuth,{action:'save_workflow',workflow:updated})).toEqual(updated);
    const created=await executeQaAction(env,superAuth,create) as QaIssue;expect(created.state).toBe('new');
  });
  it('lets a live member read shared workflow but rejects writes and stale elevated roles',async()=>{
    const env=environment(),workflow=customWorkflow();await executeQaAction(env,auth,{action:'save_workflow',workflow});
    db.exec("UPDATE members SET role='member' WHERE workspace_id='ws-a' AND id='member-a'");
    const memberAuth={...auth,member:{...auth.member,role:'member'}};
    expect(await executeQaAction(env,memberAuth,{action:'get_workflow'})).toEqual(workflow);
    await expect(executeQaAction(env,memberAuth,{action:'save_workflow',workflow:DEFAULT_QA_WORKFLOW})).rejects.toThrow('qa_forbidden');
    await expect(executeQaAction(env,auth,{action:'save_workflow',workflow:DEFAULT_QA_WORKFLOW})).rejects.toThrow('qa_forbidden');
    expect(JSON.parse(String(db.prepare("SELECT value FROM system_settings WHERE workspace_id='ws-a' AND key='qa_workflow'").get()?.value))).toEqual(workflow);
  });
  it('scopes workflow reads and upserts to authenticated workspace and ignores caller-provided scope',async()=>{
    const env=environment(),workflow=customWorkflow();
    await executeQaAction(env,auth,{action:'save_workflow',workflow,workspaceId:'ws-b',workspace_id:'ws-b'});
    const other:AuthCtx={userId:'auth-b',email:'b@test',member:{id:'member-b',role:'admin',email:'b@test',name:'B',workspaceId:'ws-b'}};
    expect(await executeQaAction(env,other,{action:'get_workflow',workspaceId:'ws-a'})).toEqual(DEFAULT_QA_WORKFLOW);
    const otherWorkflow=customWorkflow();otherWorkflow.labels.closed='公司 B 完成';
    await executeQaAction(env,other,{action:'save_workflow',workflow:otherWorkflow});
    expect(await executeQaAction(env,auth,{action:'get_workflow'})).toEqual(workflow);
    expect(await executeQaAction(env,other,{action:'get_workflow'})).toEqual(otherWorkflow);
  });
  it('blocks both workflow reads and writes when QA is off while retaining saved settings',async()=>{
    const env=environment(),workflow=customWorkflow();await executeQaAction(env,auth,{action:'save_workflow',workflow});
    db.exec("UPDATE system_settings SET value='{\"qa\":false}' WHERE workspace_id='ws-a' AND key='feature_toggles'");
    await expect(executeQaAction(env,auth,{action:'get_workflow'})).rejects.toThrow('qa_disabled');
    await expect(executeQaAction(env,auth,{action:'save_workflow',workflow:DEFAULT_QA_WORKFLOW})).rejects.toThrow('qa_disabled');
    db.exec("UPDATE system_settings SET value='{\"qa\":true}' WHERE workspace_id='ws-a' AND key='feature_toggles'");
    expect(await executeQaAction(env,auth,{action:'get_workflow'})).toEqual(workflow);
  });
  it('rejects arbitrary, duplicate, missing, or renamed state IDs before changing shared workflow',async()=>{
    const env=environment(),workflow=customWorkflow();await executeQaAction(env,auth,{action:'save_workflow',workflow});
    const invalid=[
      {...workflow,order:['new','triaged','in_progress','verification','done']},
      {...workflow,order:['new','new','in_progress','verification','closed']},
      {...workflow,order:['new','triaged','verification','closed']},
      {...workflow,labels:{new:'待確認',triaged:'已排入',in_progress:'修復處理',verification:'等待復驗',done:'完成'}},
      {...workflow,labels:{...workflow.labels,done:'新增狀態'}},
      {...workflow,version:2},
    ];
    for(const candidate of invalid)await expect(executeQaAction(env,auth,{action:'save_workflow',workflow:candidate})).rejects.toThrow('qa_invalid_workflow');
    expect(await executeQaAction(env,auth,{action:'get_workflow'})).toEqual(workflow);
  });
  it('rechecks live privilege or feature revocation in the workflow upsert statement',async()=>{
    const workflow=customWorkflow();await executeQaAction(environment(),auth,{action:'save_workflow',workflow});
    const revokeRole=environment(sql=>{if(sql.startsWith('INSERT INTO system_settings'))db.exec("UPDATE members SET role='member' WHERE workspace_id='ws-a' AND id='member-a'");});
    await expect(executeQaAction(revokeRole,auth,{action:'save_workflow',workflow:DEFAULT_QA_WORKFLOW})).rejects.toThrow('qa_forbidden');
    expect(JSON.parse(String(db.prepare("SELECT value FROM system_settings WHERE workspace_id='ws-a' AND key='qa_workflow'").get()?.value))).toEqual(workflow);
    db.exec("UPDATE members SET role='admin' WHERE workspace_id='ws-a' AND id='member-a'");
    const revokeFeature=environment(sql=>{if(sql.startsWith('INSERT INTO system_settings'))db.exec("UPDATE system_settings SET value='{}' WHERE workspace_id='ws-a' AND key='feature_toggles'");});
    await expect(executeQaAction(revokeFeature,auth,{action:'save_workflow',workflow:DEFAULT_QA_WORKFLOW})).rejects.toThrow('qa_forbidden');
    expect(JSON.parse(String(db.prepare("SELECT value FROM system_settings WHERE workspace_id='ws-a' AND key='qa_workflow'").get()?.value))).toEqual(workflow);
  });
  it('executes the full two-environment workflow and safely replays a committed request',async()=>{
    const env=environment();let current=await executeQaAction(env,auth,create) as {version:number;state:string;targets:Array<{id:string}>};
    const command=async(cmd:Record<string,unknown>)=>{current=await executeQaAction(env,auth,{action:'command',id:'new-issue',commandId:crypto.randomUUID(),expectedVersion:current.version,command:cmd}) as typeof current;return current;};
    await command({type:'triage',assigneeId:'member-a',qaOwnerId:'member-a',severity:'high',priority:1,dueDate:null});
    await command({type:'start_fix'});
    await command({type:'submit_fix',summary:'Fixed',targets:[{environment:'Stage',component:'app',build:'build-A',required:true},{environment:'Production',component:'app',build:'build-A',required:true}]});
    const [stage,prod]=current.targets;
    await command({type:'record_deployment',targetId:stage.id,build:'build-A',evidence:'manual release'});
    await command({type:'record_verification',targetId:stage.id,build:'build-A',result:'pass',note:'Verified'});
    await expect(command({type:'close',resolution:'fixed',reason:''})).rejects.toThrow('qa_verification_required');
    await command({type:'record_deployment',targetId:prod.id,build:'build-A',evidence:'manual release'});
    await command({type:'record_verification',targetId:prod.id,build:'build-A',result:'pass',note:'Verified'});
    const close={action:'command',id:'new-issue',commandId:'close-once',expectedVersion:current.version,command:{type:'close',resolution:'fixed',reason:''}};
    const first=await executeQaAction(env,auth,close),again=await executeQaAction(env,auth,close);expect(again).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS n FROM qa_events WHERE workspace_id='ws-a' AND type='close'").get()?.n).toBe(1);
    await expect(executeQaAction(env,auth,{...close,command:{type:'reopen',reason:'Again'}})).rejects.toThrow('qa_idempotency_conflict');
  });
  it('keeps concurrent edits atomic and rejects cross-tenant reads and disabled feature access',async()=>{
    const env=environment();await executeQaAction(env,auth,create);
    const cmd=(commandId:string)=>({action:'command',id:'new-issue',commandId,expectedVersion:1,command:{type:'hold',reason:commandId}});
    const outcomes=await Promise.allSettled([executeQaAction(env,auth,cmd('hold-a')),executeQaAction(env,auth,cmd('hold-b'))]);
    expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM qa_events WHERE workspace_id='ws-a' AND type='hold'").get()?.n).toBe(1);
    const other:AuthCtx={userId:'b',email:'b@test',member:{id:'member-b',role:'admin',email:'b@test',name:'B',workspaceId:'ws-b'}};
    await expect(executeQaAction(env,other,{action:'get',id:'new-issue'})).rejects.toThrow('qa_not_found');
    db.exec("UPDATE system_settings SET value='{}' WHERE workspace_id='ws-a'");
    await expect(executeQaAction(env,auth,{action:'list'})).rejects.toThrow('qa_disabled');
    expect(db.prepare("SELECT COUNT(*) AS n FROM qa_issues WHERE workspace_id='ws-a'").get()?.n).toBe(1);
  });
  it('requires live super-admin authority for restore instead of a role in backup JSON',async()=>{
    const env=environment();await expect(executeQaAction(env,auth,{action:'restore',tables:{},validateOnly:true,role:'super_admin'})).rejects.toThrow('qa_forbidden');
    expect(()=>db.prepare('INSERT INTO qa_restore_batches VALUES(?,?,?,?)').run('ws-a','restore','member-a','now')).toThrow('qa_forbidden');
  });
  it('validates and non-destructively restores native QA rows and command receipts',async()=>{
    const env=environment();await executeQaAction(env,auth,create);
    const tables={qa_issues:db.prepare("SELECT * FROM qa_issues WHERE workspace_id='ws-a'").all(),qa_commands:db.prepare("SELECT * FROM qa_commands WHERE workspace_id='ws-a'").all()};
    db.exec("DELETE FROM qa_commands WHERE workspace_id='ws-a';DELETE FROM qa_events WHERE workspace_id='ws-a';DELETE FROM qa_issues WHERE workspace_id='ws-a';UPDATE members SET role='super_admin' WHERE id='member-a'");
    const admin={...auth,member:{...auth.member,role:'super_admin'}};
    expect(await executeQaAction(env,admin,{action:'restore',tables})).toMatchObject({validateOnly:true,inserted:0,pending:2,conflicts:[],missingAssets:[]});
    expect(db.prepare('SELECT COUNT(*) AS n FROM qa_issues').get()?.n).toBe(0);
    expect(await executeQaAction(env,admin,{action:'restore',tables,validateOnly:false})).toMatchObject({inserted:2,skipped:0});
    expect(await executeQaAction(env,admin,{action:'restore',tables,validateOnly:false})).toMatchObject({inserted:0,skipped:2});
    const changed=JSON.parse(JSON.stringify(tables));changed.qa_issues[0].title='Different';const data=JSON.parse(changed.qa_issues[0].data);data.title='Different';changed.qa_issues[0].data=JSON.stringify(data);
    expect(await executeQaAction(env,admin,{action:'restore',tables:changed,validateOnly:false})).toMatchObject({inserted:0,conflicts:['qa_issues:new-issue']});
    expect(db.prepare("SELECT title FROM qa_issues WHERE workspace_id='ws-a'").get()?.title).toBe('QA bug');
  });
  it('does not restore metadata that points at missing or foreign private evidence',async()=>{
    const env=environment();await executeQaAction(env,auth,create);db.exec("UPDATE members SET role='super_admin' WHERE id='member-a'");
    const admin={...auth,member:{...auth.member,role:'super_admin'}};
    const attachment={workspace_id:'ws-a',id:'upload-a',issue_id:'new-issue',uploaded_by:'member-a',file_name:'repro.mp4',mime_type:'video/mp4',size:100,storage_key:'qa/ws-a/new-issue/upload-a',created_at:'now'};
    expect(await executeQaAction(env,admin,{action:'restore',tables:{qa_attachments:[attachment]},validateOnly:false})).toMatchObject({inserted:0,missingAssets:['upload-a']});
    await expect(executeQaAction(env,admin,{action:'restore',tables:{qa_attachments:[{...attachment,workspace_id:'ws-b'}]},validateOnly:false})).rejects.toThrow('qa_backup_workspace_mismatch');
    expect(db.prepare('SELECT COUNT(*) AS n FROM qa_attachments').get()?.n).toBe(0);
  });
  function inboxSetup(){
    putIssue();
    db.exec(`UPDATE system_settings SET value='{"qa":true,"slackActions":true}' WHERE workspace_id='ws-a';
      INSERT INTO slack_config(id,bot_token) VALUES('ws-a','test-token');
      INSERT INTO qa_slack_links(id,workspace_id,issue_id,team_id,channel_id,thread_ts,card_ts,created_at)
        VALUES('link-a','ws-a','issue-a','TEAM_A','CHANNEL_A','100.1','100.1','now');`);
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({ok:true,team_id:'TEAM_A'}),{headers:{'content-type':'application/json'}})));
    const adapter=createCloudQaSlackActions(environment(),'ws-a',{waitUntil:()=>{}});
    const payload={type:'event_callback',event_id:'event-a',team_id:'TEAM_A',event:{type:'message',user:'USER_A',channel:'CHANNEL_A',thread_ts:'100.1',ts:'101.1',text:'PASS'}};
    return {adapter,payload};
  }
  it('durably claims an inbox event once, recovers a lease, backs off, and completes once',async()=>{
    const {adapter,payload}=inboxSetup();
    expect(await adapter.enqueueEvent(payload)).toBe('event-a');expect(await adapter.enqueueEvent(payload)).toBe('');
    expect(await adapter.pendingEvents()).toEqual([]);
    expect(db.prepare("SELECT attempts FROM qa_slack_inbox WHERE workspace_id='ws-a' AND id='event-a'").get()?.attempts).toBe(1);
    db.exec("UPDATE qa_slack_inbox SET lease_until='2000-01-01',next_attempt_at='2000-01-01' WHERE workspace_id='ws-a'");
    const claimed=await adapter.pendingEvents();expect(claimed).toHaveLength(1);expect(claimed[0].payload).toEqual(payload);
    expect(await adapter.pendingEvents()).toEqual([]);
    const row=db.prepare("SELECT attempts,next_attempt_at FROM qa_slack_inbox WHERE workspace_id='ws-a' AND id='event-a'").get();
    expect(row?.attempts).toBe(2);expect(Date.parse(String(row?.next_attempt_at))).toBeGreaterThan(Date.now()+100000);
    await adapter.completeEvent('event-a');expect(await adapter.enqueueEvent(payload)).toBe('');
    expect(db.prepare("SELECT state FROM qa_slack_inbox WHERE workspace_id='ws-a' AND id='event-a'").get()?.state).toBe('done');
  });
  it('does not retain unlinked conversations or another configured Slack team and stays tenant scoped',async()=>{
    const {adapter,payload}=inboxSetup();
    expect(await adapter.enqueueEvent({...payload,event:{...payload.event,thread_ts:'unlinked'}})).toBe('');
    db.exec("INSERT INTO qa_slack_links VALUES('wrong-team','ws-a','issue-a','TEAM_B','CHANNEL_A','100.1','100.1','now')");
    await expect(adapter.enqueueEvent({...payload,team_id:'TEAM_B'})).rejects.toThrow('qa_forbidden');
    expect(db.prepare('SELECT COUNT(*) AS n FROM qa_slack_inbox').get()?.n).toBe(0);
    await adapter.enqueueEvent(payload);
    db.prepare('INSERT INTO qa_slack_inbox(workspace_id,id,payload,next_attempt_at,created_at,expires_at) VALUES(?,?,?,?,?,?)').run('ws-b','event-a','{}','now','now','2099-01-01');
    await adapter.completeEvent('event-a');
    expect(db.prepare("SELECT state FROM qa_slack_inbox WHERE workspace_id='ws-b' AND id='event-a'").get()?.state).toBe('pending');
  });
  it('disables queued execution without deleting unexpired data and prunes expired inbox rows',async()=>{
    const {adapter,payload}=inboxSetup();await adapter.enqueueEvent(payload);
    db.exec("UPDATE qa_slack_inbox SET lease_until='2000-01-01',next_attempt_at='2000-01-01' WHERE workspace_id='ws-a';UPDATE system_settings SET value='{\"qa\":false,\"slackActions\":true}' WHERE workspace_id='ws-a'");
    expect(await adapter.pendingEvents()).toEqual([]);expect(await adapter.enqueueEvent({...payload,event_id:'new-disabled'})).toBe('');
    expect(db.prepare("SELECT COUNT(*) AS n FROM qa_slack_inbox WHERE workspace_id='ws-a'").get()?.n).toBe(1);
    db.exec("UPDATE qa_slack_inbox SET expires_at='2000-01-01' WHERE workspace_id='ws-a'");await adapter.pendingEvents();
    expect(db.prepare("SELECT COUNT(*) AS n FROM qa_slack_inbox WHERE workspace_id='ws-a'").get()?.n).toBe(0);
  });
});

describe('private QA file boundaries',()=>{
  it('returns the same nested error envelope parsed by the production client',async()=>{
    const c={json:(body:unknown,status:number)=>new Response(JSON.stringify(body),{status})};
    const response=qaErrorResponse(c as never,new QaError('qa_conflict',409));
    expect(response.status).toBe(409);expect(await response.json()).toEqual({error:{code:'qa_conflict',message:'qa_conflict'}});
  });
  it('allows the historical 97MB MP4 and caps at 200MB',()=>{
    expect(qaFileInput('repro.mp4','video/mp4',97351192).size).toBe(97351192);
    expect(()=>qaFileInput('repro.mp4','video/mp4',200*1048576+1)).toThrow();
    expect(()=>qaFileInput('repro.html','text/html',100)).toThrow();
    expect(()=>qaFileInput('../repro.mp4','video/mp4',100)).toThrow();
  });
  it('rejects renamed HTML and validates magic bytes',()=>{
    expect(()=>qaCheckSignature('video/mp4',new TextEncoder().encode('<html>payload</html>'))).toThrow();
    expect(()=>qaCheckSignature('image/png',new Uint8Array([137,80,78,71,13,10,26,10]))).not.toThrow();
    expect(()=>qaCheckSignature('text/plain',new TextEncoder().encode('<script>payload</script>'))).toThrow();
  });
  it('supports bounded Range seeking and rejects multi-range/out-of-file ranges',()=>{
    expect(qaRange('bytes=10-19',100)).toEqual({offset:10,length:10});
    expect(qaRange('bytes=-20',100)).toEqual({offset:80,length:20});
    expect(()=>qaRange('bytes=100-',100)).toThrow();expect(()=>qaRange('bytes=1-2,5-6',100)).toThrow();
  });
  it('canonicalizes request keys without treating array order as equivalent',()=>{
    expect(canonicalQaJson({b:2,a:1})).toBe(canonicalQaJson({a:1,b:2}));
    expect(canonicalQaJson([1,2])).not.toBe(canonicalQaJson([2,1]));
  });
});
