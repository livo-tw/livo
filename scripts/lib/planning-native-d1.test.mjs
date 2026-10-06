// @vitest-environment node
// Native SQLite, actual schema and Worker query/RPC code; synthetic data only.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('../../worker/src/license', () => ({ isProfessional: async () => true }));
vi.mock('../../worker/src/notify', () => ({ notifyChanges: () => Promise.resolve() }));
vi.mock('../../worker/src/functions/emailNotify', () => ({ sendNotificationEmails: () => Promise.resolve() }));
vi.mock('../../worker/src/functions/webhooks', () => ({ dispatchWebhooks: () => Promise.resolve() }));
import { taskPlanningRpc } from '../../worker/src/taskPlanning';
import { runQuery } from '../../worker/src/db';
import { executeApprovalCommand } from '../../worker/src/approval';
import { applyPostTenantSchemaUpgrades } from '../../worker/migrate/schema-upgrades.mjs';

let db, env, beforeMutation;
const actor = (id='member', workspaceId='a') => ({ userId:id, email:`${id}@example.test`, member:{id,role:id==='super'?'super_admin':id==='admin'?'admin':'member',workspaceId} });
const future=()=>new Date(Date.now()+86400000).toISOString();
const rows=sql=>db.prepare(sql).all();
const task=()=>db.prepare("SELECT * FROM tasks WHERE id='t'").get();
const deadline=(overrides={})=>({p_task_id:'t',p_expected_version:0,p_due_date:'2027-01-20',p_kind:'committed',...overrides});
const rpc=(name,args,who=actor())=>taskPlanningRpc(env,who,name,args);
const setDate=(args={},who=actor())=>rpc('livo_set_task_deadline',deadline(args),who);
const reminder=(args={},who=actor())=>rpc('livo_set_task_reminder',{p_task_id:'t',p_until:future(),p_expected_version:0,...args},who);
const query=(values,op='update',id='t',who=actor(),table='tasks')=>runQuery(env,{waitUntil:()=>{}},who,{table,op,values,filters:[{col:'id',op:'eq',val:id}]});

beforeEach(()=>{
 db=new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
 db.exec(fs.readFileSync(new URL('../../worker/schema.sql',import.meta.url),'utf8'));
 db.exec(`INSERT INTO workspaces(id,name) VALUES('a','Synthetic A'),('b','Synthetic B');
 INSERT INTO product_lines(workspace_id,id,name) VALUES('a','line-a','A'),('b','line-b','B');
 INSERT INTO projects(workspace_id,id,line_id,name,key,is_archived) VALUES('a','p','line-a','P','P',0),('a','archived','line-a','Archived','AR',1),('b','foreign','line-b','Foreign','B',0);
 INSERT INTO statuses(workspace_id,id,name) VALUES('a','todo','Todo'),('b','foreign-status','Todo');`);
 for(const id of ['member','other','admin','super','foreign-member']){
  const ws=id==='foreign-member'?'b':'a';
  db.prepare('INSERT INTO auth_users(id,email) VALUES(?,?)').run(id,`${id}@example.test`);
  db.prepare('INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id) VALUES(?,?,?,?,?,?,?)').run(ws,id,id,'',`${id}@example.test`,actor(id).member.role,id);
 }
 for(const [id,p,ws,s,creator] of [['t','p','a','todo','member'],['t-archived','archived','a','todo','member'],['t-foreign','foreign','b','foreign-status','foreign-member']])
  db.prepare('INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id) VALUES(?,?,?,?,?,?,?)').run(ws,id,id,p,'Synthetic task',s,creator);
 beforeMutation=null;
 class Statement {
  constructor(sql){this.sql=sql;this.args=[];}
  bind(...args){this.args=args;return this;}
  check(){if(beforeMutation && /^\s*(UPDATE tasks|INSERT INTO task_reminder_preferences)/i.test(this.sql)){const fn=beforeMutation;beforeMutation=null;fn();}}
  async first(){this.check();return db.prepare(this.sql).get(...this.args)??null;}
  async all(){this.check();return {results:db.prepare(this.sql).all(...this.args),success:true};}
  async run(){this.check();return {meta:db.prepare(this.sql).run(...this.args),success:true};}
 }
 env={DB:{prepare:sql=>new Statement(sql),batch:async statements=>{db.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.all());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}}};
});
afterEach(()=>db.close());

describe('planning native SQLite contract',()=>{
 it('upgrades a legacy planning fixture twice without inventing commitment',async()=>{
  const legacy=new DatabaseSync(':memory:'),applied=[];
  try{
   // This runner starts after tenancy. Keep the real member table and remove
   // only the new QA flag to exercise its actual, additive upgrade as well.
   const memberSchema=fs.readFileSync(new URL('../../worker/schema.sql',import.meta.url),'utf8')
    .match(/CREATE TABLE IF NOT EXISTS members\s*\([\s\S]*?\n\);/)?.[0];
   expect(memberSchema).toBeTruthy();
   legacy.exec(memberSchema.replace(/^  is_qa_admin .*\r?\n/gm,''));
   legacy.exec(`INSERT INTO members(workspace_id,id,name,avatar,email,role)
    VALUES('a','member-a','Synthetic member','','a@example.com','member'),('b','member-b','Synthetic administrator','','b@example.com','super_admin');`);
   const membersBefore=legacy.prepare('SELECT workspace_id,id,role FROM members ORDER BY id').all();
   legacy.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY,workspace_id TEXT,due_date TEXT,task_key TEXT,project_id TEXT,parent_task_id TEXT,assignee_id TEXT,reviewer_id TEXT);
    CREATE TABLE notifications(id TEXT,type TEXT,workspace_id TEXT,task_id TEXT,recipient_id TEXT);
    CREATE TABLE task_checks(workspace_id TEXT,id TEXT PRIMARY KEY,task_id TEXT NOT NULL,text TEXT NOT NULL,is_done INTEGER NOT NULL DEFAULT 0,sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE task_todos(workspace_id TEXT,id TEXT PRIMARY KEY,task_id TEXT NOT NULL,text TEXT NOT NULL,is_done INTEGER NOT NULL DEFAULT 0,sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE task_dependencies(workspace_id TEXT,id TEXT PRIMARY KEY,task_id TEXT NOT NULL,depends_on_task_id TEXT NOT NULL,dependency_type TEXT NOT NULL DEFAULT 'finish_to_start',created_at TEXT);
    INSERT INTO tasks(id,workspace_id,due_date) VALUES('legacy','a','2027-02-01');`);
   for(let i=0;i<2;i++)await applyPostTenantSchemaUpgrades({queryRows:async sql=>legacy.prepare(sql).all(),applyFile:async file=>{applied.push(file);legacy.exec(fs.readFileSync(new URL(`../../worker/migrate/${file}`,import.meta.url),'utf8'));},log:()=>{}});
   const row=legacy.prepare('SELECT * FROM tasks').get();expect(row.due_date).toBe('2027-02-01');expect(row.due_date_kind).toBeNull();expect(row.due_date_version).toBe(0);
   expect(applied.filter(x=>x==='task-reminder-alters.sql')).toHaveLength(1);expect(applied.filter(x=>x==='task-reminder-preferences.sql')).toHaveLength(2);
   expect(applied.filter(x=>x==='qa-admin-capability.sql')).toHaveLength(1);
   expect(legacy.prepare('SELECT workspace_id,id,role FROM members ORDER BY id').all()).toEqual(membersBefore);
   expect(legacy.prepare('SELECT is_qa_admin FROM members ORDER BY id').all()).toEqual([{is_qa_admin:0},{is_qa_admin:0}]);
   expect(legacy.prepare('SELECT * FROM task_deadline_history').all()).toHaveLength(0);
  }finally{legacy.close();}
 });
 it('reapplies full planning migration twice without changing data',async()=>{
  await setDate();
  for(let i=0;i<2;i++)await applyPostTenantSchemaUpgrades({queryRows:async sql=>rows(sql),applyFile:async file=>db.exec(fs.readFileSync(new URL(`../../worker/migrate/${file}`,import.meta.url),'utf8')),log:()=>{}});
  expect(task().due_date_version).toBe(1);expect(rows('SELECT * FROM task_deadline_history')).toHaveLength(1);
 });
 for(const id of ['member','admin','super'])it(`${id} can only pause their own reminder`,async()=>{
  const r=await reminder({member_id:'other',p_member_id:'other'},actor(id));expect(r.member_id).toBe(id);
  const q=await query({snoozed_until:future()},'update',r.id,actor('other'),'task_reminder_preferences');expect(q.error).toBeTruthy();
  const seen=await runQuery(env,{waitUntil:()=>{}},actor('other'),{table:'task_reminder_preferences',op:'select'});expect(seen.data).toEqual([]);
 });
 it('pause resumes with NULL, expires naturally, and rejects stale CAS',async()=>{
  const first=await reminder();expect(first.version).toBe(1);
  await expect(reminder()).rejects.toThrow('planning_conflict');
  const resumed=await reminder({p_until:null,p_expected_version:1});expect(resumed.version).toBe(2);expect(resumed.snoozed_until).toBeNull();
  expect(rows("SELECT * FROM task_reminder_preferences WHERE julianday(snoozed_until)>julianday('now')")).toHaveLength(0);
 });
 for(const mode of ['inactive','banned','ambiguous','archived','cross-workspace'])it(`rejects ${mode} authorizations`,async()=>{
  if(mode==='inactive')db.exec("UPDATE members SET is_active=0 WHERE id='member'");
  if(mode==='banned')db.exec("UPDATE auth_users SET banned=1 WHERE id='member'");
  if(mode==='ambiguous')db.exec("INSERT INTO members(workspace_id,id,name,avatar,email,auth_id) VALUES('a','duplicate','Duplicate','','duplicate@example.com','member')");
  const id=mode==='archived'?'t-archived':mode==='cross-workspace'?'t-foreign':'t';
  await expect(reminder({p_task_id:id})).rejects.toThrow(/planning_(forbidden|conflict)/);
  await expect(setDate({p_task_id:id})).rejects.toThrow(/planning_(forbidden|conflict)/);
 });
 it('rechecks deactivation and archive at mutation time',async()=>{
  beforeMutation=()=>db.exec("UPDATE members SET is_active=0 WHERE id='member'");
  await expect(setDate()).rejects.toThrow('planning_conflict');
  db.exec("UPDATE members SET is_active=1 WHERE id='member'");
  beforeMutation=()=>db.exec("UPDATE projects SET is_archived=1 WHERE id='p'");
  await expect(reminder()).rejects.toThrow('planning_conflict');expect(task().due_date_version).toBe(0);
 });
 it('committed postpone and clear require fresh reasons even when downgraded',async()=>{
  await setDate();
  for(const patch of [{p_due_date:'2027-02-01',p_kind:'estimated'},{p_due_date:null,p_kind:null}]){
   await expect(setDate({...patch,p_expected_version:1})).rejects.toThrow('planning_reason_required');
   expect(task().due_date_version).toBe(1);
  }
  await setDate({p_due_date:null,p_kind:null,p_expected_version:1,p_reason:'Scope changed'});
  expect(rows('SELECT * FROM task_deadline_history')).toHaveLength(2);expect(task().due_date_change_reason).toBeNull();
 });
 it('unknown and estimated dates remain editable with reasonless history',async()=>{
  await setDate({p_kind:null});await setDate({p_due_date:'2027-02-01',p_kind:'estimated',p_expected_version:1});
  await setDate({p_due_date:'2027-03-01',p_kind:'estimated',p_expected_version:2});
  expect(rows('SELECT * FROM task_deadline_history')).toHaveLength(3);
 });
 it('date and reminder formats reject invalid calendar, kind, and range',async()=>{
  for(const date of ['2027-02-29','2027-13-01','2027-1-01',17])await expect(setDate({p_due_date:date})).rejects.toThrow('planning_invalid_date');
  await expect(setDate({p_kind:'promised'})).rejects.toThrow('planning_invalid_kind');
  await expect(setDate({p_due_date:null})).rejects.toThrow('planning_date_required');
  for(const until of ['2027-02-29T00:00:00.000Z',new Date(Date.now()-1000).toISOString(),new Date(Date.now()+367*86400000).toISOString(),'2027-01-01'])await expect(reminder({p_until:until})).rejects.toThrow('planning_invalid_pause');
 });
 it('combined start/deadline rollback and CAS cannot partially commit',async()=>{
  await setDate({p_change_start:true,p_started_at:'2027-01-01',p_expected_started_at:null});
  await expect(setDate({p_expected_version:1,p_due_date:'2027-02-01',p_change_start:true,p_started_at:'2027-01-02',p_expected_started_at:'2027-01-01'})).rejects.toThrow('planning_reason_required');
  expect(task().started_at).toBe('2027-01-01');expect(task().due_date).toBe('2027-01-20');
  await expect(setDate({p_expected_version:1,p_reason:'Changed',p_change_start:true,p_started_at:'2027-01-02',p_expected_started_at:null})).rejects.toThrow('planning_conflict');
  await setDate({p_expected_version:1,p_change_start:true,p_started_at:'2027-01-02',p_expected_started_at:'2027-01-01'});
  expect(task().due_date_version).toBe(1);expect(task().started_at).toBe('2027-01-02');
 });
 it('generic writes produce history and cannot forge audit metadata',async()=>{
  expect((await query({due_date:'2027-01-20',due_date_kind:'committed'})).error).toBeFalsy();
  expect(rows('SELECT * FROM task_deadline_history')[0].actor_id).toBe('member');
  expect((await query({due_date_version:25})).error).toBeTruthy();
  expect((await query({due_date_changed_by:'other'})).error).toBeTruthy();
  expect((await query({due_date:'2027-02-01',due_date_kind:'estimated'})).error).toBeTruthy();
  expect(task().due_date_version).toBe(1);
 });
 it('generic reason-only writes cannot seed a reason for a later postponement',async()=>{
  await setDate();await query({due_date_change_reason:'Unrelated old explanation'});
  const changed=await query({due_date:'2027-02-01'});
  expect(changed.error).toBeTruthy();expect(task().due_date).toBe('2027-01-20');
 });
 it('generic insert rejects date kind without date',async()=>{
  const response=await query({id:'insert-kind',task_key:'I-1',project_id:'p',title:'Synthetic',status_id:'todo',creator_id:'member',due_date_kind:'committed'},'insert');
  expect(response.error).toBeTruthy();
 });
 it('required deadline cannot be cleared, even with a reason',async()=>{
  await setDate();db.exec(`INSERT INTO system_settings(workspace_id,key,value) VALUES('a','required_fields','{"dueDate":true}')`);
  await expect(setDate({p_expected_version:1,p_due_date:null,p_kind:null,p_reason:'Changed'})).rejects.toThrow('planning_date_required');
  expect(task().due_date).toBe('2027-01-20');
 });
 it('generic upsert guards commitments and records each successful date change',async()=>{
  await setDate();
  const values={id:'t',task_key:'t',project_id:'p',status_id:'todo',creator_id:'member',title:'Synthetic',due_date:'2027-02-01',due_date_kind:'estimated'};
  expect((await query(values,'upsert')).error).toBeTruthy();
  expect(task().due_date).toBe('2027-01-20');
  expect((await query({...values,due_date_change_reason:'Scope changed'},'upsert')).error).toBeFalsy();
  expect(task().due_date_version).toBe(2);expect(rows('SELECT * FROM task_deadline_history')).toHaveLength(2);
 });
 it('Jira guard is tenant scoped and rolls back all child deletes',async()=>{
  await setDate();db.exec("INSERT INTO comments(workspace_id,id,task_id,user_id,content) VALUES('a','keep-comment','t','member','Synthetic')");
  const batch=ws=>env.DB.batch([env.DB.prepare('INSERT INTO task_planning_import_guard(workspace_id) VALUES(?)').bind(ws),env.DB.prepare('DELETE FROM comments WHERE workspace_id=?').bind(ws),env.DB.prepare('DELETE FROM tasks WHERE workspace_id=?').bind(ws),env.DB.prepare('DELETE FROM task_planning_import_guard WHERE workspace_id=?').bind(ws)]);
  await expect(batch('a')).rejects.toThrow('planning_history_requires_restore');
  expect(rows('SELECT * FROM comments')).toHaveLength(1);expect(task()).toBeTruthy();
  await batch('b');expect(rows("SELECT * FROM tasks WHERE workspace_id='b'")).toHaveLength(0);expect(task()).toBeTruthy();
  expect((await query({workspace_id:'a'},'insert','x',actor('super'),'task_planning_import_guard')).error).toBeTruthy();
 });
 it('Jira rejects pending approval before child deletes even without planning history',async()=>{
  db.exec("INSERT INTO system_settings(workspace_id,key,value) VALUES('a','feature_toggles','{\"approvals\":true}'); INSERT INTO statuses(workspace_id,id,name) VALUES('a','done','Done'); INSERT INTO comments(workspace_id,id,task_id,user_id,content) VALUES('a','keep-comment','t','member','Synthetic')");
  const pending=await executeApprovalCommand(env,actor(),{commandId:'planning-jira-pending',operation:'submit',taskId:'t',expected:{statusId:'todo',requiresApproval:false,currentApprovalId:null,approvalStatus:null},toStatusId:'done',expectedRuleId:null,enableRequirement:true});
  expect(pending.request.status).toBe('pending');expect(rows('SELECT * FROM task_deadline_history')).toHaveLength(0);
  await expect(env.DB.batch([env.DB.prepare('INSERT INTO task_planning_import_guard(workspace_id) VALUES(?)').bind('a'),env.DB.prepare("DELETE FROM comments WHERE workspace_id='a'"),env.DB.prepare("DELETE FROM tasks WHERE workspace_id='a'")])).rejects.toThrow('approval_pending');
  expect(rows('SELECT * FROM comments')).toHaveLength(1);expect(task()).toBeTruthy();
 });
 it('expired pause stops suppressing due notifications',async()=>{
  await reminder({p_until:new Date(Date.now()+1000).toISOString()});await new Promise(resolve=>setTimeout(resolve,1100));
  db.exec("INSERT INTO notifications(workspace_id,id,recipient_id,sender_id,task_id,type) VALUES('a','expired-due','member','other','t','due_soon')");
  expect(rows("SELECT * FROM notifications WHERE id='expired-due'")).toHaveLength(1);
 });
 it('retired pause preserves preferences/history while due and responsibility notices remain deduplicated',async()=>{
  await setDate();await reminder();
  const preferences=rows('SELECT * FROM task_reminder_preferences'),history=rows('SELECT * FROM task_deadline_history');
  expect(preferences).toHaveLength(1);expect(history).toHaveLength(1);expect(preferences[0].snoozed_until).not.toBeNull();
  const insert=db.prepare('INSERT OR IGNORE INTO notifications(workspace_id,id,recipient_id,sender_id,task_id,type,content) VALUES(?,?,?,?,?,?,?)');
  for(let attempt=0;attempt<2;attempt++)for(const type of ['due_soon','assigned','review_requested'])insert.run('a',type,'member','other','t',type,'Synthetic');
  expect(rows('SELECT type FROM notifications').map(r=>r.type).sort()).toEqual(['assigned','due_soon','review_requested']);
  expect(rows('SELECT * FROM task_reminder_preferences')).toEqual(preferences);
  expect(rows('SELECT * FROM task_deadline_history')).toEqual(history);
 });
});
