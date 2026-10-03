// @vitest-environment node
// Actual SQLite schema/triggers and Worker adapter. Only synthetic data.
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('../../worker/src/license',()=>({isProfessional:async()=>true}));
vi.mock('../../worker/src/notify',()=>({notifyChanges:()=>Promise.resolve()}));
vi.mock('../../worker/src/functions/emailNotify',()=>({sendNotificationEmails:()=>Promise.resolve()}));
vi.mock('../../worker/src/functions/webhooks',()=>({dispatchWebhooks:()=>Promise.resolve()}));
import {executeTaskWorkCommand} from '../../worker/src/taskWork';
import {canonicalTaskWorkPayload,parseTaskWorkCommand} from '../../worker/src/taskWorkCore';
import {runQuery} from '../../worker/src/db';
import {applyPostTenantSchemaUpgrades} from '../../worker/migrate/schema-upgrades.mjs';
import {assertTaskWorkImportSafe} from '../../worker/migrate/task-work-import-guard.mjs';

let db,env,beforeMutation,dir,filename,seq;
const actor=(id='member',workspaceId='a')=>({userId:id,email:id+'@example.test',member:{id,role:id==='admin'?'admin':id==='super'?'super_admin':'member',workspaceId}});
const rows=sql=>db.prepare(sql).all();
const task=(id='t')=>db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const command=(operation,fields={},taskId='t')=>({commandId:'work-native-'+(++seq),operation,taskId,...fields});
const add=(list='checks',taskId='t')=>command('add_item',{list,text:'Synthetic item',isDone:false},taskId);
const child=(fields={},taskId='t')=>command('create_subtask',{title:'Synthetic child',statusId:'todo',priority:'medium',assigneeId:'member',reviewerId:'other',dueDate:null,...fields},taskId);
const run=(c,who=actor())=>executeTaskWorkCommand(env,who,c);
const query=(table,op,values,id='t',who=actor())=>runQuery(env,{waitUntil:()=>{}},who,{table,op,values,filters:[{col:'id',op:'eq',val:id}]});
const assertAtomic=()=>{expect(rows('SELECT * FROM task_work_contexts')).toHaveLength(0);expect(rows('SELECT * FROM task_work_internal_versions')).toHaveLength(0);expect(rows('SELECT * FROM task_work_receipts')).toHaveLength(rows('SELECT * FROM task_work_events').length);};
// Bootstrap the real schema atomically; avoid a disk sync for every DDL statement. Test writes retain their original transactions.
beforeEach(()=>{
 seq=0;dir=fs.mkdtempSync(path.join(os.tmpdir(),'livo-task-work-native-'));filename=path.join(dir,'synthetic.sqlite');
 db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
 db.exec('BEGIN;');try{db.exec(fs.readFileSync(new URL('../../worker/schema.sql',import.meta.url),'utf8'));db.exec('COMMIT;');}catch(error){db.exec('ROLLBACK;');throw error;}
 db.exec(`INSERT INTO workspaces(id,name) VALUES('a','Synthetic A'),('b','Synthetic B');
 INSERT INTO product_lines(workspace_id,id,name) VALUES('a','la','A'),('b','lb','B');
 INSERT INTO projects(workspace_id,id,line_id,name,key,is_archived) VALUES('a','p','la','P','P',0),('a','q','la','Q','Q',0),('a','archived','la','Archived','AR',1),('b','foreign','lb','Foreign','F',0);
 INSERT INTO statuses(workspace_id,id,name) VALUES('a','todo','Todo'),('b','foreign-status','Todo');`);
 for(const id of ['member','other','admin','super','foreign-member']){
  const ws=id==='foreign-member'?'b':'a';
  db.prepare('INSERT INTO auth_users(id,email) VALUES(?,?)').run(id,id+'@example.test');
  db.prepare('INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id) VALUES(?,?,?,?,?,?,?)').run(ws,id,id,'',id+'@example.test',actor(id).member.role,id);
 }
 for(const [id,p,ws,s,creator] of [['t','p','a','todo','member'],['t2','p','a','todo','member'],['t3','p','a','todo','member'],['tq','q','a','todo','member'],['ta','archived','a','todo','member'],['tf','foreign','b','foreign-status','foreign-member']])
  db.prepare('INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id,assignee_id,reviewer_id) VALUES(?,?,?,?,?,?,?,?,?)').run(ws,id,id,p,'Synthetic task',s,creator,creator,ws==='a'?'other':creator);
 beforeMutation=null;
 class Statement{
  constructor(sql){this.sql=sql;this.args=[];}
  bind(...args){this.args=args;return this;}
  check(){if(beforeMutation&&/^\s*INSERT INTO task_work_contexts/i.test(this.sql)){const fn=beforeMutation;beforeMutation=null;fn();}}
  async first(){this.check();return db.prepare(this.sql).get(...this.args)??null;}
  async all(){this.check();return{results:db.prepare(this.sql).all(...this.args),success:true};}
  async run(){this.check();return{meta:db.prepare(this.sql).run(...this.args),success:true};}
 }
 env={DB:{prepare:sql=>new Statement(sql),batch:async statements=>{db.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.all());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}}};
});
afterEach(()=>{db?.close();if(dir&&path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(dir).startsWith('livo-task-work-native-'))fs.rmSync(dir,{recursive:true,force:true});});

describe('TaskWork native SQLite parity',()=>{
 it('reapplies real post-tenant upgrades twice preserving versions and receipts',async()=>{
  const c=add(),r=await run(c);
  await run(command('update_item',{list:'checks',itemId:r.record.id,expectedVersion:0,text:'Changed'}));
  for(let i=0;i<2;i++)await applyPostTenantSchemaUpgrades({queryRows:async sql=>rows(sql),applyFile:async file=>db.exec(fs.readFileSync(new URL('../../worker/migrate/'+file,import.meta.url),'utf8')),log:()=>{}});
  expect(rows('SELECT version FROM task_checks')[0].version).toBe(1);expect(rows('SELECT * FROM task_work_receipts')).toHaveLength(2);expect((await run(c)).replayed).toBe(true);assertAtomic();
 });
 for(const role of ['member','admin','super'])it(role+' can mutate by current floor but cannot forge receipt tables',async()=>{
  expect((await run(add(),actor(role))).replayed).toBe(false);
  for(const table of ['task_work_receipts','task_work_events','task_work_contexts','task_work_internal_versions'])expect((await query(table,'insert',{id:'forged'},'forged',actor(role))).error).toBeTruthy();
  assertAtomic();
 });
 for(const mode of ['inactive','banned','ambiguous','archived','cross-workspace'])it('rejects '+mode+' live authority',async()=>{
  if(mode==='inactive')db.exec("UPDATE members SET is_active=0 WHERE id='member'");
  if(mode==='banned')db.exec("UPDATE auth_users SET banned=1 WHERE id='member'");
  if(mode==='ambiguous')db.exec("INSERT INTO members(workspace_id,id,name,avatar,email,auth_id) VALUES('a','duplicate','Duplicate','','duplicate@example.com','member')");
  await expect(run(add('checks',mode==='archived'?'ta':mode==='cross-workspace'?'tf':'t'))).rejects.toThrow(/work_(unavailable|forbidden)/);assertAtomic();expect(rows('SELECT * FROM task_checks')).toHaveLength(0);
 });
 for(const mode of ['inactive','archived','banned'])it('rechecks '+mode+' between pre-read and transactional write',async()=>{
  beforeMutation=()=>db.exec(mode==='inactive'?"UPDATE members SET is_active=0 WHERE id='member'":mode==='archived'?"UPDATE projects SET is_archived=1 WHERE id='p'":"UPDATE auth_users SET banned=1 WHERE id='member'");
  await expect(run(add())).rejects.toThrow(/work_(unavailable|forbidden)/);assertAtomic();expect(rows('SELECT * FROM task_checks')).toHaveLength(0);
 });
 it('same command replays once, changed body or actor cannot reuse it',async()=>{
  const c=add(),first=await run(c),second=await run(c);
  expect(second).toEqual({...first,replayed:true});expect(rows('SELECT * FROM task_checks')).toHaveLength(1);
  await expect(run({...c,text:'Different'})).rejects.toThrow('work_command_reused');
  await expect(run(c,actor('other'))).rejects.toThrow('work_command_reused');
  expect((await query('tasks','update',{title:'Current title',assignee_id:'other'})).error).toBeFalsy();
  const refreshed=await run(c);expect(refreshed.task.title).toBe('Current title');expect(refreshed.task.assignee_revision).toBe(1);expect(refreshed.eventId).toBe(first.eventId);
  db.exec("UPDATE members SET is_active=0 WHERE id='member'");
  await expect(run(c)).rejects.toThrow(/work_(unavailable|forbidden)/);assertAtomic();
 });
 for(const list of ['checks','todos'])it(list+' add/edit/toggle/delete CAS and generic update revision',async()=>{
  const added=await run(add(list)),id=added.record.id;
  const edited=await run(command('update_item',{list,itemId:id,expectedVersion:0,text:'Changed',isDone:true}));
  expect(edited.record.version).toBe(1);expect(Boolean(edited.record.is_done)).toBe(true);
  await expect(run(command('delete_item',{list,itemId:id,expectedVersion:0}))).rejects.toThrow('work_conflict');
  await expect(run(command('update_item',{list,itemId:id,expectedVersion:1,text:'Wrong task'},'t2'))).rejects.toThrow('work_conflict');
  const generic=await query('task_'+list,'update',{text:'Generic edit'},id);expect(generic.error).toBeFalsy();
  expect(rows('SELECT version FROM task_'+list)[0].version).toBe(2);
  const removed=await run(command('delete_item',{list,itemId:id,expectedVersion:2}));expect(removed.removedId).toBe(id);
  expect(rows('SELECT * FROM task_'+list)).toHaveLength(0);assertAtomic();
 });
 it('acknowledgement is role-specific and A to B to A invalidates old revision',async()=>{
  const ack=command('acknowledge',{role:'assignee',expectedRevision:0});
  expect((await run(ack)).task.assignee_acknowledged_at).toBeTruthy();
  await expect(run(command('acknowledge',{role:'assignee',expectedRevision:0}),actor('admin'))).rejects.toThrow('work_forbidden');
  await expect(run(command('acknowledge',{role:'reviewer',expectedRevision:0}))).rejects.toThrow('work_forbidden');
  await run(command('acknowledge',{role:'reviewer',expectedRevision:0}),actor('other'));
  expect((await query('tasks','update',{assignee_id:'other'})).error).toBeFalsy();
  expect((await query('tasks','update',{assignee_id:'member'})).error).toBeFalsy();
  expect(task().assignee_revision).toBe(2);expect(task().assignee_acknowledged_at).toBeNull();
  await expect(run(command('acknowledge',{role:'assignee',expectedRevision:0}))).rejects.toThrow('work_conflict');
  await run(command('acknowledge',{role:'assignee',expectedRevision:2}));
  expect(task().status_id).toBe('todo');expect(task().approval_status).toBeNull();expect(task().reviewer_revision).toBe(0);assertAtomic();
 });
 it('generic clients cannot forge revision or acknowledgement fields',async()=>{
  expect((await query('tasks','update',{assignee_revision:4})).error).toBeTruthy();
  expect((await query('tasks','update',{assignee_acknowledged_at:'2027-01-01'})).error).toBeTruthy();
  const r=await run(add());expect((await query('task_checks','update',{version:99},r.record.id)).error).toBeTruthy();
  expect(task().assignee_revision).toBe(0);expect(rows('SELECT version FROM task_checks')[0].version).toBe(0);
 });
 it('create child atomically with parent project, creator, spec, log and receipt',async()=>{
  db.exec("INSERT INTO sprints(workspace_id,id,name) VALUES('a','parent-sprint','Synthetic sprint'); UPDATE tasks SET sprint_id='parent-sprint' WHERE id='t'");
  const c=child(),r=await run(c),id=r.record.id;
  expect(r.record.project_id).toBe('p');expect(r.record.parent_task_id).toBe('t');expect(task(id).creator_id).toBe('member');
  expect(task(id).sprint_id).toBe('parent-sprint');
  expect(rows('SELECT * FROM task_specs').filter(x=>x.task_id===id)).toHaveLength(1);
  expect(rows('SELECT * FROM status_logs').filter(x=>x.task_id===id)).toHaveLength(1);
  expect((await run(c)).record.id).toBe(id);
  await expect(run(child({},id))).rejects.toThrow('work_invalid_parent');assertAtomic();
 });
 for(const [label,fields,code] of [['foreign status',{statusId:'foreign-status'},'work_invalid_input'],['foreign member',{assigneeId:'foreign-member'},'work_member_unavailable'],['missing member',{reviewerId:'missing'},'work_member_unavailable']])it('child rejects '+label,async()=>{
  await expect(run(child(fields))).rejects.toThrow(code);expect(rows('SELECT * FROM tasks WHERE parent_task_id IS NOT NULL')).toHaveLength(0);assertAtomic();
 });
 it('required deadline and custom fields cannot be skipped',async()=>{
  db.exec(`INSERT INTO system_settings(workspace_id,key,value) VALUES('a','required_fields','{"dueDate":true}')`);
  await expect(run(child())).rejects.toThrow('work_required_fields');await run(child({dueDate:'2027-01-31'}));
  db.exec(`UPDATE system_settings SET value='{}'; INSERT INTO custom_fields(workspace_id,id,project_id,field_name,field_type,is_required) VALUES('a','required','p','Required','text',1)`);
  await expect(run(child())).rejects.toThrow('work_required_fields');assertAtomic();
 });
 it('dependency preserves cross-project, rejects cross-tenant and multi-node cycles',async()=>{
  const edge=await run(command('add_dependency',{dependsOnTaskId:'tq'}));
  await expect(run(command('add_dependency',{dependsOnTaskId:'tq'}))).rejects.toThrow('work_conflict');
  await expect(run(command('add_dependency',{dependsOnTaskId:'tf'}))).rejects.toThrow('work_unavailable');
  await expect(run(command('add_dependency',{dependsOnTaskId:'ta'}))).rejects.toThrow('work_unavailable');
  await expect(run(command('add_dependency',{dependsOnTaskId:'t'}))).rejects.toThrow('work_cycle');
  await run(command('add_dependency',{dependsOnTaskId:'t2'}));await run(command('add_dependency',{dependsOnTaskId:'t3'},'t2'));
  await expect(run(command('add_dependency',{dependsOnTaskId:'t'},'t3'))).rejects.toThrow('work_cycle');
  const generic=await query('task_dependencies','insert',{id:'direct-cycle',task_id:'t3',depends_on_task_id:'t'});expect(generic.error).toBeTruthy();
  await expect(run(command('remove_dependency',{dependencyId:edge.record.id},'t2'))).rejects.toThrow('work_conflict');
  expect((await run(command('remove_dependency',{dependencyId:edge.record.id}))).removedId).toBe(edge.record.id);assertAtomic();
 });
 it('strict envelope rejects identity injection, nonboolean and malformed revisions',async()=>{
  for(const c of [{...add(),actorId:'admin'},{...add(),workspaceId:'b'},{...add(),isDone:'false'},command('acknowledge',{role:'assignee',expectedRevision:-1}),child({dueDate:'2027-02-30'})])await expect(run(c)).rejects.toThrow('work_invalid_input');
  expect(rows('SELECT * FROM task_work_events')).toHaveLength(0);
 });
 it('failed trailing side effect rolls back item, audit, context and receipt',async()=>{
  db.exec("CREATE TRIGGER synthetic_fail_activity BEFORE INSERT ON activity_logs BEGIN SELECT RAISE(ABORT,'synthetic_side_effect_failure'); END;");
  await expect(run(add())).rejects.toThrow();
  expect(rows('SELECT * FROM task_checks')).toHaveLength(0);expect(rows('SELECT * FROM task_work_events')).toHaveLength(0);assertAtomic();
 });
 it('Jira import history guard runs before any child deletion',async()=>{
  await run(add());db.exec("INSERT INTO comments(workspace_id,id,task_id,user_id,content) VALUES('a','keep-comment','t','member','Synthetic')");
  db.exec('BEGIN');try{expect(()=>db.exec("INSERT INTO task_planning_import_guard(workspace_id) VALUES('a'); DELETE FROM comments WHERE workspace_id='a'; DELETE FROM tasks WHERE workspace_id='a';")).toThrow('work_history_requires_restore');}finally{db.exec('ROLLBACK');}
  expect(rows("SELECT * FROM comments WHERE id='keep-comment'")).toHaveLength(1);expect(task()).toBeTruthy();expect(rows('SELECT * FROM task_work_events')).toHaveLength(1);assertAtomic();
 });
 it('cross-database import refuses losing revision acknowledgement or audit data',()=>{
  const tables=['task_work_events','task_work_receipts','tasks','task_checks','task_todos'];
  expect(()=>assertTaskWorkImportSafe(()=>[])).not.toThrow();
  for(const [name,row] of [['task_work_events',{}],['task_work_receipts',{}],['tasks',{assignee_revision:1}],['tasks',{reviewer_revision:1}],['tasks',{assignee_acknowledged_at:'2027-01-01'}],['task_checks',{version:1}],['task_todos',{version:1}]]){
   const fixture=Object.fromEntries(tables.map(n=>[n,n===name?[row]:[]]));expect(()=>assertTaskWorkImportSafe(n=>fixture[n]??[])).toThrow('work_history_requires_restore');
  }
 });
});

const insertSql='INSERT INTO task_work_contexts(workspace_id,id,auth_id,actor_id,task_id,operation,payload,payload_hash,event_id,record_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)';
async function twoConnections(a,b){
 const gate=new SharedArrayBuffer(4),flag=new Int32Array(gate);
 const source=`const {parentPort,workerData,threadId}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(workerData.filename);d.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.gate),0,0);let result;try{d.exec('BEGIN IMMEDIATE');d.prepare(workerData.sql).run(...workerData.args);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);d.exec('COMMIT');result={status:'ok',threadId};}catch(e){try{d.exec('ROLLBACK')}catch{}result={status:'error',message:e.message,threadId};}d.close();parentPort.postMessage(result);`;
 const workers=[a,b].map(c=>{
  const canonical=canonicalTaskWorkPayload(parseTaskWorkCommand(c));
  const args=['a',c.commandId,'member','member',c.taskId,c.operation,canonical,createHash('sha256').update(canonical).digest('hex'),randomUUID(),randomUUID(),new Date().toISOString()];
  const w=new Worker(source,{eval:true,workerData:{filename,gate,sql:insertSql,args}});
  let readyResolve,resultResolve,resultReject;const ready=new Promise(r=>readyResolve=r),result=new Promise((r,j)=>{resultResolve=r;resultReject=j;});
  w.on('message',v=>v.ready?readyResolve():resultResolve(v));w.on('error',resultReject);return {w,ready,result};
 });
 try{await Promise.all(workers.map(x=>x.ready));Atomics.store(flag,0,1);Atomics.notify(flag,0,2);return await Promise.all(workers.map(x=>x.result));}
 finally{await Promise.all(workers.map(x=>x.w.terminate()));}
}
describe('TaskWork SQLite independent writer races',()=>{
 it('same command has one transaction winner then adapter replay',async()=>{
  const c=add(),results=await twoConnections(c,c);expect(new Set(results.map(x=>x.threadId)).size).toBe(2);
  expect(results.filter(x=>x.status==='ok')).toHaveLength(1);expect(results.find(x=>x.status==='error').message).toContain('work_command_reused');
  expect((await run(c)).replayed).toBe(true);expect(rows('SELECT * FROM task_checks')).toHaveLength(1);assertAtomic();
 });
 it('simultaneous opposite graph edges cannot both commit',async()=>{
  const results=await twoConnections(command('add_dependency',{dependsOnTaskId:'t2'}),command('add_dependency',{dependsOnTaskId:'t'},'t2'));
  expect(results.filter(x=>x.status==='ok')).toHaveLength(1);expect(results.find(x=>x.status==='error').message).toContain('work_cycle');expect(rows('SELECT * FROM task_dependencies')).toHaveLength(1);assertAtomic();
 });
 it('independent checklist writers enforce one expectedVersion winner',async()=>{
  const r=await run(add()),fields={list:'checks',itemId:r.record.id,expectedVersion:0};
  const results=await twoConnections(command('update_item',{...fields,text:'First'}),command('update_item',{...fields,isDone:true}));
  expect(results.filter(x=>x.status==='ok')).toHaveLength(1);expect(results.find(x=>x.status==='error').message).toContain('work_conflict');expect(rows('SELECT version FROM task_checks')[0].version).toBe(1);assertAtomic();
 });
 it('independent child writers generate distinct project task keys',async()=>{
  const results=await twoConnections(child(),child({},'t2'));expect(results.every(x=>x.status==='ok')).toBe(true);
  const children=rows('SELECT * FROM tasks WHERE parent_task_id IS NOT NULL');expect(children).toHaveLength(2);expect(new Set(children.map(x=>x.task_key)).size).toBe(2);assertAtomic();
 });
});
