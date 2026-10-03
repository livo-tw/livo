// @vitest-environment node
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { handleKnowledgeImport } from '../../worker/src/functions/knowledgeImport';
vi.mock('../../worker/src/notify',()=>({notifyChanges:vi.fn()}));
let db,env,background,sqlErrors,beforeBatch;
const auth=(id='member-pm',role='member',workspaceId='default')=>({userId:id,email:'example@example.com',member:{id,role,workspaceId,email:'example@example.com',name:'Example'}});
const rule={roles:[],positions:['PM'],member_ids:[]};
const policy={mode:'custom',view:rule,edit:rule,comment:rule};
const destination={parent_id:'private',project_id:null,category:'meeting',policy:{mode:'inherit'},target_id:null,expected_version:null,mode:'create'};
function call(body,actor=auth()){return handleKnowledgeImport(env,{waitUntil:p=>background.push(p)},actor,body);}
async function staged(){const job=await call({action:'start',source:'md',name:'notes.md',data:btoa('# Decision'),parent_id:'private'});await Promise.all(background);return call({action:'get',job_id:job.id});}
async function commit(job,d=destination){return call({action:'commit',job_id:job.id,version:job.version,mappings:[{item_id:job.items[0].id,destination:d,reviewed:true,confirm_audience:true,allow_incomplete:false}]});}
beforeEach(()=>{
  db=new DatabaseSync(':memory:');background=[];sqlErrors=[];beforeBatch=null;
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE members(id TEXT,role TEXT,job_title TEXT,is_active INTEGER,workspace_id TEXT,PRIMARY KEY(workspace_id,id));
    INSERT INTO members VALUES('member-pm','member','PM',1,'default'),('ordinary-admin','admin','Engineer',1,'default'),('highest','super_admin','Executive',1,'default'),('member-pm','member','PM',1,'other');
    ALTER TABLE members ADD COLUMN auth_id TEXT; UPDATE members SET auth_id=id;
    CREATE TABLE projects(id TEXT PRIMARY KEY,workspace_id TEXT,is_archived INTEGER DEFAULT 0);
    CREATE TABLE field_locks(lock_key TEXT,locked_by TEXT,expires_at TEXT,workspace_id TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,workspace_id TEXT);
    CREATE TABLE qa_issues(id TEXT PRIMARY KEY,workspace_id TEXT);`);
  const schema=fs.readFileSync(path.resolve(__dirname,'../../worker/schema.sql'),'utf8');
  const kb=schema.slice(schema.indexOf('-- Knowledge base:'),schema.indexOf('CREATE TABLE IF NOT EXISTS auth_users'));
  db.exec(kb);db.exec(fs.readFileSync(path.resolve(__dirname,'../../worker/knowledge-workflow.schema.sql'),'utf8'));db.exec(fs.readFileSync(path.resolve(__dirname,'../../worker/knowledge-import-schema.sql'),'utf8'));
  db.prepare('INSERT INTO kb_pages(id,workspace_id,title,body,access_policy,created_by,updated_by) VALUES(?,?,?,?,?,?,?)').run('private','default','PM planning','<p>Human edits</p>',JSON.stringify(policy),'member-pm','member-pm');
  db.prepare('INSERT INTO knowledge_import_policy VALUES(?,?,?,?,?)').run('default',1,JSON.stringify({version:1,subjects:rule,notion_subjects:rule,notion_pages:[]}),'highest','2026-01-01');
  const objects=new Map();
  const prepare=sql=>{let params=[];return {bind(...args){params=args;return this;},async first(){try{return db.prepare(sql).get(...params)||null;}catch(e){sqlErrors.push(e.message+' '+sql);throw e;}},async all(){try{return {results:db.prepare(sql).all(...params)};}catch(e){sqlErrors.push(e.message+' '+sql);throw e;}},async run(){return db.prepare(sql).run(...params);}};};
  env={DB:{prepare,async batch(statements){if(beforeBatch){const hook=beforeBatch;beforeBatch=null;hook();}db.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.all());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}},ATTACHMENTS:{async put(key,bytes){objects.set(key,bytes);},async get(key){const bytes=objects.get(key);return bytes?{arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}:null;},async delete(key){objects.delete(key);}},KNOWLEDGE_PROCESSOR_URL:'http://private-processor:8091',KNOWLEDGE_PROCESSOR_TOKEN:'test-token-'.repeat(4)};
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({result:{body:'<p>Converted decision</p>',warnings:[],pages:[],assets:[],hash:'a'.repeat(64),parser_version:'test',incomplete:false,needs_review:false}}),{status:200,headers:{'content-type':'application/json'}})));
});
afterEach(()=>{db.close();vi.unstubAllGlobals();});
describe('actual SQLite import transactions',()=>{
  it('keeps long parsing in the active request and retains a recoverable job before responding',async()=>{
    let release;const started=new Promise(resolve=>{release=resolve;});let finish;
    vi.stubGlobal('fetch',vi.fn(()=>{release();return new Promise(resolve=>{finish=resolve;});}));
    let returned=false;const request=call({action:'start',source:'md',name:'long.md',data:btoa('# Long')}).then(result=>{returned=true;return result;});
    await started;expect(returned).toBe(false);expect(background).toHaveLength(0);
    const saved=JSON.parse(db.prepare('SELECT data FROM knowledge_import_jobs').get().data);expect(saved.status).toBe('parsing');
    const history=await call({action:'list'});expect(history.map(x=>x.id)).toContain(saved.id);
    finish(new Response(JSON.stringify({result:{body:'<p>Done</p>',warnings:[],pages:[],assets:[],hash:'a'.repeat(64),parser_version:'test',incomplete:false,needs_review:false}}),{status:200}));
    expect((await request).status).toBe('preview_ready');
  });
  it('rejects a cached member identity after its authenticated account is rebound',async()=>{const job=await staged();db.prepare('UPDATE members SET auth_id=? WHERE workspace_id=? AND id=?').run('new-auth-account','default','member-pm');await expect(call({action:'get',job_id:job.id})).rejects.toThrow('import_forbidden');await expect(call({action:'capability'})).rejects.toThrow('import_forbidden');});
  it('checks authentication binding again inside the mutation transaction',async()=>{const job=await staged();beforeBatch=()=>db.prepare('UPDATE members SET auth_id=? WHERE workspace_id=? AND id=?').run('new-auth-account','default','member-pm');await expect(commit(job)).rejects.toThrow();expect(db.prepare('SELECT count(*) n FROM kb_source_snapshots').get().n).toBe(0);expect(db.prepare('SELECT count(*) n FROM knowledge_import_sources').get().n).toBe(0);expect(db.prepare('SELECT count(*) n FROM kb_pages').get().n).toBe(1);});
  it('creates a restricted page, immutable snapshot and original mapping atomically',async()=>{const job=await staged();expect(job.status,JSON.stringify(sqlErrors)).toBe('preview_ready');const result=await commit(job);expect(result.status,JSON.stringify(sqlErrors)).toBe('succeeded');const item=result.items[0];expect(db.prepare('SELECT parent_id FROM kb_pages WHERE id=?').get(item.page_id).parent_id).toBe('private');expect(db.prepare('SELECT count(*) n FROM kb_source_snapshots').get().n).toBe(1);expect(db.prepare('SELECT count(*) n FROM knowledge_import_sources').get().n).toBe(1);expect((await call({action:'sources',page_id:item.page_id}))[0].body).toBe('<p>Converted decision</p>');});
  it('never overwrites the edited body when a new source version is imported',async()=>{const job=await staged();const result=await commit(job,{...destination,parent_id:null,mode:'update',target_id:'private',expected_version:1});expect(result.status,JSON.stringify(sqlErrors)).toBe('succeeded');expect(db.prepare('SELECT body FROM kb_pages WHERE id=?').get('private').body).toBe('<p>Human edits</p>');expect(db.prepare('SELECT body FROM kb_source_snapshots').get().body).toBe('<p>Converted decision</p>');});
  it('prevents a live ACL race between preview authorization and the transaction',async()=>{const job=await staged();beforeBatch=()=>db.prepare('UPDATE members SET job_title=? WHERE workspace_id=? AND id=?').run('Engineer','default','member-pm');await expect(commit(job)).rejects.toThrow();expect(db.prepare('SELECT count(*) n FROM kb_pages').get().n).toBe(1);expect(db.prepare('SELECT count(*) n FROM kb_source_snapshots').get().n).toBe(0);expect(db.prepare('SELECT count(*) n FROM knowledge_import_sources').get().n).toBe(0);});
  it('detects a same-source duplicate only within the authorized target',async()=>{const first=await commit(await staged());expect(first.status,JSON.stringify(sqlErrors)).toBe('succeeded');const second=await staged();const preview=await call({action:'preview_target',job_id:second.id,destination});expect(preview.duplicates).toHaveLength(1);const result=await commit(preview.job);expect(result.status).toBe('partially_failed');expect(db.prepare('SELECT count(*) n FROM knowledge_import_sources').get().n).toBe(1);});
  it('filters source bodies and downloads for admins without PM access',async()=>{const result=await commit(await staged());const page=result.items[0].page_id;await expect(call({action:'sources',page_id:page},auth('ordinary-admin','admin'))).rejects.toThrow('import_forbidden');await expect(call({action:'download_source',page_id:page,source_id:'guess'},auth('highest','super_admin'))).rejects.toThrow('import_forbidden');});
  it('scopes job IDs and source IDs to the workspace',async()=>{const job=await staged();await expect(call({action:'get',job_id:job.id},auth('member-pm','member','other'))).rejects.toThrow('import_forbidden');expect(db.prepare('SELECT count(*) n FROM knowledge_import_sources').get().n).toBe(0);});
});
