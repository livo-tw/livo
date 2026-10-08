// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { qaCheckSignature, qaFileInput, qaRange } from '../src/qaStorage';
import { canonicalQaJson, executeQaAction, qaErrorResponse } from '../src/qa';
import { QaError, type QaIssue } from '../src/qa/domain';
import type { Env, AuthCtx } from '../src/env';
import { createCloudQaSlackActions } from '../src/qaSlack';
import { handleSlackLinkRpc } from '../src/slackLink';
import { DEFAULT_QA_WORKFLOW, type QaWorkflow } from '../src/qa/workflow';
import { runQuery } from '../src/db';

describe('QA D1 transaction invariants (real SQLite triggers)',()=>{
  let db:DatabaseSync;
  beforeEach(()=>{
    db=new DatabaseSync(':memory:');
    db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
    db.exec(`INSERT INTO product_lines(workspace_id,id,name) VALUES('ws-a','line-a','Line'),('ws-b','line-b','Line');
      INSERT INTO projects(workspace_id,id,line_id,name,key) VALUES('ws-a','project-a','line-a','A','A'),('ws-b','project-b','line-b','B','B');
      INSERT INTO members(workspace_id,id,name,avatar,role,email) VALUES('ws-a','member-a','A','','admin','a@test'),('ws-b','member-b','B','','admin','b@test');
      INSERT INTO auth_users(id,email) VALUES('auth-a','a@test'),('auth-b','b@test');
      UPDATE members SET auth_id=CASE id WHEN 'member-a' THEN 'auth-a' ELSE 'auth-b' END;
      INSERT INTO system_settings(workspace_id,key,value) VALUES('ws-a','feature_toggles','{"qa":true}'),('ws-b','feature_toggles','{"qa":true}');
      INSERT INTO workspaces(id,name,storage_limit_mb) VALUES('ws-a','A',100);`);
  });
  afterEach(()=>{db.close();vi.unstubAllGlobals();});
  type FixtureIssue=Pick<QaIssue,'id'|'workspaceId'|'projectId'|'state'|'version'|'title'|'reporterId'|'assigneeId'|'qaOwnerId'|'taskIds'|'duplicateOfId'>;
  const issue=(version=1,extra:Partial<FixtureIssue>={}):FixtureIssue=>({id:'issue-a',workspaceId:'ws-a',projectId:'project-a',state:'new',version,title:'Issue',reporterId:'member-a',assigneeId:null,qaOwnerId:null,taskIds:[],duplicateOfId:null,...extra});
  function putIssue(){db.prepare('INSERT INTO qa_issues(workspace_id,id,project_id,state,reporter_id,title,version,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?)').run('ws-a','issue-a','project-a','new','member-a','Issue',1,'now',JSON.stringify(issue()));}
  function claim(id:string,expected:number,data=issue(expected+1)){
    db.prepare('INSERT INTO qa_commands(workspace_id,id,issue_id,actor_id,actor_role,actor_auth_id,expected_version,operation,request_hash,issue_data,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('ws-a',id,'issue-a','member-a','admin','auth-a',expected,'edit','hash',JSON.stringify(data),JSON.stringify(data),'now');
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
    expect(()=>claim('project',1,issue(2,{projectId:'project-b'}))).toThrow(/qa_invalid_project|qa_forbidden/);
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
  function environment(beforeRun?:(sql:string)=>void, beforeBatch?:()=>void):Env {
    const statement=(sql:string,args:unknown[]=[])=>({
      bind:(...params:unknown[])=>statement(sql,params),
      all:async()=>{beforeRun?.(sql);return {results:db.prepare(sql).all(...args as never[]),success:true};},
      first:async()=>db.prepare(sql).get(...args as never[])??null,
      run:async()=>{beforeRun?.(sql);return {success:true,meta:{changes:Number(db.prepare(sql).run(...args as never[]).changes)}};},
      execute:()=>({results:db.prepare(sql).all(...args as never[]),success:true}),
    });
    return {DB:{prepare:(sql:string)=>statement(sql),batch:async(stmts:Array<{execute:()=>unknown}>)=>{let out:unknown[]=[];beforeBatch?.();atomic(()=>{out=stmts.map(s=>s.execute());});return out;}},
      REALTIME:{idFromName:(name:string)=>name,get:()=>({fetch:async()=>new Response('ok')})},
      ATTACHMENTS:{head:async():Promise<null>=>null},
    } as unknown as Env;
  }
  const auth:AuthCtx={userId:'auth-a',email:'a@test',member:{id:'member-a',role:'admin',email:'a@test',name:'A',workspaceId:'ws-a'}};
  const create={action:'create',id:'new-issue',commandId:'create-1',input:{projectId:'project-a',title:'QA bug',actual:'Broken',observedEnvironment:'Stage'}};
  it('blocks generic-query capability escalation and QA-catalog bypass without granting broader settings access',async()=>{
    const env=environment(),ctx={waitUntil:():void=>{}};
    const patch={table:'members',op:'update' as const,values:{is_qa_admin:true},filters:[{col:'id',op:'eq' as const,val:'member-a'}]};
    expect((await runQuery(env,ctx,auth,structuredClone(patch))).error?.code).toBe('42501');
    db.exec("UPDATE members SET role='member',is_qa_admin=1 WHERE workspace_id='ws-a'");
    const manager={...auth,member:{...auth.member,role:'member'}};
    expect((await runQuery(env,ctx,manager,structuredClone(patch))).error?.code).toBe('42501');
    expect((await runQuery(env,ctx,manager,{table:'system_settings',op:'upsert',values:{key:'feature_toggles',value:{qa:false}}})).error?.code).toBe('42501');
    db.exec("UPDATE members SET role='super_admin',is_qa_admin=0 WHERE workspace_id='ws-a'");
    const superAuth={...auth,member:{...auth.member,role:'super_admin'}};
    expect((await runQuery(env,ctx,superAuth,structuredClone(patch))).error).toBeNull();
    expect(db.prepare("SELECT role,is_qa_admin FROM members WHERE workspace_id='ws-a'").get()).toEqual({role:'super_admin',is_qa_admin:1});
    for(const key of ['qa_custom_fields','qa_workflow']) expect((await runQuery(env,ctx,superAuth,{table:'system_settings',op:'upsert',values:{key,value:{unsafe:true}}})).error?.code).toBe('42501');
    const revoked=environment(sql=>{if(sql.startsWith('UPDATE members SET is_qa_admin'))db.exec("UPDATE members SET role='member',is_qa_admin=0 WHERE workspace_id='ws-a'");});
    expect((await runQuery(revoked,ctx,superAuth,structuredClone(patch))).error).not.toBeNull();
    expect(db.prepare("SELECT is_qa_admin FROM members WHERE workspace_id='ws-a'").get()?.is_qa_admin).toBe(0);
  });
  it('commits manual states with immutable evidence and a single replayable audit event',async()=>{
    const env=environment();let current=await executeQaAction(env,auth,create) as QaIssue;
    db.exec("UPDATE members SET role='member' WHERE id='member-a'");
    const reporter={...auth,member:{...auth.member,role:'member'}};
    for(const state of ['verified','failed','closed','new'] as const){
      const before=current,body={action:'command',id:current.id,commandId:'manual-'+state,expectedVersion:current.version,command:{type:'set_state',state}};
      current=await executeQaAction(env,reporter,body) as QaIssue;
      expect(await executeQaAction(env,reporter,body)).toEqual(current);
      expect(current).toMatchObject({state,targets:[],runs:[],fixCycle:0});
      const event=db.prepare("SELECT detail FROM qa_events WHERE issue_id=? AND type='set_state' AND version=?").get(current.id,current.version) as {detail:string};
      expect(JSON.parse(event.detail)).toMatchObject({mode:'manual',from:before.state,to:state});
    }
    expect(db.prepare("SELECT count(*) AS n FROM qa_events WHERE type='set_state'").get()?.n).toBe(4);
    expect(current).toMatchObject({closedAt:null,closedBy:null});
  });
  it('lets any active member comment, also on a closed bug, the same as the self-hosted server',async()=>{
    const env=environment();let current=await executeQaAction(env,auth,create) as QaIssue;
    current=await executeQaAction(env,auth,{action:'command',id:current.id,commandId:'close-for-comment',expectedVersion:current.version,command:{type:'set_state',state:'closed'}}) as QaIssue;
    db.exec(`INSERT INTO auth_users(id,email) VALUES('auth-bystander','bystander@example.com');
      INSERT INTO members(workspace_id,id,name,email,avatar,color,role,is_active,auth_id) VALUES('ws-a','bystander','Bystander','bystander@example.com','B','#000000','member',1,'auth-bystander')`);
    const bystander={...auth,userId:'auth-bystander',member:{...auth.member,id:'bystander',role:'member'}};
    await executeQaAction(env,bystander,{action:'comment',id:current.id,commandId:'comment-closed',body:'Still happens on Stage'});
    expect(db.prepare("SELECT actor_id,body FROM qa_comments WHERE issue_id=?").get(current.id)).toEqual({actor_id:'bystander',body:'Still happens on Stage'});
  });
  it('keeps manual-state permission, feature, tenant and stale-version failures atomic',async()=>{
    const env=environment(),current=await executeQaAction(env,auth,create) as QaIssue;
    const body={action:'command',id:current.id,commandId:'manual-denied',expectedVersion:current.version,command:{type:'set_state',state:'failed'}};
    db.exec("INSERT INTO members(workspace_id,id,name,email,avatar,color,role,is_active) VALUES('ws-a','outsider','Outsider','outsider@example.com','O','#000000','member',1)");
    const outsider={...auth,member:{...auth.member,id:'outsider',role:'member'}};
    await expect(executeQaAction(env,outsider,body)).rejects.toMatchObject({code:'qa_forbidden'});
    await expect(executeQaAction(env,auth,{...body,expectedVersion:99})).rejects.toMatchObject({code:'qa_conflict'});
    await expect(executeQaAction(env,{...auth,member:{...auth.member,workspaceId:'ws-b',id:'member-b'}},body)).rejects.toBeDefined();
    db.exec("UPDATE system_settings SET value='{\"qa\":false}' WHERE workspace_id='ws-a' AND key='feature_toggles'");
    await expect(executeQaAction(env,auth,body)).rejects.toMatchObject({code:'qa_disabled'});
    expect(db.prepare("SELECT count(*) AS n FROM qa_commands WHERE operation='set_state'").get()?.n).toBe(0);
    expect(db.prepare('SELECT state FROM qa_issues WHERE id=?').get(current.id)?.state).toBe('new');
  });
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
  it('paginates grouped states in one scoped query without including another state or workspace',async()=>{
    const env=environment();
    for(const state of ['new','triaged','verified'] as const){
      const data={...issue(),id:'group-'+state,state};
      db.prepare('INSERT INTO qa_issues(workspace_id,id,project_id,state,reporter_id,title,version,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?)').run('ws-a',data.id,'project-a',state,'member-a','Grouped',1,'now',JSON.stringify(data));
    }
    const first=await executeQaAction(env,auth,{action:'list',input:{states:['new','triaged'],limit:1,offset:0}}) as {total:number;hasMore:boolean;issues:QaIssue[]};
    const second=await executeQaAction(env,auth,{action:'list',input:{states:['new','triaged'],limit:1,offset:1}}) as typeof first;
    expect(first.total).toBe(2);expect(first.hasMore).toBe(true);expect(second.total).toBe(2);expect(second.hasMore).toBe(false);
    expect(new Set([...first.issues,...second.issues].map(row=>row.state))).toEqual(new Set(['new','triaged']));
    for(const input of [{states:[]},{states:['new','new']},{states:['bogus']},{state:'new',states:['new']}])
      await expect(executeQaAction(env,auth,{action:'list',input})).rejects.toThrow('qa_invalid_state');
  });
  it('filters and sorts like compareQaIssues in qa/domain.ts',async()=>{
    const env=environment();
    const rows:[string,number,string|null,string,string,string|null,string,string][]=[
      ['qa-a',3,null,'2026-09-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','member-a','high','new'],
      ['qa-b',1,'2026-10-20','2026-09-03T00:00:00.000Z','2026-10-02T00:00:00.000Z','member-a','low','new'],
      ['qa-c',5,'2026-10-10','2026-09-02T00:00:00.000Z','2026-10-03T00:00:00.000Z',null,'medium','triaged'],
      ['qa-d',1,null,'2026-09-04T00:00:00.000Z','2026-10-03T00:00:00.000Z',null,'untriaged','new'],
    ];
    for(const [id,priority,dueDate,createdAt,updatedAt,assigneeId,severity,state] of rows){
      const data={...issue(),id,state,priority,dueDate,createdAt,updatedAt,assigneeId,severity};
      db.prepare('INSERT INTO qa_issues(workspace_id,id,project_id,state,assignee_id,reporter_id,title,version,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?,?)').run('ws-a',id,'project-a',state,assigneeId,'member-a','Sorted',1,updatedAt,JSON.stringify(data));
    }
    const ids=async(input:Record<string,unknown>)=>((await executeQaAction(env,auth,{action:'list',input})) as {issues:QaIssue[]}).issues.map(row=>row.id).filter(id=>id.startsWith('qa-'));
    // Same expectations as src/test/boardSort.test.ts (taken from PostgREST).
    expect(await ids({})).toEqual(['qa-c','qa-d','qa-b','qa-a']);
    expect(await ids({sort:'priority',direction:'desc'})).toEqual(['qa-d','qa-b','qa-a','qa-c']);
    expect(await ids({sort:'priority',direction:'asc'})).toEqual(['qa-c','qa-a','qa-d','qa-b']);
    expect(await ids({sort:'dueDate',direction:'asc'})).toEqual(['qa-c','qa-b','qa-d','qa-a']);
    expect(await ids({sort:'dueDate',direction:'desc'})).toEqual(['qa-b','qa-c','qa-d','qa-a']);
    expect(await ids({sort:'createdAt',direction:'desc'})).toEqual(['qa-d','qa-b','qa-c','qa-a']);
    expect(await ids({priorities:[1,3]})).toEqual(['qa-d','qa-b','qa-a']);
    expect(await ids({severities:['high','low']})).toEqual(['qa-b','qa-a']);
    expect(await ids({assigneeIds:['member-a'],states:['new']})).toEqual(['qa-b','qa-a']);
    expect(await ids({projectIds:['project-b']})).toEqual([]);
    for(const input of [{assigneeIds:[]},{priorities:[9]},{severities:['critical']},{sort:'title'},{direction:'sideways'},{mine:'everyone'}])
      await expect(executeQaAction(env,auth,{action:'list',input})).rejects.toThrow('qa_invalid_filter');
    // My QA's default: bugs I fix, verify or reported, and no one else's.
    db.exec(`INSERT INTO members(workspace_id,id,name,avatar,role,email,is_active) VALUES('ws-a','member-other','Other','','member','other@example.com',1)`);
    for(const [id,qaOwner] of [['qa-e',null],['qa-f','member-a']] as const){
      const data={...issue(),id,state:'new',reporterId:'member-other',assigneeId:null,qaOwnerId:qaOwner,updatedAt:'2026-10-04T00:00:00.000Z'};
      db.prepare('INSERT INTO qa_issues(workspace_id,id,project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('ws-a',id,'project-a','new',null,qaOwner,'member-other','Others',1,data.updatedAt,JSON.stringify(data));
    }
    expect(await ids({mine:'involved'})).toEqual(['qa-f','qa-c','qa-d','qa-b','qa-a']);
    expect(await ids({mine:'testing'})).toEqual(['qa-f']);
  });
  it('finds bugs by their short id, lists open handoffs waiting on me and the projects I coordinate',async()=>{
    const env=environment();
    const put=(id:string,extra:Record<string,unknown>)=>{const data={...issue(),id,title:'Login '+id.slice(-4),updatedAt:'2026-10-04T00:00:00.000Z',...extra};
      db.prepare('INSERT INTO qa_issues(workspace_id,id,project_id,state,reporter_id,title,version,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?)').run('ws-a',id,'project-a','new','member-a',data.title,1,data.updatedAt,JSON.stringify(data));};
    const waiting='00000000-0000-4000-8000-00000000abcd',done='00000000-0000-4000-8000-00000000ef01';
    put(waiting,{handoff:{id:'handoff-1',nextOwnerId:'member-a',resolvedAt:null}});
    put(done,{handoff:{id:'handoff-2',nextOwnerId:'member-a',resolvedAt:'2026-10-04T01:00:00.000Z'}});
    const ids=async(input:Record<string,unknown>)=>((await executeQaAction(env,auth,{action:'list',input})) as {issues:QaIssue[]}).issues.map(row=>row.id);
    expect(await ids({search:'#0000abcd'})).toEqual([waiting]);
    expect(await ids({search:waiting})).toEqual([waiting]);
    // Without the # it is a title search.
    expect(await ids({search:'0000abcd'})).toEqual([]);
    expect(await ids({search:'Login ef01'})).toEqual([done]);
    expect(await ids({mine:'handoff'})).toEqual([waiting]);
    expect(await executeQaAction(env,auth,{action:'my_coordination'})).toEqual({projectIds:[]});
    db.exec("INSERT INTO qa_project_coordination(workspace_id,id,coordinator_id,version,updated_by,updated_at) VALUES('ws-a','project-a','member-a',1,'member-a','now')");
    expect(await executeQaAction(env,auth,{action:'my_coordination'})).toEqual({projectIds:['project-a']});
    db.exec("UPDATE projects SET is_archived=1 WHERE workspace_id='ws-a' AND id='project-a'");
    expect(await executeQaAction(env,auth,{action:'my_coordination'})).toEqual({projectIds:[]});
  });
  it('notifies the same people as the self-hosted server: new bugs to the coordinator or admins, comments to everyone on the bug',async()=>{
    const env=environment();
    db.exec(`INSERT INTO auth_users(id,email) VALUES('auth-reporter','reporter@example.com');
      INSERT INTO members(workspace_id,id,name,email,avatar,color,role,is_active,auth_id) VALUES
        ('ws-a','reporter','Reporter','reporter@example.com','R','#000000','member',1,'auth-reporter'),
        ('ws-a','admin-2','Admin Two','admin2@example.com','A','#000000','admin',1,NULL),
        ('ws-a','coordinator','Coordinator','coordinator@example.com','C','#000000','member',1,NULL)`);
    const reporter={...auth,userId:'auth-reporter',member:{...auth.member,id:'reporter',role:'member'}};
    const recipients=(issueId:string,event:string)=>(db.prepare("SELECT recipient_id,content FROM notifications WHERE workspace_id='ws-a'").all() as {recipient_id:string;content:string}[])
      .filter(row=>{const content=JSON.parse(row.content);return content.issueId===issueId&&content.event===event;}).map(row=>row.recipient_id).sort();
    const first=await executeQaAction(env,reporter,{...create,commandId:'create-admins'}) as QaIssue;
    expect(recipients(first.id,'create')).toEqual(['admin-2','member-a']);
    db.exec("INSERT INTO qa_project_coordination(workspace_id,id,coordinator_id,version,updated_by,updated_at) VALUES('ws-a','project-a','coordinator',1,'member-a','now')");
    const second=await executeQaAction(env,reporter,{...create,id:'new-issue-2',commandId:'create-coordinator'}) as QaIssue;
    expect(recipients(second.id,'create')).toEqual(['coordinator']);
    await executeQaAction(env,auth,{action:'comment',id:second.id,commandId:'comment-reporter',body:'Seen on Stage'});
    expect(recipients(second.id,'comment')).toEqual(['reporter']);
  });
  const customWorkflow=():QaWorkflow=>({...DEFAULT_QA_WORKFLOW,order:['verification','new','triaged','in_progress','verified','failed','closed','dismissed'],labels:{...DEFAULT_QA_WORKFLOW.labels,new:'待確認',triaged:'已排入',in_progress:'修復處理',verification:'等待復驗',closed:'結案完成'}});
  const fieldConfiguration={version:1,fields:[{id:'reason',fieldName:'Reason',fieldType:'text',isRequired:true,isEnabled:true,sortOrder:0}]};
  it('uses a live QA capability only for its own workspace configuration, never arbitrary issue privileges',async()=>{
    const env=environment();
    expect(await executeQaAction(env,auth,{action:'get_field_configuration'})).toEqual({version:1,fields:[]});
    db.exec("UPDATE members SET role='member',is_qa_admin=1 WHERE workspace_id='ws-a' AND id='member-a'");
    const manager={...auth,member:{...auth.member,role:'member'}};
    expect(await executeQaAction(env,manager,{action:'save_field_configuration',configuration:fieldConfiguration})).toEqual(fieldConfiguration);
    expect(await executeQaAction(env,manager,{action:'save_workflow',workflow:DEFAULT_QA_WORKFLOW})).toEqual(DEFAULT_QA_WORKFLOW);
    const other={userId:'auth-b',email:'b@test',member:{id:'member-b',role:'admin',email:'b@test',name:'B',workspaceId:'ws-b'}};
    expect(await executeQaAction(env,other,{action:'get_field_configuration',workspaceId:'ws-a'})).toEqual({version:1,fields:[]});
    await expect(executeQaAction(env,manager,{action:'save_field_configuration',configuration:{version:1,fields:[]}})).rejects.toThrow('qa_field_identity_immutable');
    db.exec("UPDATE members SET is_qa_admin=0 WHERE workspace_id='ws-a'");
    await expect(executeQaAction(env,manager,{action:'save_field_configuration',configuration:fieldConfiguration,qaAdmin:true})).rejects.toThrow('qa_forbidden');
    db.exec("UPDATE system_settings SET value='{\"qa\":false}' WHERE workspace_id='ws-a' AND key='feature_toggles'");
    await expect(executeQaAction(env,manager,{action:'get_field_configuration'})).rejects.toThrow('qa_disabled');
  });
  it('validates report fields in both create and edit while allowing state changes of old incomplete reports',async()=>{
    const env=environment(),historical=await executeQaAction(env,auth,create) as QaIssue;
    await executeQaAction(env,auth,{action:'save_field_configuration',configuration:fieldConfiguration});
    await expect(executeQaAction(env,auth,{...create,id:'missing',commandId:'missing-fields'})).rejects.toThrow('qa_custom_field_required');
    const valid=await executeQaAction(env,auth,{...create,id:'with-fields',commandId:'with-fields',input:{...create.input,customFields:{reason:'Evidence'}}}) as QaIssue;
    expect(valid.customFields).toEqual({reason:'Evidence'});
    await expect(executeQaAction(env,auth,{action:'command',id:valid.id,commandId:'bad-edit',expectedVersion:1,command:{type:'edit',title:'Edit',actual:'Issue',steps:'',expected:'',observedEnvironment:'Stage',observedVersion:'',component:'',customFields:{reason:42}}})).rejects.toThrow('qa_invalid_custom_field_value');
    expect((await executeQaAction(env,auth,{action:'command',id:historical.id,commandId:'old-state',expectedVersion:1,command:{type:'set_state',state:'failed'}}) as QaIssue).state).toBe('failed');
    expect(db.prepare("SELECT count(*) AS n FROM qa_commands WHERE id IN ('missing-fields','bad-edit')").get()?.n).toBe(0);
  });
  it('rechecks QA capability and field-catalog identity atomically on settings writes',async()=>{
    db.exec("UPDATE members SET role='member',is_qa_admin=1 WHERE workspace_id='ws-a'");
    const manager={...auth,member:{...auth.member,role:'member'}};
    const revoked=environment(sql=>{if(sql.startsWith('INSERT INTO system_settings'))db.exec("UPDATE members SET is_qa_admin=0 WHERE workspace_id='ws-a'");});
    await expect(executeQaAction(revoked,manager,{action:'save_field_configuration',configuration:fieldConfiguration})).rejects.toThrow('qa_configuration_conflict');
    expect(db.prepare("SELECT count(*) AS n FROM system_settings WHERE key='qa_custom_fields'").get()?.n).toBe(0);
    db.exec("UPDATE members SET is_qa_admin=1 WHERE workspace_id='ws-a'");
    const raced=environment(sql=>{if(sql.startsWith('INSERT INTO system_settings'))db.prepare("INSERT OR REPLACE INTO system_settings(workspace_id,key,value) VALUES('ws-a','qa_custom_fields',?)").run(JSON.stringify(fieldConfiguration));});
    await expect(executeQaAction(raced,manager,{action:'save_field_configuration',configuration:{version:1,fields:[]}})).rejects.toThrow('qa_configuration_conflict');
    expect(await executeQaAction(environment(),manager,{action:'get_field_configuration'})).toEqual(fieldConfiguration);
  });
  it('rolls back an entire report commit if its validated catalog changes before the D1 batch',async()=>{
    let changed=false;
    const env=environment(undefined,()=>{if(!changed){changed=true;db.prepare("INSERT INTO system_settings(workspace_id,key,value) VALUES('ws-a','qa_custom_fields',?)").run(JSON.stringify(fieldConfiguration));}});
    await expect(executeQaAction(env,auth,create)).rejects.toThrow('qa_configuration_conflict');
    expect(db.prepare('SELECT count(*) AS n FROM qa_issues').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM qa_commands').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM qa_events').get()?.n).toBe(0);
  });
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
    const updated=customWorkflow();updated.order=['closed','new','triaged','in_progress','verification','verified','failed','dismissed'];
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
      {...workflow,version:99},
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
    await command({type:'submit_fix',summary:'Fixed',targets:[{environment:'Stage',component:'app',build:'build-A',required:true},{environment:'Prod',component:'app',build:'build-A',required:true}]});
    const [stage,prod]=current.targets;
    await command({type:'record_deployment',targetId:stage.id,build:'build-A',evidence:'manual release'});
    await command({type:'record_verification',targetId:stage.id,build:'build-A',result:'pass',note:'Verified'});
    await expect(command({type:'close',resolution:'fixed',reason:''})).rejects.toThrow('qa_verification_required');
    await command({type:'record_deployment',targetId:prod.id,build:'build-A',evidence:'manual release'});
    const pass={action:'command',id:'new-issue',commandId:'final-pass-once',expectedVersion:current.version,command:{type:'record_verification',targetId:prod.id,build:'build-A',result:'pass',note:'Verified'}};
    const first=await executeQaAction(env,auth,pass) as QaIssue,again=await executeQaAction(env,auth,pass);expect(again).toEqual(first);
    expect(first).toMatchObject({state:'closed',resolution:'fixed',closedBy:'member-a',resolutionReason:''});
    expect(first.closedAt).toBe(first.updatedAt);
    expect(db.prepare("SELECT COUNT(*) AS n FROM qa_events WHERE workspace_id='ws-a' AND type='record_verification'").get()?.n).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM qa_events WHERE workspace_id='ws-a' AND type='close'").get()?.n).toBe(0);
    expect(db.prepare("SELECT detail FROM qa_events WHERE workspace_id='ws-a' AND version=? AND type='record_verification'").get(first.version)?.detail).toContain('已自動結案');
    expect(db.prepare("SELECT state FROM qa_issues WHERE workspace_id='ws-a' AND id='new-issue'").get()?.state).toBe('closed');
    await expect(executeQaAction(env,auth,{action:'command',id:'new-issue',commandId:'obsolete-close',expectedVersion:first.version,command:{type:'close',resolution:'fixed',reason:''}})).rejects.toThrow('qa_forbidden');
    await expect(executeQaAction(env,auth,{...pass,command:{type:'reopen',reason:'Again'}})).rejects.toThrow('qa_idempotency_conflict');
  });
  it.each(['member','admin','super_admin'])('closes only the final required PASS for a live %s actor',async role=>{
    db.prepare("UPDATE members SET role=? WHERE workspace_id='ws-a' AND id='member-a'").run(role);
    const actor={...auth,member:{...auth.member,role}},env=environment();
    let current=await executeQaAction(env,actor,{...create,input:{...create.input,assigneeId:'member-a'}}) as QaIssue;
    const command=async(cmd:Record<string,unknown>)=>current=await executeQaAction(env,actor,{action:'command',id:current.id,commandId:crypto.randomUUID(),expectedVersion:current.version,command:cmd}) as QaIssue;
    await command({type:'submit_fix',summary:'',targets:[{environment:'Stage',component:'',build:'one',required:true},{environment:'Prod',component:'',build:'one',required:true}]});
    for(const [i,target] of current.targets.entries()){
      await command({type:'record_deployment',targetId:target.id,build:'one',evidence:''});
      await command({type:'record_verification',targetId:target.id,build:'one',result:'pass',note:''});
      expect(current.state).toBe(i===0?'verification':'closed');
    }
    expect(current).toMatchObject({resolution:'fixed',closedBy:'member-a'});
  });
  it('rejects malformed formal closure claims before a receipt or issue mutation',async()=>{
    const env=environment();let current=await executeQaAction(env,auth,{...create,input:{...create.input,assigneeId:'member-a'}}) as QaIssue;
    const command=async(cmd:Record<string,unknown>)=>current=await executeQaAction(env,auth,{action:'command',id:current.id,commandId:crypto.randomUUID(),expectedVersion:current.version,command:cmd}) as QaIssue;
    await command({type:'submit_fix',summary:'',targets:[{environment:'Stage',component:'',build:'one',required:true},{environment:'Prod',component:'',build:'one',required:true}]});
    const [stage,prod]=current.targets;
    await command({type:'record_deployment',targetId:stage.id,build:'one',evidence:''});
    await command({type:'record_verification',targetId:stage.id,build:'one',result:'pass',note:''});
    await command({type:'record_deployment',targetId:prod.id,build:'one',evidence:''});
    const after:QaIssue={...current,version:current.version+1,updatedAt:'2026-11-02T01:01:00.000Z',state:'closed',resolution:'fixed',resolutionReason:'',duplicateOfId:null,closedBy:'member-a',closedAt:'2026-11-02T01:01:00.000Z',
      runs:[...current.runs,{id:'formal-final-run',sequence:2,fixCycle:current.fixCycle,targetId:prod.id,environment:prod.environment,component:prod.component,build:prod.build,result:'pass',note:'',testerId:'member-a',createdAt:'2026-11-02T01:01:00.000Z'}]};
    const mutations:Array<(issue:QaIssue)=>void>=[issue=>{issue.closedBy='other';},issue=>{issue.closedAt='old';},issue=>{issue.runs.at(-1)!.build='old';},issue=>{issue.runs.at(-1)!.fixCycle=0;},issue=>{issue.runs[0].note='rewritten';},issue=>{issue.runs.at(-1)!.id=null as never;},issue=>{issue.runs.at(-1)!.id=123 as never;},issue=>{issue.runs[0].result='fail';}];
    const count=Number(db.prepare("SELECT count(*) AS n FROM qa_commands WHERE workspace_id='ws-a'").get()?.n);
    for(const mutate of mutations){const invalid=structuredClone(after);mutate(invalid);
      expect(()=>db.prepare('INSERT INTO qa_commands(workspace_id,id,issue_id,actor_id,actor_role,actor_auth_id,expected_version,operation,request_hash,issue_data,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('ws-a',crypto.randomUUID(),current.id,'member-a','admin','auth-a',current.version,'record_verification','hash',JSON.stringify(invalid),JSON.stringify(invalid),'now')).toThrow('qa_invalid_request');
    }
    expect(db.prepare("SELECT count(*) AS n FROM qa_commands WHERE workspace_id='ws-a'").get()?.n).toBe(count);
    expect(JSON.parse(String(db.prepare("SELECT data FROM qa_issues WHERE workspace_id='ws-a' AND id=?").get(current.id)?.data))).toEqual(current);
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
  it('refuses Slack actions for a member who unlinked Slack, and only the member changes that setting',async()=>{
    inboxSetup();
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(String(url).includes('users.info')
      ?{ok:true,user:{id:'USER_A',team_id:'TEAM_A',profile:{email:'a@test'}}}:{ok:true,team_id:'TEAM_A'}),{headers:{'content-type':'application/json'}})));
    const env=environment(),adapter=createCloudQaSlackActions(env,'ws-a',{waitUntil:()=>{}});
    expect(await adapter.actor({team_id:'TEAM_A',user_id:'USER_A'})).toMatchObject({id:'member-a'});
    expect(await handleSlackLinkRpc(env,auth,'livo_slack_link_set',{p_enabled:false})).toEqual({disabled:true,mode:'email',linked:null});
    await expect(adapter.actor({team_id:'TEAM_A',user_id:'USER_A'})).rejects.toThrow('slack_link_disabled');
    await expect(handleSlackLinkRpc(env,auth,'livo_slack_link_set',{p_enabled:'no'})).rejects.toThrow('slack_link_forbidden');
    // Another workspace's member with the same id pattern is untouched.
    expect(db.prepare("SELECT workspace_id,member_id,linking_disabled FROM slack_link_preferences").all()).toEqual([{workspace_id:'ws-a',member_id:'member-a',linking_disabled:1}]);
    expect(await handleSlackLinkRpc(env,auth,'livo_slack_link_set',{p_enabled:true})).toMatchObject({disabled:false});
    expect(await adapter.actor({team_id:'TEAM_A',user_id:'USER_A'})).toMatchObject({id:'member-a'});
  });
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
