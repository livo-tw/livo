// @vitest-environment node
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {executeQaAction} from '../../worker/src/qa.ts';
import {runQuery} from '../../worker/src/db.ts';

let db,env,beforeBatch,serial=0,pending=[];
const role=id=>id==='super'?'super_admin':id==='admin'?'admin':'member';
const actor=(id='member',ws='a')=>({userId:id,email:id+'@example.com',member:{id,name:'Example '+id,role:role(id),email:id+'@example.com',workspaceId:ws}});
const api=(body,id='member',ws='a')=>executeQaAction(env,actor(id,ws),body,{waitUntil:p=>pending.push(p.catch(()=>{}))});
const rows=sql=>db.prepare(sql).all();
const create=(id='issue',projectId='p')=>api({action:'create',id,commandId:'create-'+(++serial),input:{projectId,title:'Example issue',actual:'Example observation',observedEnvironment:'Stage'}},'reporter');
const command=(issue,value,id='member',cid='command-'+(++serial))=>api({action:'command',id:issue.id,expectedVersion:issue.version,commandId:cid,command:value},id);
const fields=(issue,changes={})=>({type:'update_fields',projectId:issue.projectId,assigneeId:issue.assigneeId,qaOwnerId:issue.qaOwnerId,severity:issue.severity,priority:issue.priority,dueDate:issue.dueDate,...changes});
const read=id=>JSON.parse(db.prepare('SELECT data FROM qa_issues WHERE workspace_id=? AND id=?').get('a',id).data);
const immutable=i=>Object.fromEntries(Object.entries(i).filter(([key])=>!['projectId','assigneeId','qaOwnerId','severity','priority','dueDate','version','updatedAt'].includes(key)));

function bootstrap(){
 db=new DatabaseSync(':memory:');db.exec('BEGIN');
 try{db.exec(fs.readFileSync(new URL('../../worker/schema.sql',import.meta.url),'utf8'));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 db.exec(`INSERT INTO workspaces(id,name) VALUES('a','Example workspace A'),('b','Example workspace B');
 INSERT INTO product_lines(workspace_id,id,name) VALUES('a','line','Example line'),('b','foreign-line','Example line');
 INSERT INTO projects(workspace_id,id,line_id,name,key,is_archived) VALUES('a','p','line','Example project','P',0),('a','destination','line','Example destination','D',0),('a','archived','line','Example archived','A',1),('b','foreign-p','foreign-line','Example foreign','F',0);
 INSERT INTO system_settings(workspace_id,key,value) VALUES('a','feature_toggles','{"qa":true,"slackActions":false,"approvals":false}'),('b','feature_toggles','{"qa":true,"slackActions":false}');
 INSERT INTO statuses(workspace_id,id,name,sort_order) VALUES('a','todo','Example todo',0);`);
 for(const id of ['admin','super','member','reporter','developer','tester','inactive','foreign']){
  const ws=id==='foreign'?'b':'a';db.prepare('INSERT INTO auth_users(id,email) VALUES(?,?)').run(id,id+'@example.com');
  db.prepare('INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id,is_active) VALUES(?,?,?,?,?,?,?,?)').run(ws,id,'Example '+id,'',id+'@example.com',role(id),id,id==='inactive'?0:1);
 }
 class Statement{constructor(sql,args=[]){this.sql=sql;this.args=args;}bind(...args){return new Statement(this.sql,args);}async first(){return db.prepare(this.sql).get(...this.args)??null;}async all(){return {results:db.prepare(this.sql).all(...this.args),success:true};}async run(){return {success:true,meta:db.prepare(this.sql).run(...this.args)};}execute(){return {results:db.prepare(this.sql).all(...this.args),success:true};}}
 env={DB:{prepare:sql=>new Statement(sql),batch:async statements=>{if(beforeBatch){const fn=beforeBatch;beforeBatch=null;fn();}db.exec('BEGIN IMMEDIATE');try{const result=statements.map(s=>s.execute());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}},REALTIME:{idFromName:n=>n,get:()=>({fetch:async()=>new Response('ok')})}};
}
beforeEach(()=>{pending=[];beforeBatch=null;bootstrap();});
afterEach(async()=>{await Promise.all(pending);db.close();});

async function candidate(id='issue'){
 let i=await create(id);i=await command(i,{type:'triage',assigneeId:'developer',qaOwnerId:'tester',severity:'high',priority:2,dueDate:null});
 return command(i,{type:'submit_fix',summary:'',targets:[{environment:'Stage',component:'',build:'',required:true},{environment:'Live Staging',component:'',build:'',required:true}]},'developer');
}
async function complete(id='issue'){
 let i=await candidate(id);
 for(const t of i.targets){i=await command(i,{type:'record_deployment',targetId:t.id,build:'',evidence:''},'developer');i=await command(i,{type:'record_verification',targetId:t.id,build:'',result:'pass',note:''},'tester');}
 return command(i,{type:'close',resolution:'fixed',reason:''},'tester');
}
function nativeReceipt(issue,changes={},overrides={}){
 const data={...structuredClone(issue),...changes,version:issue.version+1,updatedAt:overrides.updatedAt||new Date().toISOString()};
 const receipt={workspace:'a',id:'native-'+(++serial),actor:'member',auth:'member',actorRole:'member',expected:issue.version,operation:'update_fields',...overrides};
 const stmt=db.prepare('INSERT INTO qa_commands(workspace_id,id,issue_id,actor_id,actor_role,actor_auth_id,expected_version,operation,request_hash,issue_data,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
 db.exec('BEGIN');try{stmt.run(receipt.workspace,receipt.id,issue.id,receipt.actor,receipt.actorRole,receipt.auth,receipt.expected,receipt.operation,'example-hash',JSON.stringify(data),JSON.stringify(data),data.updatedAt);}finally{db.exec('ROLLBACK');}
}

describe('QA inline metadata and optional workflow with native SQLite and real Worker adapter',()=>{
 it('empty summary/build/evidence/PASS note stay empty while every required environment gates close',async()=>{
  let i=await candidate();expect(i.fixSummary).toBe('');expect(i.targets.every(t=>t.build===''&&t.component===''&&t.deployedAt===null)).toBe(true);
  await expect(command(i,{type:'record_verification',targetId:i.targets[0].id,build:'',result:'pass',note:''},'tester')).rejects.toThrow('qa_not_deployed');
  await expect(command(i,{type:'close',resolution:'fixed',reason:''},'tester')).rejects.toThrow('qa_verification_required');
  for(const [n,t] of i.targets.entries()){
   i=await command(i,{type:'record_deployment',targetId:t.id,build:'',evidence:''},'developer');
   i=await command(i,{type:'record_verification',targetId:t.id,build:'',result:'pass',note:''},'tester');
   if(n===0){expect(i.state).toBe('verification');await expect(command(i,{type:'close',resolution:'fixed',reason:''},'tester')).rejects.toThrow('qa_verification_required');}
  }
  expect(i.state).toBe('verified');expect(i.runs.every(r=>r.build===''&&r.note===''&&r.result==='pass')).toBe(true);
  i=await command(i,{type:'close',resolution:'fixed',reason:''},'tester');expect(i.state).toBe('closed');expect(i.closedBy).toBe('tester');
 });
 it('FAIL without a note remains a real failure and cannot close as fixed',async()=>{
  let i=await candidate();i=await command(i,{type:'record_deployment',targetId:i.targets[0].id,build:'',evidence:''},'developer');
  i=await command(i,{type:'record_verification',targetId:i.targets[0].id,build:'',result:'fail',note:''},'tester');expect(i.state).toBe('failed');expect(i.runs[0].note).toBe('');
  await expect(command(i,{type:'close',resolution:'fixed',reason:''},'tester')).rejects.toThrow('qa_verification_required');expect(read(i.id)).toEqual(i);
 });
 it('optional workflow and its receipts/events survive a real restore into a fresh database',async()=>{
  const i=await complete();const tables=Object.fromEntries(['qa_issues','qa_events','qa_commands'].map(name=>[name,rows('SELECT * FROM '+name)]));
  await Promise.all(pending);pending=[];db.close();bootstrap();
  const preview=await api({action:'restore',tables,validateOnly:true},'super');expect(preview.conflicts).toEqual([]);expect(preview.pending).toBe(tables.qa_issues.length+tables.qa_events.length+tables.qa_commands.length);expect(rows('SELECT * FROM qa_issues')).toHaveLength(0);
  const saved=await api({action:'restore',tables,validateOnly:false},'super');expect(saved.inserted).toBe(preview.pending);expect(read(i.id)).toEqual(i);
  expect(rows('SELECT * FROM qa_events')).toEqual(tables.qa_events);expect(rows('SELECT * FROM qa_commands').every(r=>r.restored_by==='super')).toBe(true);
  const replay=await api({action:'restore',tables,validateOnly:false},'super');expect(replay.inserted).toBe(0);expect(replay.skipped).toBe(preview.pending);
 });
 for(const id of ['member','admin','super'])it(id+' can clear owners/date and move closed metadata while preserving evidence and audit provenance',async()=>{
  let i=await complete();const original=i,events=rows('SELECT * FROM qa_events');
  i=await command(i,fields(i,{projectId:'destination',assigneeId:null,qaOwnerId:null,severity:'untriaged',priority:5,dueDate:null}),id);
  expect(i.version).toBe(original.version+1);expect(immutable(i)).toEqual(immutable(original));expect(i).toMatchObject({state:'closed',projectId:'destination',assigneeId:null,qaOwnerId:null,dueDate:null});
  const scalar=rows('SELECT project_id,assignee_id,qa_owner_id,state,version FROM qa_issues')[0];expect(scalar).toEqual({project_id:'destination',assignee_id:null,qa_owner_id:null,state:'closed',version:i.version});
  const nowEvents=rows('SELECT * FROM qa_events');expect(nowEvents.slice(0,events.length)).toEqual(events);expect(nowEvents.at(-1)).toMatchObject({actor_id:id,type:'update_fields',version:i.version});
 });
 it('metadata replay is exactly once; reused payload and stale CAS are rejected',async()=>{
  const i=await create(),cid='inline-once',body={action:'command',id:i.id,expectedVersion:i.version,commandId:cid,command:fields(i,{priority:4})};
  const after=await api(body);expect(await api(body)).toEqual(after);expect(rows("SELECT * FROM qa_events WHERE type='update_fields'")).toHaveLength(1);
  await expect(api({...body,command:{...body.command,priority:5}})).rejects.toThrow('qa_idempotency_conflict');
  await expect(api({...body,commandId:'stale-new'})).rejects.toThrow('qa_conflict');expect(read(i.id)).toEqual(after);
 });
 it('unrelated active member may triage but gains no PASS or close capability',async()=>{
  let i=await create();i=await command(i,{type:'triage',assigneeId:'developer',qaOwnerId:'tester',severity:'low',priority:3,dueDate:null});
  expect(i.state).toBe('triaged');await expect(command(i,{type:'close',resolution:'not_bug',reason:'Example reason'})).rejects.toThrow('qa_forbidden');
  i=await command(i,{type:'submit_fix',summary:'',targets:[{environment:'Stage',component:'',build:'',required:true}]},'developer');
  await expect(command(i,{type:'record_verification',targetId:i.targets[0].id,build:'',result:'pass',note:''})).rejects.toThrow('qa_forbidden');
 });
 it('foreign/inactive/missing owners and foreign/archived projects cannot be chosen',async()=>{
  const i=await create();for(const owner of ['foreign','inactive','missing'])await expect(command(i,fields(i,{assigneeId:owner}))).rejects.toThrow('qa_member_unavailable');
  for(const project of ['foreign-p','archived'])await expect(command(i,fields(i,{projectId:project}))).rejects.toThrow('qa_project_unavailable');
  await expect(api({action:'command',id:i.id,expectedVersion:i.version,commandId:'foreign-actor',command:fields(i)},'foreign','b')).rejects.toThrow();
  await expect(command(i,fields(i),'inactive')).rejects.toThrow('qa_forbidden');expect(read(i.id)).toEqual(i);
 });
 it('linked task and duplicate references prevent incompatible project moves',async()=>{
  let i=await create();db.exec("INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id) VALUES('a','example-task','P-1','p','Example task','todo','reporter')");
  i=await command(i,{type:'link_tasks',taskIds:['example-task']},'admin');
  await expect(command(i,fields(i,{projectId:'destination'}))).rejects.toThrow('qa_task_unavailable');expect(read(i.id)).toEqual(i);
  const duplicate=await create('duplicate');let d=await create('dismissed');d=await command(d,{type:'close',resolution:'duplicate',reason:'Example duplicate',duplicateOfId:duplicate.id},'admin');
  await expect(command(d,fields(d,{projectId:'destination'}))).rejects.toThrow('qa_duplicate_unavailable');expect(read(d.id)).toEqual(d);
 });
 it('native guard permits only metadata, and rejects forged workflow, removed keys and malformed metadata',async()=>{
  const i=await complete();expect(()=>nativeReceipt(i,{assigneeId:null,qaOwnerId:null,dueDate:null,priority:2,severity:'untriaged'})).not.toThrow();
  for(const [key,value] of [['state','verified'],['targets',[]],['runs',[]],['handoff',{id:'invented'}],['taskIds',['invented']],['fixCycle',99],['reporterId','member'],['title','Invented title'],['closedAt',null],['workspaceId','b'],['id','other']])expect(()=>nativeReceipt(i,{[key]:value})).toThrow(/qa_invalid_request|qa_forbidden/);
  for(const changes of [{severity:null},{priority:null},{priority:6},{assigneeId:true},{qaOwnerId:7},{dueDate:'2099-02-30'}])expect(()=>nativeReceipt(i,changes)).toThrow('qa_invalid_request');
  const missing=structuredClone(i);delete missing.runs;expect(()=>nativeReceipt(missing)).toThrow('qa_invalid_request');expect(read(i.id)).toEqual(i);
 });
 it('native guard rechecks project/task/duplicate references and identity at the transaction boundary',async()=>{
  const i=await create();expect(()=>nativeReceipt(i,{projectId:'foreign-p'})).toThrow('qa_invalid_project');expect(()=>nativeReceipt(i,{assigneeId:'foreign'})).toThrow('qa_invalid_member');
  expect(()=>nativeReceipt(i,{}, {auth:'foreign'})).toThrow('qa_forbidden');expect(()=>nativeReceipt(i,{}, {expected:0})).toThrow('qa_conflict');
  beforeBatch=()=>db.exec("UPDATE members SET is_active=0 WHERE id='member'");await expect(command(i,fields(i,{priority:4}))).rejects.toThrow('qa_forbidden');expect(read(i.id)).toEqual(i);
 });
 it('native guard cannot drop task links to evade project consistency',async()=>{
  let i=await create();db.exec("INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id) VALUES('a','example-task','P-1','p','Example task','todo','reporter')");i=await command(i,{type:'link_tasks',taskIds:['example-task']},'admin');
  expect(()=>nativeReceipt(i,{projectId:'destination'})).toThrow('qa_invalid_task');expect(()=>nativeReceipt(i,{projectId:'destination',taskIds:[]})).toThrow('qa_invalid_request');expect(read(i.id)).toEqual(i);
 });
 it('repeat coordination migration twice preserves records and matches schema guard definitions',async()=>{
  const i=await complete(),tables=Object.fromEntries(['qa_issues','qa_events','qa_commands'].map(t=>[t,rows('SELECT * FROM '+t)]));
  const guards=()=>rows("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name IN ('qa_inline_fields_guard','qa_command_coordination_guard') ORDER BY name");const before=guards();
  for(let n=0;n<2;n++)db.exec(fs.readFileSync(new URL('../../worker/migrate/qa-coordination.sql',import.meta.url),'utf8'));
  expect(guards()).toEqual(before);for(const [t,records] of Object.entries(tables))expect(rows('SELECT * FROM '+t)).toEqual(records);
  expect(await command(i,fields(i,{assigneeId:null,qaOwnerId:null}))).toMatchObject({state:'closed',assigneeId:null,qaOwnerId:null});
 });
});

describe('deployment queue appointments use the normal query endpoint with a super_admin floor',()=>{
 const valid={version:1,enabled:true,taskStatusIds:['todo'],operatorMemberIds:['member']};
 const query=(body,id='member')=>runQuery(env,{waitUntil:()=>{}},actor(id),{table:'system_settings',...body});
 for(const id of ['member','admin'])it(id+' cannot self-appoint with insert/upsert/update or key rename',async()=>{
  db.prepare("INSERT INTO system_settings(workspace_id,key,value) VALUES('a','deployment_queue',?)").run(JSON.stringify(valid));
  for(const op of ['insert','upsert'])expect((await query({op,values:{key:'deployment_queue',value:valid}},id)).error?.code).toBe('42501');
  expect((await query({op:'update',values:{value:{...valid,operatorMemberIds:[id]}},filters:[{col:'key',op:'eq',val:'deployment_queue'}]},id)).error?.code).toBe('42501');
  expect((await query({op:'update',values:{key:'deployment_queue',value:valid},filters:[{col:'key',op:'eq',val:'feature_toggles'}]},id)).error?.code).toBe('42501');
  expect(JSON.parse(db.prepare("SELECT value FROM system_settings WHERE workspace_id='a' AND key='deployment_queue'").get().value)).toEqual(valid);
  expect((await query({op:'select',select:'key,value',filters:[{col:'key',op:'eq',val:'deployment_queue'}]},id)).error).toBeNull();
 });
 it('broad admin update cannot overwrite the protected queue setting',async()=>{
  db.prepare("INSERT INTO system_settings(workspace_id,key,value) VALUES('a','deployment_queue',?)").run(JSON.stringify(valid));
  const result=await query({op:'update',values:{value:{qa:false}},filters:[{col:'key',op:'neq',val:'unrelated-never'}]},'admin');expect(result.error).toBeNull();
  expect(JSON.parse(db.prepare("SELECT value FROM system_settings WHERE workspace_id='a' AND key='deployment_queue'").get().value)).toEqual(valid);
 });
 it('super_admin can save valid appointments but malformed values cannot commit',async()=>{
  expect((await query({op:'upsert',values:{key:'deployment_queue'}},'super')).error?.code).toBe('42501');
  expect((await query({op:'upsert',values:{key:'deployment_queue',value:valid}},'super')).error).toBeNull();
  for(const value of [null,{}, {...valid,operatorMemberIds:['member','member']},{...valid,enabled:1},{...valid,extra:true}])expect((await query({op:'upsert',values:{key:'deployment_queue',value}},'super')).error?.code).toBe('42501');
  expect(JSON.parse(db.prepare("SELECT value FROM system_settings WHERE workspace_id='a' AND key='deployment_queue'").get().value)).toEqual(valid);
 });
});

describe('trusted deployment operator capability',()=>{
 const valid={version:1,enabled:true,taskStatusIds:['todo'],operatorMemberIds:['member']};
 const activate=()=>{
  db.prepare("INSERT INTO system_settings(workspace_id,key,value) VALUES('a','deployment_queue',?)").run(JSON.stringify(valid));
  db.exec("UPDATE system_settings SET value=json_set(value,'$.deploymentQueue',json('true')) WHERE workspace_id='a' AND key='feature_toggles'");
 };
 it('assigned operator confirms one real target, retaining workflow and verification responsibilities',async()=>{
  let i=await candidate();activate();expect(await api({action:'deployment_permission'})).toEqual({deploymentOperator:true});
  const original=i;i=await command(i,{type:'record_deployment',targetId:i.targets[0].id,build:'',evidence:''});
  expect(i.targets[0]).toMatchObject({deployedBy:'member',deployedAt:i.updatedAt,deploymentEvidence:'',build:''});
  expect({...i,targets:[],version:0,updatedAt:''}).toEqual({...original,targets:[],version:0,updatedAt:''});expect(i.targets[1]).toEqual(original.targets[1]);
  await expect(command(i,{type:'record_verification',targetId:i.targets[0].id,build:'',result:'pass',note:''})).rejects.toThrow('qa_forbidden');
  await expect(command(i,{type:'close',resolution:'fixed',reason:''})).rejects.toThrow('qa_forbidden');
 });
 it('both feature gates, membership and current appointment are independently required',async()=>{
  const i=await candidate();activate();
  const confirm=()=>command(i,{type:'record_deployment',targetId:i.targets[0].id,build:'',evidence:''});
  db.exec("UPDATE system_settings SET value=json_set(value,'$.deploymentQueue',json('false')) WHERE workspace_id='a' AND key='feature_toggles'");await expect(confirm()).rejects.toThrow('qa_forbidden');
  db.exec("UPDATE system_settings SET value=json_set(value,'$.deploymentQueue',json('true')) WHERE workspace_id='a' AND key='feature_toggles';UPDATE system_settings SET value=json_set(value,'$.enabled',json('false')) WHERE workspace_id='a' AND key='deployment_queue'");await expect(confirm()).rejects.toThrow('qa_forbidden');
  db.exec("UPDATE system_settings SET value=json_set(value,'$.enabled',json('true'),'$.operatorMemberIds',json('[]')) WHERE workspace_id='a' AND key='deployment_queue'");await expect(confirm()).rejects.toThrow('qa_forbidden');
  db.prepare("UPDATE system_settings SET value=? WHERE workspace_id='a' AND key='deployment_queue'").run(JSON.stringify(valid));db.exec("UPDATE members SET is_active=0 WHERE id='member'");await expect(confirm()).rejects.toThrow('qa_forbidden');expect(read(i.id)).toEqual(i);
 });
 it('forged body flag and malformed/foreign config never grant authority',async()=>{
  const i=await candidate();await expect(command(i,{type:'record_deployment',targetId:i.targets[0].id,build:'',evidence:'',deploymentOperator:true})).rejects.toThrow();activate();
  db.exec("UPDATE system_settings SET value=json_set(value,'$.deploymentQueue',1) WHERE workspace_id='a' AND key='feature_toggles'");
  expect(await api({action:'deployment_permission'})).toEqual({deploymentOperator:false});
  const badFlagAt='2099-01-01T00:00:00.000Z',badFlagTargets=structuredClone(i.targets);badFlagTargets[0]={...badFlagTargets[0],deployedAt:badFlagAt,deployedBy:'member',deploymentEvidence:''};
  expect(()=>nativeReceipt(i,{targets:badFlagTargets},{operation:'record_deployment',updatedAt:badFlagAt})).toThrow('qa_forbidden');
  db.exec("UPDATE system_settings SET value=json_set(value,'$.deploymentQueue',json('true')) WHERE workspace_id='a' AND key='feature_toggles'");
  for(const bad of [{...valid,operatorMemberIds:['foreign']},{...valid,extra:true},{...valid,enabled:1},{...valid,operatorMemberIds:['member','member']}]){
   db.prepare("UPDATE system_settings SET value=? WHERE workspace_id='a' AND key='deployment_queue'").run(JSON.stringify(bad));expect(await api({action:'deployment_permission'})).toEqual({deploymentOperator:false});
   const when='2099-01-01T00:00:00.000Z',targets=structuredClone(i.targets);targets[0]={...targets[0],deployedAt:when,deployedBy:'member',deploymentEvidence:''};
   expect(()=>nativeReceipt(i,{targets},{operation:'record_deployment',updatedAt:when})).toThrow('qa_forbidden');
  }
 });
 it('native operator receipt cannot forge state/runs/owners/build or deploy two targets',async()=>{
  const i=await candidate();activate();const when='2099-01-01T00:00:00.000Z',targets=structuredClone(i.targets);targets[0]={...targets[0],deployedAt:when,deployedBy:'member',deploymentEvidence:''};
  const opts={operation:'record_deployment',updatedAt:when};expect(()=>nativeReceipt(i,{targets},opts)).not.toThrow();
  for(const changes of [{state:'verified'},{runs:[{result:'pass'}]},{qaOwnerId:'member'},{targets:[{...targets[0],build:'invented'},targets[1]]},{targets:targets.map(t=>({...t,deployedAt:when,deployedBy:'member',deploymentEvidence:''}))}])expect(()=>nativeReceipt(i,{targets,...changes},opts)).toThrow('qa_invalid_request');
  beforeBatch=()=>db.exec("UPDATE system_settings SET value=json_set(value,'$.deploymentQueue',json('false')) WHERE workspace_id='a' AND key='feature_toggles'");
  await expect(command(i,{type:'record_deployment',targetId:i.targets[0].id,build:'',evidence:''})).rejects.toThrow('qa_forbidden');expect(read(i.id)).toEqual(i);
 });
});
