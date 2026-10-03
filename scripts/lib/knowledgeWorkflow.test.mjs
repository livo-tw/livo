// @vitest-environment node
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {executeKnowledgeWorkflow} from '../../worker/src/knowledgeWorkflow';
let db,env,beforeBatch;
const actor=(id='pm',role='member')=>({userId:id,email:`${id}@example.com`,member:{id,role,workspaceId:'default',name:id,email:`${id}@example.com`}});
const run=(body,auth=actor())=>executeKnowledgeWorkflow(env,auth,{pageId:'private',...body});
const add=()=>run({action:'checklist_add',commandId:'add',text:'Review evidence',anchorId:'stable'});
beforeEach(()=>{
 db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 db.exec(fs.readFileSync(path.resolve(__dirname,'../../worker/schema.sql'),'utf8'));
 db.exec(fs.readFileSync(path.resolve(__dirname,'../../worker/knowledge-workflow.schema.sql'),'utf8'));
 db.exec(`INSERT INTO members(id,name,avatar,role,job_title,email,auth_id) VALUES('pm','PM','','member','PM','pm@example.com','pm'),('admin','Admin','','admin','Engineer','admin@example.com','admin'),('super','Super','','super_admin','Engineer','super@example.com','super');
 INSERT INTO product_lines(id,name) VALUES('line','Example'); INSERT INTO projects(id,line_id,name,key) VALUES('project','line','Example','EX');
 INSERT INTO statuses(id,name,is_done) VALUES('open','Open',0),('done','Done',1);
 INSERT INTO tasks(id,task_key,project_id,title,status_id,creator_id) VALUES('task','EX-1','project','Existing','open','pm');
 INSERT OR REPLACE INTO system_settings(key,value) VALUES('feature_toggles','{"qa":true}');`);
 const rule={roles:[],positions:['PM'],member_ids:[]};
 db.prepare("INSERT INTO kb_pages(id,title,body,created_by,updated_by,access_policy) VALUES('private','Private title','<p>Immutable original</p>','pm','pm',?)").run(JSON.stringify({mode:'custom',view:rule,edit:rule,comment:rule}));
 const prepare=(sql)=>{let args=[];return{sql,bind(...a){args=a;return this;},async all(){return{results:db.prepare(sql).all(...args)};},async first(){return db.prepare(sql).get(...args)||null;},async run(){return db.prepare(sql).run(...args);},execute(){return db.prepare(sql).run(...args);}};};
 env={DB:{prepare,async batch(statements){beforeBatch?.();beforeBatch=null;db.exec('BEGIN');try{const result=statements.map(s=>s.execute());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}}};beforeBatch=null;
});
afterEach(()=>db.close());
describe('knowledge workflow D1 transactions and live ACL',()=>{
 it('stores real checkbox progress with desired state, CAS and idempotent retry',async()=>{
  const item=await add();expect(await add()).toEqual(item);
  await run({action:'checklist_set',commandId:'set',checklistId:item.id,expectedVersion:1,isDone:true});
  const list=await run({action:'list'});expect(list.checklist).toHaveLength(1);expect(list.checklist[0]).toMatchObject({isDone:true,version:2,completedBy:'pm',anchorId:'stable'});
  await expect(run({action:'checklist_set',commandId:'stale',checklistId:item.id,expectedVersion:1,isDone:false})).rejects.toThrow('kb_workflow_conflict');
  await expect(run({action:'checklist_add',commandId:'add',text:'Changed'})).rejects.toThrow('kb_workflow_idempotency_conflict');
 });
 it('reads PM reverse links only through live ACL, without admin bypass',async()=>{
  await run({action:'link',commandId:'link',targetKind:'task',targetId:'task'});
  expect((await run({action:'backlinks',targetKind:'task',targetId:'task'})).items).toHaveLength(1);
  for(const role of ['admin','super'])expect((await run({action:'backlinks',targetKind:'task',targetId:'task'},actor(role,role==='super'?'super_admin':'admin'))).items).toEqual([]);
  db.exec("UPDATE members SET job_title='Engineer' WHERE id='pm'");
  expect((await run({action:'backlinks',targetKind:'task',targetId:'task'})).items).toEqual([]);
  await expect(run({action:'list'})).rejects.toThrow('kb_workflow_unavailable');
 });
 it('rolls back receipt and writes if permission is revoked between checks and transaction',async()=>{
  beforeBatch=()=>db.exec("UPDATE members SET job_title='Engineer' WHERE id='pm'");
  await expect(add()).rejects.toThrow('kb_workflow_conflict');
  expect(db.prepare('SELECT count(*) n FROM kb_checklist_items').get().n).toBe(0);expect(db.prepare('SELECT count(*) n FROM kb_workflow_commands').get().n).toBe(0);
 });
 it('promotes an item retaining its anchor and uses only the task status; unlink preserves task',async()=>{
  const item=await add();const link=await run({action:'link',commandId:'link',targetKind:'task',targetId:'task',checklistId:item.id,expectedVersion:1});
  expect((await run({action:'list'})).links[0]).toMatchObject({anchorId:'stable',status:'Open'});
  await expect(run({action:'checklist_set',commandId:'no-second-status',checklistId:item.id,expectedVersion:1,isDone:true})).rejects.toThrow('kb_workflow_conflict');
  db.exec("UPDATE tasks SET status_id='done' WHERE id='task'");expect((await run({action:'list'})).links[0].status).toBe('Done');
  await run({action:'unlink',commandId:'unlink',linkId:link.id});expect(db.prepare("SELECT id FROM tasks WHERE id='task'").get()).toBeTruthy();
 });
 it('creates one atomically keyed task with explicit published content and audit',async()=>{
  const request={action:'create_task',commandId:'task-create',expectedPageVersion:1,input:{projectId:'project',statusId:'open',title:'Public action',description:'Chosen content'}};
  const result=await run(request);expect(await run(request)).toEqual(result);
  expect(db.prepare('SELECT task_key,title FROM tasks WHERE id=?').get(result.targetId)).toMatchObject({task_key:'EX-2',title:'Public action'});
  expect(db.prepare('SELECT requirement FROM task_specs WHERE task_id=?').get(result.targetId).requirement).toContain('Chosen content');
  expect(db.prepare('SELECT count(*) n FROM activity_logs WHERE task_id=?').get(result.targetId).n).toBe(1);
  expect(db.prepare('SELECT s.body FROM kb_work_links l JOIN kb_source_snapshots s ON s.id=l.snapshot_id WHERE l.target_id=?').get(result.targetId).body).toBe('<p>Immutable original</p>');
  await expect(run({...request,commandId:'done-create',input:{...request.input,statusId:'done'}})).rejects.toThrow('kb_workflow_conflict');
  expect(db.prepare('SELECT count(*) n FROM tasks').get().n).toBe(2);
 });
 it('captures immutable body versions independently of progress and forbids direct mutation',async()=>{
  const request={action:'capture_snapshot',commandId:'capture',expectedPageVersion:1};const first=await run(request);
  expect(await run({...request,commandId:'capture-2'})).toEqual(first);const item=await add();await run({action:'checklist_set',commandId:'set',checklistId:item.id,expectedVersion:1,isDone:true});
  expect((await run({action:'snapshot',snapshotId:first.id})).body).toBe('<p>Immutable original</p>');
  expect(()=>db.exec("UPDATE kb_source_snapshots SET body='Rewrite'")).toThrow('kb_workflow_immutable');
 });
 it('creates QA through the existing command guards with no fabricated verification',async()=>{
  const request={action:'create_qa',commandId:'qa-create',expectedPageVersion:1,input:{projectId:'project',title:'Investigate result',actual:'Observed failure',observedEnvironment:'QA'}};
  const result=await run(request);expect(await run(request)).toEqual(result);
  const issue=JSON.parse(db.prepare('SELECT data FROM qa_issues WHERE id=?').get(result.targetId).data);
  expect(issue).toMatchObject({state:'new',targets:[],runs:[],fixCycle:0,closedAt:null});
  expect(db.prepare('SELECT count(*) n FROM qa_commands WHERE issue_id=?').get(result.targetId).n).toBe(1);
  expect(db.prepare('SELECT snapshot_id FROM kb_work_links WHERE target_id=?').get(result.targetId).snapshot_id).toBeTruthy();
  db.exec(`UPDATE system_settings SET value='{"qa":false}' WHERE key='feature_toggles'`);
  await expect(run({...request,commandId:'qa-disabled'})).rejects.toThrow('kb_workflow_conflict');
  expect((await run({action:'list'})).links[0]).toMatchObject({unavailable:true,title:''});
 });
 it('keeps source deletion independent of task deletion',async()=>{
  const item=await add();await run({action:'link',commandId:'link',targetKind:'task',targetId:'task',checklistId:item.id,expectedVersion:1});
  db.exec("DELETE FROM kb_pages WHERE id='private'");expect(db.prepare("SELECT id FROM tasks WHERE id='task'").get()).toBeTruthy();expect(db.prepare('SELECT count(*) n FROM kb_work_links').get().n).toBe(0);
 });
});
