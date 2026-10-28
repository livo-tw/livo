// @vitest-environment node
// Real SQLite triggers, Worker adapter and generic API; synthetic fixtures only.
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const {Hono}=createRequire(new URL('../../worker/package.json',import.meta.url))('hono');
import {notifyChanges} from '../../worker/src/notify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('../../worker/src/license',()=>({isProfessional:async()=>true}));
vi.mock('../../worker/src/notify',()=>({notifyChanges:vi.fn()}));
vi.mock('../../worker/src/functions/emailNotify',()=>({sendNotificationEmails:()=>{}}));
vi.mock('../../worker/src/functions/webhooks',()=>({dispatchWebhooks:()=>{}}));
import {executeSprintCommand,parseSprintCommand,sprintError,handleSprintRpc} from '../../worker/src/sprintLifecycle';
import {runQuery} from '../../worker/src/db';
import {applyPostTenantSchemaUpgrades} from '../../worker/migrate/schema-upgrades.mjs';
let db,env,dir,file,beforeWrite;
const sql=()=>fs.readFileSync(new URL('../../worker/schema.sql',import.meta.url),'utf8');
const migration=n=>fs.readFileSync(new URL('../../worker/migrate/'+n,import.meta.url),'utf8');
const actor=(id='member',workspaceId='a')=>({userId:id,email:id+'@example.com',member:{id,role:id==='admin'?'admin':id==='super'?'super_admin':'member',workspaceId}});
const all=q=>db.prepare(q).all();
const sprint=id=>db.prepare('SELECT * FROM sprints WHERE id=?').get(id);
const task=id=>db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
const begin=(fields={})=>({commandId:randomUUID(),operation:'start',sprintId:randomUUID(),name:'Synthetic sprint',taskIds:[],includeBacklog:false,...fields});
const complete=(id,version=1,fields={})=>({commandId:randomUUID(),operation:'complete',sprintId:id,expectedVersion:version,...fields});
const run=(c,a=actor())=>executeSprintCommand(env,a,c);
const generic=(table,op,values,id,who=actor())=>runQuery(env,{waitUntil:()=>{}},who,{table,op,values,...(id?{filters:[{col:'id',op:'eq',val:id}]}:{})});
const clean=()=>expect(all('SELECT * FROM sprint_command_contexts')).toHaveLength(0);
function database(legacy=false){
 let source=sql();
 if(legacy)source=source.split('-- Atomic sprint lifecycle;')[0].replace(/^  is_cancelled .*\r?\n/m,'').replace(/^  version INTEGER NOT NULL DEFAULT 0 CHECK\(version>=0\),\r?\n/m,'').replace(/^  cancelled_count INTEGER CHECK\(cancelled_count IS NULL OR cancelled_count>=0\),\r?\n/m,'').replace(/^  history_captured_at TEXT\r?\n/m,'').replace('  is_active       INTEGER NOT NULL DEFAULT 1,','  is_active       INTEGER NOT NULL DEFAULT 1');
 db.exec(source);
}
function fixture(){
 db.exec(`INSERT INTO workspaces(id,name) VALUES('a','Synthetic A'),('b','Synthetic B');
 INSERT INTO product_lines(workspace_id,id,name) VALUES('a','la','A'),('b','lb','B');
 INSERT INTO projects(workspace_id,id,line_id,name,key,is_archived) VALUES('a','p','la','Project','P',0),('a','archived','la','Old','AR',1),('b','foreign','lb','Other','F',0);
 INSERT INTO statuses(workspace_id,id,name,is_done,is_cancelled) VALUES('a','todo','Open',0,0),('a','done','Done',1,0),('a','cancel','Custom cancellation',1,1),('b','foreign-status','Open',0,0);`);
 for(const id of ['member','other','admin','super','foreign-member']){
  const ws=id==='foreign-member'?'b':'a';db.prepare('INSERT INTO auth_users(id,email) VALUES(?,?)').run(id,id+'@example.com');
  db.prepare('INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id) VALUES(?,?,?,?,?,?,?)').run(ws,id,id,'',id+'@example.com',actor(id).member.role,id);
 }
 for(const [id,project,ws,status,creator] of [['t1','p','a','todo','member'],['t2','p','a','todo','member'],['t3','p','a','done','member'],['t4','p','a','cancel','member'],['ta','archived','a','todo','member'],['tf','foreign','b','foreign-status','foreign-member']])
  db.prepare('INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id) VALUES(?,?,?,?,?,?,?)').run(ws,id,id,project,'Synthetic '+id,status,creator);
}
class Statement{
 constructor(sql){this.sql=sql;this.args=[];}
 bind(...args){this.args=args;return this;}
 async first(){return db.prepare(this.sql).get(...this.args)||null;}
 async all(){if(this.args.length>100)throw new Error('D1 bind parameter limit exceeded');return {results:db.prepare(this.sql).all(...this.args),success:true,meta:{}};}
 async run(){if(beforeWrite&&this.sql.startsWith('INSERT INTO sprint_command_contexts')){const f=beforeWrite;beforeWrite=null;f();}const result=db.prepare(this.sql).run(...this.args);return {success:true,meta:{changes:result.changes,last_row_id:Number(result.lastInsertRowid)}};}
}
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'livo-sprint-native-'));file=path.join(dir,'fixture.sqlite');db=new DatabaseSync(expect.getState().currentTestName?.includes('busy native SQLite writer')?file:':memory:');db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1;');database();fixture();beforeWrite=null;env={DB:{prepare:s=>new Statement(s),batch:async statements=>{db.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.all());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}};},30000);
afterEach(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});},30000);

describe('native atomic sprint lifecycle',()=>{
 it('starts empty by default; opt-in includes only current eligible backlog',async()=>{
  const empty=begin();expect(await run(empty)).toMatchObject({version:1,pendingCount:0,pendingIds:[],taskIds:[],carryIds:[]});await run(complete(empty.sprintId));
  const next=begin({name:'Next',includeBacklog:true});expect(await run(next)).toMatchObject({pendingCount:2,pendingIds:['t1','t2'],taskIds:['t1','t2'],carryIds:['t1','t2']});
  expect(task('t3').sprint_id).toBeNull();expect(task('t4').sprint_id).toBeNull();expect(task('ta').sprint_id).toBeNull();expect(task('tf').sprint_id).toBeNull();clean();
 });
 it('deduplicates explicit carry-over and opt-in together, with canonical replay',async()=>{
  const c=begin({taskIds:['t2','t1','t2'],name:'  Canonical  ',includeBacklog:true});const first=await run(c);expect(first.taskIds).toEqual(['t1','t2']);
  expect(await run({...c,name:'Canonical',taskIds:['t1','t2']})).toEqual({...first,replayed:true});expect(all('SELECT * FROM sprint_command_receipts')).toHaveLength(1);clean();
 });
 for(const id of ['t3','t4','ta','tf','missing'])it('rejects explicit ineligible '+id+' before creating anything',async()=>{
  await expect(run(begin({taskIds:['t1',id]}))).rejects.toMatchObject({code:'sprint_invalid_input'});expect(all('SELECT * FROM sprints')).toHaveLength(0);expect(task('t1').sprint_id).toBeNull();clean();
 });
 it('snapshots done/cancel/pending separately and retains removed observations',async()=>{
  const c=begin({taskIds:['t1','t2']});await run(c);db.exec("UPDATE tasks SET sprint_id=NULL WHERE id='t2'; INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id,sprint_id) SELECT 'a','new','P-7','p','New member','todo','member',sprint_id FROM tasks WHERE id='t1'; UPDATE tasks SET status_id='done' WHERE id='t1';");
  db.prepare("UPDATE tasks SET sprint_id=? WHERE id='t4'").run(c.sprintId);
  const r=await run(complete(c.sprintId));expect(r).toMatchObject({version:2,completedCount:1,cancelledCount:1,pendingCount:1,pendingIds:['new'],taskIds:['new','t1','t4']});
  expect(task('new').sprint_id).toBeNull();expect(task('t1').sprint_id).toBe(c.sprintId);expect(task('t4').sprint_id).toBe(c.sprintId);
  expect(all("SELECT task_id,outcome,source FROM sprint_task_history ORDER BY task_id")).toEqual([{task_id:'new',outcome:'pending',source:'snapshot'},{task_id:'t1',outcome:'completed',source:'snapshot'},{task_id:'t2',outcome:'removed',source:'observed'},{task_id:'t4',outcome:'cancelled',source:'snapshot'}]);clean();
 });
 it('derives eligible carryIds transactionally while retaining all archived pending history',async()=>{
  const c=begin({taskIds:['t1','t2']});expect(await run(c)).toMatchObject({carryIds:['t1','t2']});
  db.exec("INSERT INTO projects(workspace_id,id,line_id,name,key,is_archived) VALUES('a','p2','la','Current project','CUR',0);UPDATE tasks SET project_id='p2' WHERE id='t2';");
  beforeWrite=()=>db.exec("UPDATE projects SET is_archived=1 WHERE workspace_id='a' AND id='p'");const command=complete(c.sprintId);const ended=await run(command);
  expect(ended).toMatchObject({pendingCount:2,pendingIds:['t1','t2'],taskIds:['t1','t2'],carryIds:['t2']});expect(task('t1').sprint_id).toBeNull();expect(task('t2').sprint_id).toBeNull();expect(all("SELECT task_id,outcome FROM sprint_task_history WHERE sprint_id='"+c.sprintId+"' ORDER BY task_id")).toEqual([{task_id:'t1',outcome:'pending'},{task_id:'t2',outcome:'pending'}]);
  db.exec("UPDATE projects SET is_archived=0 WHERE id='p'");expect(await run(command)).toEqual({...ended,replayed:true});const next=await run(begin({name:'Next with eligible carry',taskIds:ended.carryIds}));expect(next.taskIds).toEqual(['t2']);expect(task('t1').sprint_id).toBeNull();clean();
 });
 it('preserves immutable old snapshots across later sprints, changes and deletion',async()=>{
  const first=begin({taskIds:['t1']});await run(first);await run(complete(first.sprintId));const snapshot=all('SELECT * FROM sprint_task_history');const second=begin({name:'Second',taskIds:['t1']});await run(second);db.exec("UPDATE tasks SET title='Later title',status_id='done' WHERE id='t1'");await run(complete(second.sprintId));
  expect(all(`SELECT * FROM sprint_task_history WHERE sprint_id='${first.sprintId}'`)).toEqual(snapshot);db.exec("DELETE FROM tasks WHERE id='t1'");expect(all('SELECT * FROM sprint_task_history')).toHaveLength(2);expect((await generic('sprint_task_history','select')).data).toHaveLength(2);
  expect(()=>db.exec("UPDATE sprint_task_history SET title='Forged'")).toThrow(/sprint_forbidden/);expect(()=>db.exec('DELETE FROM sprint_task_history')).toThrow(/sprint_forbidden/);clean();
 });
 it('rolls back all writes/history/receipt if one task move fails',async()=>{
  db.exec("CREATE TRIGGER synthetic_move_failure BEFORE UPDATE OF sprint_id ON tasks WHEN NEW.id='t2' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  await expect(run(begin({taskIds:['t1','t2']}))).rejects.toBeTruthy();expect(all('SELECT * FROM sprints')).toHaveLength(0);expect(all('SELECT * FROM sprint_task_history')).toHaveLength(0);expect(all('SELECT * FROM sprint_command_receipts')).toHaveLength(0);expect(task('t1').sprint_id).toBeNull();clean();
 });
 it('rolls back closure and final snapshots if pending detach fails',async()=>{
  const c=begin({taskIds:['t1','t2']});await run(c);const prior=all('SELECT * FROM sprint_task_history');db.exec("CREATE TRIGGER synthetic_detach_failure BEFORE UPDATE OF sprint_id ON tasks WHEN NEW.id='t2' AND NEW.sprint_id IS NULL BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
  await expect(run(complete(c.sprintId))).rejects.toBeTruthy();expect(sprint(c.sprintId).is_active).toBe(1);expect(sprint(c.sprintId).version).toBe(1);expect(all('SELECT * FROM sprint_task_history')).toEqual(prior);expect(task('t1').sprint_id).toBe(c.sprintId);expect(all('SELECT * FROM sprint_command_receipts')).toHaveLength(1);clean();
 });
 it('replays a lost response once; changed payload or actor conflicts',async()=>{
  const c=begin({taskIds:['t1']});const a=await run(c);expect(await run(c)).toEqual({...a,replayed:true});await expect(run({...c,name:'Different'})).rejects.toMatchObject({code:'sprint_command_reused'});await expect(run(c,actor('other'))).rejects.toMatchObject({code:'sprint_command_reused'});
  const done=complete(c.sprintId);const d=await run(done);expect(await run(done)).toEqual({...d,replayed:true});expect(sprint(c.sprintId).version).toBe(2);clean();
 });
 it('only one concurrent start succeeds; distinct stale completes conflict',async()=>{
  const a=begin({taskIds:['t1']}),b=begin({name:'Other',taskIds:['t2']});const starts=await Promise.allSettled([run(a),run(b)]);expect(starts.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(starts.find(v=>v.status==='rejected').reason.code).toBe('sprint_conflict');const id=all('SELECT id FROM sprints')[0].id;
  const ends=await Promise.allSettled([run(complete(id)),run(complete(id))]);expect(ends.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(ends.find(v=>v.status==='rejected').reason.code).toBe('sprint_conflict');expect(sprint(id).version).toBe(2);clean();
 });
 it('same concurrent command creates only one receipt and returns a replay',async()=>{const c=begin({taskIds:['t1']});const r=await Promise.all([run(c),run(c)]);expect(r.filter(v=>v.replayed)).toHaveLength(1);expect(all('SELECT * FROM sprint_command_receipts')).toHaveLength(1);clean();});
 it('busy native SQLite writer returns conflict without partial effects',async()=>{const writer=new DatabaseSync(file);writer.exec('BEGIN IMMEDIATE');try{await expect(run(begin())).rejects.toMatchObject({code:'sprint_conflict'});}finally{writer.exec('ROLLBACK');writer.close();}expect(all('SELECT * FROM sprints')).toHaveLength(0);clean();});
 it('rename increments version, invalidates old completion, and stays generic-name-only',async()=>{
  const c=begin();await run(c);const response=await generic('sprints','update',{name:' Renamed '},c.sprintId);expect(response.error).toBeNull();expect(sprint(c.sprintId).version).toBe(2);await expect(run(complete(c.sprintId))).rejects.toMatchObject({code:'sprint_conflict'});expect(await run(complete(c.sprintId,2))).toMatchObject({version:3});
  for(const values of [{version:9},{is_active:true},{cancelled_count:99},{history_captured_at:'forged'}])expect((await generic('sprints','update',values,c.sprintId)).error).toBeTruthy();clean();
 });
 for(const role of ['member','admin','super'])it(role+' retains existing command rights but cannot forge internal tables',async()=>{
  const c=begin();await run(c,actor(role));for(const table of ['sprint_task_history','sprint_command_contexts','sprint_command_receipts'])expect((await generic(table,'insert',{id:'forged'},null,actor(role))).error).toBeTruthy();expect((await generic('sprints','insert',{id:randomUUID(),name:'Bypass'},null,actor(role))).error).toBeTruthy();clean();
 });
 for(const mode of ['inactive','banned','rebound','ambiguous'])it('rechecks '+mode+' actor inside transaction',async()=>{
  beforeWrite=()=>db.exec(mode==='inactive'?"UPDATE members SET is_active=0 WHERE id='member'":mode==='banned'?"UPDATE auth_users SET banned=1 WHERE id='member'":mode==='rebound'?"UPDATE members SET auth_id='other' WHERE id='member'":"INSERT INTO members(workspace_id,id,name,avatar,email,auth_id) VALUES('a','duplicate','Duplicate','','duplicate@example.com','member')");
  await expect(run(begin())).rejects.toMatchObject({code:'sprint_forbidden'});expect(all('SELECT * FROM sprints')).toHaveLength(0);clean();
 });
 it('PAT must remain unrevoked and linked to its own active login',async()=>{
  db.exec("INSERT INTO api_tokens(workspace_id,id,name,token_hash,member_id,created_by) VALUES('a','token','Synthetic','hash','member','member')");const auth={...actor(),userId:'pat:token'};await run(begin(),auth);db.exec("UPDATE api_tokens SET revoked_at='now' WHERE id='token'");await expect(run(begin({name:'Denied'}),auth)).rejects.toMatchObject({code:'sprint_forbidden'});clean();
 });
 it('workspace isolation covers commands, receipts and historical reads',async()=>{
  const c=begin({taskIds:['t1']});await run(c);await run(complete(c.sprintId));expect((await generic('sprint_task_history','select',null,null,actor('foreign-member','b'))).data).toEqual([]);await expect(run(complete(c.sprintId),actor('foreign-member','b'))).rejects.toMatchObject({code:'sprint_not_found'});db.exec("UPDATE members SET is_active=0 WHERE id='member'");expect((await generic('sprint_task_history','select')).data).toEqual([]);clean();
 });
 it('completion classifies transactional live status and cancellation takes precedence',async()=>{const c=begin({taskIds:['t1']});await run(c);beforeWrite=()=>db.exec("UPDATE tasks SET status_id='cancel' WHERE id='t1'");expect(await run(complete(c.sprintId))).toMatchObject({completedCount:0,cancelledCount:1,pendingCount:0});clean();});
 it('new child inherits only active parent sprint and never a completed sprint',async()=>{
  const c=begin({taskIds:['t1']});await run(c);db.prepare("INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id,parent_task_id) VALUES('a','child','P-8','p','Child','todo','member','t1')").run();expect(task('child').sprint_id).toBe(c.sprintId);db.exec("UPDATE tasks SET status_id='done' WHERE id IN('t1','child')");await run(complete(c.sprintId));db.prepare("INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id,parent_task_id,sprint_id) VALUES('a','later','P-9','p','Later','todo','member','t1',?)").run(c.sprintId);expect(task('later').sprint_id).toBeNull();expect(all("SELECT * FROM sprint_task_history WHERE task_id='later'")).toHaveLength(0);clean();
 });
 it('does not accept an already assigned card or a stale expectedVersion',async()=>{const a=begin({taskIds:['t1']});await run(a);await expect(run(complete(a.sprintId,0))).rejects.toMatchObject({code:'sprint_conflict'});await run(complete(a.sprintId));db.exec("UPDATE tasks SET status_id='done' WHERE id='t1'");await expect(run(begin({name:'Second',taskIds:['t1']}))).rejects.toMatchObject({code:'sprint_invalid_input'});clean();});
 it('reapplies the real full upgrade chain twice preserving snapshots and receipts',async()=>{
  const c=begin({taskIds:['t1']});await run(c);await run(complete(c.sprintId));const old=all('SELECT * FROM sprint_task_history');for(let n=0;n<2;n++)await applyPostTenantSchemaUpgrades({queryRows:async s=>all(s),applyFile:async n=>db.exec(migration(n))});expect(all('SELECT * FROM sprint_task_history')).toEqual(old);expect(all('SELECT * FROM sprint_command_receipts')).toHaveLength(2);clean();
 });
 it('delivers complete task realtime rows beyond one D1 bind batch',async()=>{
  const ids=[];for(let i=0;i<121;i++){const id='many-'+i;ids.push(id);db.prepare("INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id) VALUES('a',?,?, 'p',?,'todo','member')").run(id,id,'Synthetic '+i);}
  const app=new Hono();app.post('/sprint',c=>{c.set('auth',actor());return handleSprintRpc(c);});const command=begin({taskIds:ids});
  vi.mocked(notifyChanges).mockClear();const response=await app.fetch(new Request('https://example.com/sprint',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_command:command})}),env,{waitUntil:()=>{},passThroughOnException:()=>{}});
  expect(response.status).toBe(200);const events=vi.mocked(notifyChanges).mock.calls[0][2];const updates=events.filter(e=>e.table==='tasks');expect(updates).toHaveLength(121);expect(updates.every(e=>typeof e.new.title==='string'&&e.new.project_id==='p')).toBe(true);clean();
 });
 it('maps malformed and oversized RPC bodies to known invalid-input errors',async()=>{
  const app=new Hono();app.post('/sprint',c=>{c.set('auth',actor());return handleSprintRpc(c);});
  for(const [body,status] of [['{',400],[JSON.stringify({p_command:begin(),actor:'forged'}),400],[' '.repeat(1024*1024+1),413]]){
   const response=await app.fetch(new Request('https://example.com/sprint',{method:'POST',body}),env,{waitUntil:()=>{},passThroughOnException:()=>{}});expect(response.status).toBe(status);expect((await response.json()).error.message).toBe('sprint_invalid_input');
  }expect(all('SELECT * FROM sprints')).toHaveLength(0);clean();
 });
 it('completes an existing active legacy text sprint id without changing its identity',async()=>{
  db.exec("INSERT INTO sprints(workspace_id,id,name,is_active) VALUES('a','legacy-active','Legacy active',1);UPDATE tasks SET sprint_id='legacy-active' WHERE id='t1';");
  const result=await run(complete('legacy-active',0));expect(result).toMatchObject({sprintId:'legacy-active',version:1,pendingCount:1,pendingIds:['t1']});expect(task('t1').sprint_id).toBeNull();expect(sprint('legacy-active').is_active).toBe(0);clean();
 });
 it('blocks destructive Jira clear before any deletion when sprint history or receipts exist',async()=>{
  const c=begin({taskIds:['t1']});await run(c);const before=all('SELECT * FROM tasks');
  expect(()=>db.exec("BEGIN;INSERT INTO task_planning_import_guard(workspace_id) VALUES('a');DELETE FROM tasks WHERE workspace_id='a';DELETE FROM sprints WHERE workspace_id='a';COMMIT;")).toThrow('work_history_requires_restore');
  db.exec('ROLLBACK');expect(all('SELECT * FROM tasks')).toEqual(before);expect(sprint(c.sprintId).is_active).toBe(1);expect(all('SELECT * FROM sprint_task_history')).toHaveLength(1);clean();
 });
 it('migrates legacy closed associations as unknown without inventing a cancellation split',()=>{
  db.close();db=new DatabaseSync(':memory:');database(true);db.exec("INSERT INTO workspaces(id,name) VALUES('legacy','Legacy');INSERT INTO product_lines(workspace_id,id,name) VALUES('legacy','line','Line');INSERT INTO projects(workspace_id,id,line_id,name,key) VALUES('legacy','project','line','Project','P');INSERT INTO statuses(workspace_id,id,name,is_done) VALUES('legacy','s7','Renamed legacy status',1),('legacy','custom-s7','Custom',1);INSERT INTO sprints(workspace_id,id,name,is_active,completed_count,pending_count) VALUES('legacy','old','Old',0,3,4);INSERT INTO members(workspace_id,id,name,avatar,email,role,is_active) VALUES('legacy','creator','Synthetic','','creator@example.com','member',1);INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,sprint_id,creator_id) VALUES('legacy','old-task','P-1','project','Legacy','s7','old','creator');");db.exec(migration('sprint-lifecycle-alters.sql'));db.exec(migration('sprint-lifecycle.sql'));expect(all("SELECT is_cancelled FROM statuses WHERE id='s7'")[0].is_cancelled).toBe(1);expect(all("SELECT is_cancelled FROM statuses WHERE id='custom-s7'")[0].is_cancelled).toBe(0);expect(sprint('old')).toMatchObject({completed_count:3,pending_count:4,cancelled_count:null,history_captured_at:null,version:0});expect(all('SELECT outcome,source FROM sprint_task_history')).toEqual([{outcome:'unknown',source:'legacy'}]);db.exec(migration('sprint-lifecycle.sql'));expect(all('SELECT * FROM sprint_task_history')).toHaveLength(1);
 });
 it('rejects forged protocol fields and limits command size before mutation',()=>{
  for(const c of [begin({actor:'forged'}),begin({taskIds:Array(2001).fill('t1')}),begin({includeBacklog:'yes'}),complete(randomUUID(),-1),begin({name:' '.repeat(2)}),begin({sprintId:'not-uuid'})])expect(()=>parseSprintCommand(c)).toThrow(/sprint_invalid_input/);
  expect(parseSprintCommand(begin({taskIds:['t2','t1','t1']})).taskIds).toEqual(['t1','t2']);expect(sprintError(new Error('SQLITE_BUSY'))).toMatchObject({code:'sprint_conflict',status:409});
 });
});
