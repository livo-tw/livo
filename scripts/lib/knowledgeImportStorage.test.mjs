// @vitest-environment node
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import {accountExistingKnowledgeImportObject,deleteKnowledgeImportObject,ensureKnowledgeImportUsageReconciled,putKnowledgeImportObject,reconcileKnowledgeImportUsage} from '../../worker/src/knowledgeImportStorage';
import {reserveStorageBytes,releaseStorageBytes} from '../../worker/src/storageQuota';
import {saveKnowledgeImportJob,hydrateKnowledgeImportJob} from '../../worker/src/knowledgeImportJobStorage';
import {handleUpload} from '../../worker/src/storage';
import {handleQaStorage} from '../../worker/src/qaStorage';

let db,env,objects,putFailure,deleteFailure,onPut,listCalls;
const key=(name='original',ws='team')=>`kb-imports/${ws}/actor/job/${name}`;
const bytes=n=>new Uint8Array(n).fill(42);
const usage=(ws='team')=>db.prepare('SELECT storage_used_bytes n FROM workspaces WHERE id=?').get(ws).n;
const job=()=>JSON.parse(db.prepare("SELECT data FROM knowledge_import_jobs WHERE workspace_id='team' AND id='job'").get().data);
const metadata=()=>({id:'job',actor_id:'actor',source:'md',status:'parsing',version:1,policy_version:1,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600000).toISOString(),initial_parent:null,items:[]});
const parsed=body=>({body,pages:[],warnings:[],parser_version:'test',hash:'a'.repeat(64),incomplete:false,needs_review:false});
const item=(id,body)=>({id,title:id,source_key:id,source_hash:id,original:{key:`actor/job/${id}`,name:'notes.md',type:'text/markdown',size:1},assets:[],status:'ready',parsed:parsed(body)});
beforeEach(()=>{
  db=new DatabaseSync(':memory:');objects=new Map();putFailure=false;deleteFailure=false;onPut=null;listCalls=[];
  db.exec(`CREATE TABLE workspaces(id TEXT PRIMARY KEY,storage_limit_mb REAL,storage_used_bytes INTEGER DEFAULT 0);
    INSERT INTO workspaces VALUES('team',1,0),('other',1,0);
    CREATE TABLE qa_upload_sessions(workspace_id TEXT,expected_size INTEGER,state TEXT,expires_at TEXT);
    CREATE TABLE projects(workspace_id TEXT,id TEXT);
    CREATE TABLE qa_issues(workspace_id TEXT,id TEXT,project_id TEXT,data TEXT);
    INSERT INTO projects VALUES('team','project');
    INSERT INTO qa_issues VALUES('team','issue','project','{"id":"issue"}');
    CREATE TRIGGER qa_reserve BEFORE INSERT ON qa_upload_sessions BEGIN
      SELECT CASE WHEN (SELECT storage_used_bytes+NEW.expected_size+COALESCE((SELECT SUM(expected_size) FROM qa_upload_sessions WHERE workspace_id=NEW.workspace_id AND state IN ('initializing','uploading','finalizing','aborting')),0)>storage_limit_mb*1048576 FROM workspaces WHERE id=NEW.workspace_id) THEN RAISE(ABORT,'qa_storage_quota_exceeded') END; END;
    CREATE TABLE knowledge_import_jobs(id TEXT,workspace_id TEXT,actor_id TEXT,version INTEGER,data TEXT,expires_at TEXT,created_at TEXT,PRIMARY KEY(workspace_id,id));
    CREATE TABLE knowledge_import_sources(id TEXT,workspace_id TEXT,original TEXT,assets TEXT);`);
  db.exec(fs.readFileSync(new URL('../../worker/knowledge-import-storage.schema.sql',import.meta.url),'utf8'));
  const j=metadata();db.prepare('INSERT INTO knowledge_import_jobs VALUES(?,?,?,?,?,?,?)').run(j.id,'team',j.actor_id,j.version,JSON.stringify(j),j.expires_at,j.created_at);
  const prepare=sql=>{let params=[];return {bind(...values){params=values;for(const value of values)if(typeof value==='string'&&Buffer.byteLength(value)>2000000)throw Error('D1 maximum string size');return this;},async first(){return db.prepare(sql).get(...params)||null;},async run(){return db.prepare(sql).run(...params);},async all(){return {results:db.prepare(sql).all(...params)};}};};
  env={DB:{prepare},ATTACHMENTS:{
    async put(k,v){if(putFailure)throw Error('put failed');objects.set(k,Uint8Array.from(v));if(onPut)await onPut();},
    async get(k){const b=objects.get(k);return b?{arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)}:null;},
    async head(k){return objects.has(k)?{size:objects.get(k).length}:null;},
    async delete(k){if(deleteFailure)throw Error('delete failed');objects.delete(k);},
    async list({prefix,cursor,limit}){listCalls.push({prefix,cursor});const all=[...objects.keys()].filter(k=>k.startsWith(prefix)).sort(),start=cursor?all.findIndex(k=>k>cursor):0,selected=start<0?[]:all.slice(start,start+limit),truncated=start>=0&&start+limit<all.length;return {objects:selected.map(k=>({key:k,size:objects.get(k).length})),truncated,...(truncated?{cursor:selected.at(-1)}:{})};},
  }};
});
afterEach(()=>db.close());
describe('import object quota and durable payloads on actual SQLite',()=>{
  it('counts original/assets/payload atomically against ordinary and QA reservations',async()=>{
    await ensureKnowledgeImportUsageReconciled(env,'team');
    db.prepare('INSERT INTO qa_upload_sessions(workspace_id,expected_size,state) VALUES(?,?,?)').run('team',300000,'uploading');
    const results=await Promise.allSettled([putKnowledgeImportObject(env,'team',key(),bytes(500000),'text/plain'),reserveStorageBytes(env,'team',500000)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(usage()).toBe(500000);
    await expect(putKnowledgeImportObject(env,'team',key('asset'),bytes(300000),'image/png')).rejects.toThrow('storage_quota_exceeded');
    expect(()=>db.prepare('INSERT INTO qa_upload_sessions(workspace_id,expected_size,state) VALUES(?,?,?)').run('team',300000,'initializing')).toThrow('qa_storage_quota_exceeded');
    expect(usage('other')).toBe(0);
  });
  it('releases failed PUT bytes, but failed delete retains charge until one successful retry',async()=>{
    putFailure=true;await expect(putKnowledgeImportObject(env,'team',key(),bytes(300),'text/plain')).rejects.toThrow('put failed');expect(usage()).toBe(0);
    putFailure=false;await putKnowledgeImportObject(env,'team',key(),bytes(300),'text/plain');deleteFailure=true;
    await expect(deleteKnowledgeImportObject(env,'team',key())).rejects.toThrow('delete failed');expect(usage()).toBe(300);
    deleteFailure=false;await deleteKnowledgeImportObject(env,'team',key());await deleteKnowledgeImportObject(env,'team',key());expect(usage()).toBe(0);
  });
  it('meters idempotent writes once and verifies legacy content before accepting a replay',async()=>{
    objects.set(key(),bytes(150));await accountExistingKnowledgeImportObject(env,'team',key(),150);
    await putKnowledgeImportObject(env,'team',key(),bytes(150),'text/plain');await putKnowledgeImportObject(env,'team',key(),bytes(150),'text/plain');expect(usage()).toBe(150);
    expect(db.prepare('SELECT content_hash FROM knowledge_import_files').get().content_hash).not.toBe('legacy');
    await expect(putKnowledgeImportObject(env,'team',key(),new Uint8Array(150),'text/plain')).rejects.toThrow('storage_key_conflict');expect(usage()).toBe(150);
  });
  it('protects committed files across actors and never treats another workspace reference as ownership',async()=>{
    await putKnowledgeImportObject(env,'team',key(),bytes(200),'text/plain');
    db.prepare('INSERT INTO knowledge_import_sources VALUES(?,?,?,?)').run('source','team',JSON.stringify({key:'actor/job/original'}),'[]');
    expect(await deleteKnowledgeImportObject(env,'team',key())).toBe(false);expect(usage()).toBe(200);
    db.prepare("UPDATE knowledge_import_sources SET workspace_id='other'").run();
    expect(await deleteKnowledgeImportObject(env,'team',key())).toBe(true);expect(usage()).toBe(0);
  });
  it('fences a PUT that completes after the job expires and cleans its bytes',async()=>{
    onPut=async()=>{db.prepare("UPDATE knowledge_import_jobs SET expires_at='2000-01-01'").run();await deleteKnowledgeImportObject(env,'team',key());objects.set(key(),bytes(400));};
    await expect(putKnowledgeImportObject(env,'team',key(),bytes(400),'text/plain')).rejects.toThrow('preview_expired');expect(objects.size).toBe(0);expect(usage()).toBe(0);
  });
  it('blocks all new reservations until bounded legacy scan completes and records over-limit usage',async()=>{
    for(let i=0;i<205;i++)objects.set(key(`legacy-${String(i).padStart(3,'0')}`),bytes(6000));
    await expect(reserveStorageBytes(env,'team',1)).rejects.toThrow('storage_reconciliation_pending');expect(usage()).toBe(600000);
    await expect(putKnowledgeImportObject(env,'team',key('new'),bytes(1),'text/plain')).rejects.toThrow('storage_reconciliation_pending');expect(usage()).toBe(1200000);
    await expect(reserveStorageBytes(env,'team',1)).rejects.toThrow('storage_quota_exceeded');expect(usage()).toBe(1230000);
    await ensureKnowledgeImportUsageReconciled(env,'team');expect(listCalls).toHaveLength(3);expect(listCalls[1].cursor).toBeTruthy();
    await reconcileKnowledgeImportUsage(env);expect(usage()).toBe(1230000);
    expect(db.prepare('SELECT complete FROM knowledge_import_usage_reconciliations').get().complete).toBe(1);
  });
  it('admits a new empty workspace in one scan and keeps default unlimited',async()=>{
    await reserveStorageBytes(env,'team',100);await reserveStorageBytes(env,'team',100);expect(listCalls).toHaveLength(1);expect(usage()).toBe(200);
    await releaseStorageBytes(env,'team',200);expect(usage()).toBe(0);
    await reserveStorageBytes(env,'default',999999999);expect(listCalls).toHaveLength(1);
  });
  it('returns readable 409s from ordinary and QA upload routes until legacy accounting completes',async()=>{
    for(let i=0;i<205;i++)objects.set(key(`legacy-${String(i).padStart(3,'0')}`),bytes(6000));
    const context=()=>{const raw=new Request('https://example.com/upload',{method:'POST',body:bytes(2),headers:{'content-length':'2'}});return {env,get:()=>({member:{workspaceId:'team',id:'actor'}}),req:{raw,header:name=>raw.headers.get(name)},json:(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})};};
    const ordinary=await handleUpload(context(),'task-images','image.png');expect(ordinary.status).toBe(409);expect((await ordinary.json()).error.message).toContain('核對');
    const qa=await handleQaStorage(context(),'upload_init',{id:'issue',fileName:'proof.txt',mimeType:'text/plain',size:2});expect(qa.status).toBe(409);expect((await qa.json()).error.message).toContain('核對');
    expect(db.prepare('SELECT count(*) n FROM qa_upload_sessions').get().n).toBe(0);expect(objects.has('task-images/ws/team/image.png')).toBe(false);
    const full=await handleUpload(context(),'task-images','image.png');expect(full.status).toBe(413);expect((await full.json()).error.message).toContain('空間已滿');
  });
  it('stores parsed JSON larger than D1 row limits only in R2 and fails clearly when missing',async()=>{
    db.prepare("UPDATE workspaces SET storage_limit_mb=20 WHERE id='team'").run();const j=job();j.version++;j.items=[item('one','"\n'.repeat(400000))];j.items[0].parsed.pages=[{page:1,state:'text',text:'x'.repeat(1500000),confidence:null}];
    expect(await saveKnowledgeImportJob(env,'team','actor',j,1,{sql:'1=1',params:[]})).toBe(true);
    const saved=job();expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(10000);expect(saved.items[0].parsed).toBeUndefined();expect(usage()).toBeGreaterThan(2000000);
    expect((await hydrateKnowledgeImportJob(env,'team',saved)).items[0].parsed.body).toBe(j.items[0].parsed.body);
    objects.delete(`kb-imports/team/${saved.items[0]._parsed_key}`);await expect(hydrateKnowledgeImportJob(env,'team',saved)).rejects.toThrow('import_payload_missing');
  });
  it('persists failed state after payload quota failure and preserves committed pointers for retry',async()=>{
    const j=job();j.version++;j.items=[item('committed','previous'),item('retry','old')];
    await saveKnowledgeImportJob(env,'team','actor',j,1,{sql:'1=1',params:[]});const first=job();const originalKey=first.items[0]._parsed_key;
    j.version++;j.items[0].status='committed';j.items[1].parsed.body='x'.repeat(1100000);
    expect(await saveKnowledgeImportJob(env,'team','actor',j,2,{sql:'1=1',params:[]})).toBe(true);
    const failed=job();expect(failed.status).toBe('failed');expect(failed.items[1].error).toBe('storage_quota_exceeded');expect(failed.items[0]._parsed_key).toBe(originalKey);
    const retry=await hydrateKnowledgeImportJob(env,'team',failed);expect(retry.items[0].parsed.body).toBe('previous');
    db.prepare("UPDATE workspaces SET storage_limit_mb=5 WHERE id='team'").run();retry.status='parsing';retry.version++;retry.items[1]={...item('retry','now fits')};
    await saveKnowledgeImportJob(env,'team','actor',retry,3,{sql:'1=1',params:[]});expect((await hydrateKnowledgeImportJob(env,'team',job())).items.every(i=>i.parsed)).toBe(true);
  });
});
