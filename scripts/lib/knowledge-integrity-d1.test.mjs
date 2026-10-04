// @vitest-environment node
// Real SQLite schema plus the repeatable knowledge-work upgrade; the generic
// Worker write path (runQuery → writeKnowledge) and the knowledge-work adapter.
// Synthetic data only.
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('../../worker/src/notify',()=>({notifyChanges:()=>{}}));
import {executeKnowledgeWork,knowledgeSnapshot} from '../../worker/src/knowledgeWork';
import {queryKnowledgeState} from '../../src/lib/knowledgeWork/engine';
import {runQuery} from '../../worker/src/db';
import {applyPostTenantSchemaUpgrades} from '../../worker/migrate/schema-upgrades.mjs';

let db,env,sequence;
const ROLES={member:'member',other:'member',admin:'admin',super:'super_admin'};
const auth=(id='member')=>({userId:id,email:`${id}@example.com`,member:{id,workspaceId:'a',role:ROLES[id],email:`${id}@example.com`,name:id}});
const ctx={waitUntil(){}};
const kb=(who,req)=>runQuery(env,ctx,auth(who),{table:'kb_pages',...req});
const remove=(id,who)=>kb(who,{op:'delete',filters:[{col:'id',op:'eq',val:id}],single:true});
const page=id=>db.prepare('SELECT * FROM kb_pages WHERE id=?').get(id);
const count=(table,where='1=1',...params)=>db.prepare(`SELECT count(*) n FROM ${table} WHERE ${where}`).get(...params).n;
const lock=(id,who)=>db.prepare("INSERT OR REPLACE INTO field_locks(workspace_id,lock_key,locked_by,expires_at) VALUES('a',?,?,'2099-01-01T00:00:00.000Z')").run(`kb:${id}`,who);
const move=async(id,parent,who)=>{lock(id,who);const p=page(id);return kb(who,{op:'update',values:{parent_id:parent},filters:[{col:'id',op:'eq',val:id},{col:'version',op:'eq',val:p.version}],single:true});};
const command=(operation,fields={})=>({commandId:`knowledge-integrity-${++sequence}`,operation,...fields});
const query=async(q,who='member')=>queryKnowledgeState(await knowledgeSnapshot(env,auth(who)),q);
const refs=async(text,who)=>(await query({operation:'search',query:text,types:['knowledge'],projectIds:[],effectiveOnly:false,cursor:0},who)).items.map(({kind,id,version})=>({kind,id,version}));
async function draft(who,sourceRefs=[]){
 const preview=await query({operation:'prepare_draft',input:{kind:'meeting',title:'Synthetic draft',notes:'Draft only.',sourceRefs}},who);
 return executeKnowledgeWork(env,auth(who),command('save_draft',{preview,title:'Synthetic draft',text:preview.text,confirmed:true}));
}
async function publish(id,who='member'){
 let r=await executeKnowledgeWork(env,auth(who),command('set_metadata',{pageId:id,expectedVersion:page(id).version,metadata:{documentKind:'specification',ownerId:who,applicability:{productVersion:'1.0',environment:null,summary:null}}}));
 r=await executeKnowledgeWork(env,auth(who),command('publish',{pageId:id,expectedVersion:r.page.pageVersion,expectedPublicationId:null,confirmed:true}));
 return r.page.publication;
}
const visible=async(who)=>((await kb(who,{op:'select'})).data||[]).map(p=>p.id);

beforeEach(()=>{
 sequence=0;db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON;');
 db.exec(fs.readFileSync(new URL('../../worker/schema.sql',import.meta.url),'utf8'));
 for(let i=0;i<2;i++)db.exec(fs.readFileSync(new URL('../../worker/migrate/knowledge-work.sql',import.meta.url),'utf8'));
 db.exec(`INSERT INTO workspaces(id,name) VALUES('a','Synthetic A');
 INSERT INTO product_lines(workspace_id,id,name) VALUES('a','la','A');
 INSERT INTO projects(workspace_id,id,line_id,name,key,is_archived) VALUES('a','p','la','P','P',0);`);
 for(const id of Object.keys(ROLES)){
  db.prepare('INSERT INTO auth_users(id,email) VALUES(?,?)').run(id,`${id}@example.com`);
  db.prepare('INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id) VALUES(?,?,?,?,?,?,?)').run('a',id,id,'',`${id}@example.com`,ROLES[id],id);
 }
 // Shared-scope pages (no project) can be reparented under a draft; project pages cannot.
 const insert=db.prepare("INSERT INTO kb_pages(workspace_id,id,title,body,created_by,updated_by,project_id) VALUES('a',?,?,?,'member','member',?)");
 for(const [id,title,project] of [['guide','Synthetic guide',null],['guide-child','Synthetic child',null],['spec-old','Older specification','p'],['spec-new','Newer specification','p'],['checklist','Checklist page','p']])insert.run(id,title,`<p>${title}</p>`,project);
 db.prepare("UPDATE kb_pages SET parent_id='guide' WHERE id='guide-child'").run();
 db.exec("INSERT INTO kb_attachments(id,workspace_id,page_id,file_name,file_size,file_type,storage_path,storage_bucket,uploaded_by) VALUES('att-guide','a','guide','example.txt',1,'text/plain','kb/guide/example.txt','kb-files','member');");
 const make=(sqlText,params=[])=>({sqlText,params,bind(...values){return make(sqlText,values);},async all(){return {results:db.prepare(sqlText).all(...params)};},async first(){return db.prepare(sqlText).get(...params)||null;},async run(){const r=db.prepare(sqlText).run(...params);return {success:true,meta:{changes:Number(r.changes)},results:[]};}});
 env={DB:{prepare:make,async batch(statements){db.exec('BEGIN');try{const result=statements.map(s=>({success:true,results:db.prepare(s.sqlText).all(...s.params)}));db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}}};
});
afterEach(()=>db.close());

describe('knowledge pages touched by knowledge work stay deletable (D1)',()=>{
 it('an owner deletes an own private draft; its receipt, event and links go with it',async()=>{
  const saved=await draft('member',await refs('guide','member'));
  expect(count('kb_work_receipts','page_id=?',saved.page.pageId)).toBe(1);
  const result=await remove(saved.page.pageId,'member');
  expect(result.error).toBeNull();
  expect(page(saved.page.pageId)).toBeUndefined();
  for(const table of ['kb_work_receipts','kb_work_events','kb_source_links'])expect(count(table,'page_id=?',saved.page.pageId)).toBe(0);
 });
 it('a viewer linking a page from a draft no longer blocks its creator; the link and file link are removed',async()=>{
  const saved=await draft('other',await refs('guide','other'));
  db.prepare("INSERT INTO kb_source_links(workspace_id,id,page_id,source_kind,source_id,source_version,source_page_version,created_by,created_at) VALUES('a','file-link',?,'knowledge_file','att-guide','1',NULL,'other','2026-10-01T00:00:00.000Z')").run(saved.page.pageId);
  expect((await remove('guide-child','other')).error?.message).toBe('kb_conflict');
  expect(page('guide-child')).toBeDefined();
  expect((await remove('guide-child','member')).error).toBeNull();
  const result=await remove('guide','member');
  expect(result.error).toBeNull();
  expect(page('guide')).toBeUndefined();
  expect(page(saved.page.pageId).private_draft_owner_id).toBe('other');
  expect(count('kb_source_links','page_id=?',saved.page.pageId)).toBe(0);
  expect(count('kb_work_receipts','page_id=?',saved.page.pageId)).toBe(1);
  expect((await remove(saved.page.pageId,'other')).error).toBeNull();
 });
 it('deleting a single attachment removes draft links to that file',async()=>{
  const saved=await draft('other');
  db.prepare("INSERT INTO kb_source_links(workspace_id,id,page_id,source_kind,source_id,source_version,source_page_version,created_by,created_at) VALUES('a','file-link',?,'knowledge_file','att-guide','1',NULL,'other','2026-10-01T00:00:00.000Z')").run(saved.page.pageId);
  const result=await runQuery(env,ctx,auth('member'),{table:'kb_attachments',op:'delete',filters:[{col:'id',op:'eq',val:'att-guide'}],single:true});
  expect(result.error).toBeNull();
  expect(count('kb_source_links',"id='file-link'")).toBe(0);
 });
 it('admin and super admin delete published pages; a successor keeps its state and only loses the pointer',async()=>{
  const older=await publish('spec-old');
  const newer=await publish('spec-new');
  await executeKnowledgeWork(env,auth('member'),command('replace',{pageId:'spec-new',expectedVersion:page('spec-new').version,expectedPublicationId:newer.id,predecessorPublicationId:older.id,expectedPredecessorVersion:older.version,confirmed:true}));
  const effective=db.prepare("SELECT * FROM kb_publications WHERE page_id='spec-new' AND state='effective'").get();
  expect(effective.predecessor_id).toBe(older.id);
  db.exec('DELETE FROM field_locks'); // knowledge-work leases expire after 30 seconds
  expect((await remove('spec-old','admin')).error).toBeNull();
  expect(db.prepare('SELECT state,predecessor_id FROM kb_publications WHERE id=?').get(effective.id)).toEqual({state:'effective',predecessor_id:null});
  expect(count('kb_publications',"page_id='spec-old'")).toBe(0);
  expect((await remove('spec-new','super')).error).toBeNull();
  expect(count('kb_publications')).toBe(0);
  expect(count('kb_revisions',"page_id IN ('spec-old','spec-new')")).toBe(0);
 });
 it('a published or linked revision stays protected while its page exists',async()=>{
  const pub=await publish('spec-old');
  expect(()=>db.prepare("DELETE FROM kb_revisions WHERE page_id='spec-old' AND version=?").run(pub.page_version)).toThrow('knowledge_conflict');
 });
 it('a page with workflow checklist links stays deletable',async()=>{
  db.exec(`INSERT INTO kb_checklist_items(workspace_id,id,page_id,anchor_id,text,created_by,created_at,updated_by,updated_at) VALUES('a','check-1','checklist','anchor-1','Verify','member','2026-10-01T00:00:00.000Z','member','2026-10-01T00:00:00.000Z');
   INSERT INTO kb_source_snapshots(workspace_id,id,page_id,source_kind,source_title,body,body_hash,page_version,created_by,created_at) VALUES('a','snap-1','checklist','task','Task','<p>T</p>','${'a'.repeat(64)}',1,'member','2026-10-01T00:00:00.000Z');
   INSERT INTO kb_work_links(workspace_id,id,page_id,anchor_id,checklist_id,snapshot_id,target_kind,target_id,relation,created_by,created_at) VALUES('a','link-1','checklist','anchor-1','check-1','snap-1','task','t-1','verification','member','2026-10-01T00:00:00.000Z');`);
  expect((await remove('checklist','member')).error).toBeNull();
  expect(count('kb_work_links')).toBe(0);
 });
 it('child pages still block deleting their parent',async()=>{
  const result=await remove('guide','member');
  expect(result.error?.message).toMatch(/FOREIGN KEY/i);
  expect(page('guide')).toBeDefined();
 });
});

describe('shared pages cannot be hidden inside a private draft (D1)',()=>{
 it('an admin cannot move a shared page under the own private draft or its subtree',async()=>{
  const saved=await draft('admin');
  const before=await visible('member');
  expect(before).toEqual(expect.arrayContaining(['guide','guide-child']));
  const result=await move('guide',saved.page.pageId,'admin');
  expect(result.error?.message).toContain('kb_private_draft_parent');
  expect(page('guide').parent_id).toBeNull();
  const nested=await kb('admin',{op:'insert',values:{title:'Inside the draft',parent_id:saved.page.pageId,project_id:null},single:true});
  expect(nested.error).toBeNull();
  expect((await move('guide',nested.data.id,'admin')).error?.message).toContain('kb_private_draft_parent');
  for(const who of ['member','super'])expect(await visible(who)).toEqual(expect.arrayContaining(['guide','guide-child']));
 });
 it('ordinary moves between shared pages and draft sharing still work',async()=>{
  expect((await move('spec-old','spec-new','admin')).error).toBeNull();
  expect((await move('guide-child',null,'admin')).error).toBeNull();
  const saved=await draft('member');
  const shared=await executeKnowledgeWork(env,auth('member'),command('share_draft',{pageId:saved.page.pageId,expectedVersion:1,projectId:'p',parentId:'spec-new',confirmed:true}));
  expect(shared.page.privateDraftOwnerId).toBeNull();
  expect(page(saved.page.pageId).parent_id).toBe('spec-new');
 });
 it('upgrade probes reapply the new guards without duplicates',async()=>{
  const deps={queryRows:async sql=>db.prepare(sql).all(),applyFile:async name=>db.exec(fs.readFileSync(new URL('../../worker/migrate/'+name,import.meta.url),'utf8'))};
  await applyPostTenantSchemaUpgrades(deps);await applyPostTenantSchemaUpgrades(deps);
  for(const name of ['kb_work_page_delete_cleanup','kb_work_attachment_delete_cleanup','kb_draft_hierarchy_guard'])expect(count('sqlite_master',"type='trigger' AND name=?",name)).toBe(1);
  const saved=await draft('member');
  expect((await remove(saved.page.pageId,'member')).error).toBeNull();
 });
});
