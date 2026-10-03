// @vitest-environment node
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('../../worker/src/notify',()=>({notifyChanges:()=>{}}));
import {executeReleaseCommand} from '../../worker/src/releases';
import {runQuery} from '../../worker/src/db';
let db,env,sequence,intercept;
const auth=(id='admin',workspaceId='a')=>({userId:id,email:`${id}@example.com`,member:{id,role:id==='admin'?'admin':'member',workspaceId}});
const manifest={title:'Synthetic release',ownerId:'admin',components:[{id:'component',name:'Service',projectId:'p',taskIds:['task'],targets:[{environment:'Stage',build:'v1',config:'unchanged',data:'none'}]}]};
const command=(operation='create',fields={manifest},expectedVersion=0)=>({commandId:`release-native-${++sequence}`,batchId:'release',expectedVersion,operation,...fields});
beforeEach(()=>{db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');db.exec(fs.readFileSync(new URL('../../worker/schema.sql',import.meta.url),'utf8'));
 db.exec(`INSERT INTO workspaces(id,name) VALUES('a','Synthetic'),('b','Other');
 INSERT INTO product_lines(workspace_id,id,name) VALUES('a','line','Example');
 INSERT INTO projects(workspace_id,id,line_id,name,key,is_archived) VALUES('a','p','line','Project','P',0);
 INSERT INTO statuses(workspace_id,id,name) VALUES('a','todo','Todo');
 INSERT INTO auth_users(id,email) VALUES('admin','admin@example.com'),('member','member@example.com');
 INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id,is_active) VALUES('a','admin','Admin','','admin@example.com','admin','admin',1),('a','member','Member','','member@example.com','member','member',1);
 INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id) VALUES('a','task','P-1','p','Example','todo','admin');`);
 class Statement {constructor(sql){this.sql=sql;this.args=[];}bind(...args){this.args=args;return this;}check(){if(intercept&&/^INSERT INTO release_commands/.test(this.sql)){const f=intercept;intercept=null;f();}}
  async first(){this.check();return db.prepare(this.sql).get(...this.args)??null;}async all(){this.check();return {results:db.prepare(this.sql).all(...this.args),success:true};}async run(){this.check();return {meta:db.prepare(this.sql).run(...this.args),success:true};}}
 env={DB:{prepare:sql=>new Statement(sql)}};sequence=0;intercept=null;
});
afterEach(()=>db.close());
describe('release actual SQLite transaction boundary',()=>{
 it('commits aggregate, immutable event, receipt, scope references and outbox together',async()=>{
  const c=command(),r=await executeReleaseCommand(env,auth(),c);expect(r.batch.version).toBe(1);
  for(const table of ['release_batches','release_commands','release_events','release_batch_projects','release_batch_tasks','release_outbox'])expect(db.prepare(`SELECT count(*) n FROM ${table}`).get().n).toBe(1);
  const replay=await executeReleaseCommand(env,auth(),c);expect(replay.replayed).toBe(true);expect(db.prepare('SELECT count(*) n FROM release_outbox').get().n).toBe(1);
 });
 it('blocks generic CRUD of all authoritative release tables',async()=>{
  for(const table of ['release_batches','release_commands','release_events','release_batch_tasks','release_outbox','release_slack_links'])expect((await runQuery(env,{waitUntil:()=>{}},auth(),{table,op:'insert',values:{id:'spoof'}})).error).toBeTruthy();
 });
 it('rejects reusing a command with another payload',async()=>{const c=command();await executeReleaseCommand(env,auth(),c);await expect(executeReleaseCommand(env,auth(),{...c,manifest:{...manifest,title:'changed'}})).rejects.toThrow('release_command_reused');});
 it('rejects member/cross-workspace writes and revoked replay',async()=>{
  await expect(executeReleaseCommand(env,auth('member'),command())).rejects.toThrow('release_forbidden');
  await expect(executeReleaseCommand(env,auth('admin','b'),command())).rejects.toThrow('release_forbidden');
  const c=command();await executeReleaseCommand(env,auth(),c);db.exec("UPDATE members SET is_active=0 WHERE id='admin'");await expect(executeReleaseCommand(env,auth(),c)).rejects.toThrow('release_forbidden');
 });
 it('rechecks live role inside SQL after adapter context and rolls back every side effect',async()=>{
  intercept=()=>db.exec("UPDATE members SET role='member' WHERE id='admin'");await expect(executeReleaseCommand(env,auth(),command())).rejects.toThrow('release_forbidden');
  for(const table of ['release_commands','release_batches','release_events','release_outbox'])expect(db.prepare(`SELECT count(*) n FROM ${table}`).get().n).toBe(0);
 });
 it('rechecks task/project references at commit',async()=>{
  intercept=()=>db.exec("UPDATE projects SET is_archived=1 WHERE id='p'");await expect(executeReleaseCommand(env,auth(),command())).rejects.toThrow('release_reference_unavailable');
  expect(db.prepare('SELECT count(*) n FROM release_commands').get().n).toBe(0);
 });
 it('rechecks a catalog disabled after planning and rolls back aggregate and receipt',async()=>{
  intercept=()=>db.exec(`INSERT INTO system_settings(workspace_id,key,value) VALUES('a','deployment_environments','{"version":1,"values":["Prod"]}')`);
  await expect(executeReleaseCommand(env,auth(),command())).rejects.toThrow('release_invalid_environment');expect(db.prepare('SELECT count(*) n FROM release_commands').get().n).toBe(0);
 });
 it('keeps all state atomic if outbox persistence fails',async()=>{
  db.exec("CREATE TRIGGER fail_release_outbox BEFORE INSERT ON release_outbox BEGIN SELECT RAISE(ABORT,'synthetic outbox failure'); END;");
  await expect(executeReleaseCommand(env,auth(),command())).rejects.toThrow('release_unavailable');for(const table of['release_batches','release_commands','release_events','release_batch_tasks','release_outbox'])expect(db.prepare(`SELECT count(*) n FROM ${table}`).get().n).toBe(0);
 });
 it('records closed-batch rollback and maintenance without reopening or changing task state',async()=>{
  let {batch}=await executeReleaseCommand(env,auth(),command());({batch}=await executeReleaseCommand(env,auth(),command('start_attempt',{environment:'Stage',componentIds:['component'],note:'Observed'},batch.version)));
  ({batch}=await executeReleaseCommand(env,auth(),command('record_result',{attemptId:batch.attempts[0].id,type:'deployed',note:'Observed',url:null},batch.version)));
  ({batch}=await executeReleaseCommand(env,auth(),command('complete',{note:'Original closure'},batch.version)));
  ({batch}=await executeReleaseCommand(env,auth(),command('record_result',{attemptId:batch.attempts[0].id,type:'rollback',note:'Rollback after closure',url:null},batch.version)));
  ({batch}=await executeReleaseCommand(env,auth(),command('record_maintenance',{type:'start',impact:'Service',note:'Observed maintenance'},batch.version)));
  expect(batch.status).toBe('completed');expect(batch.closureNote).toBe('Original closure');expect(db.prepare("SELECT status_id FROM tasks WHERE id='task'").get().status_id).toBe('todo');
 });
 it('serializes two different commands with the same expected version',async()=>{
  await executeReleaseCommand(env,auth(),command());
  const results=await Promise.allSettled([executeReleaseCommand(env,auth(),command('request_exception',{scope:'QA',reason:'One'},1)),executeReleaseCommand(env,auth(),command('request_exception',{scope:'UAT',reason:'Two'},1))]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')[0].reason.message).toBe('release_conflict');
  expect(db.prepare('SELECT version FROM release_batches').get().version).toBe(2);expect(db.prepare('SELECT count(*) n FROM release_outbox').get().n).toBe(2);
 });
 it('protects release-linked task history from destructive deletion',async()=>{await executeReleaseCommand(env,auth(),command());expect(()=>db.exec("DELETE FROM tasks WHERE id='task'")).toThrow(/FOREIGN KEY/);expect(db.prepare('SELECT count(*) n FROM release_events').get().n).toBe(1);});
 it('applies the migration twice without losing rows',async()=>{await executeReleaseCommand(env,auth(),command());db.exec(fs.readFileSync(new URL('../../worker/migrate/release-workspace.sql',import.meta.url),'utf8'));expect(db.prepare('SELECT version FROM release_batches').get().version).toBe(1);});
});
