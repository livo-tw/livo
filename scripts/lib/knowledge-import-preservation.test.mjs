// @vitest-environment node
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {KNOWLEDGE_IMPORT_SOURCE_TABLES,assertKnowledgeImportSafe} from '../../worker/migrate/knowledge-work-import-guard.mjs';
import {KNOWLEDGE_RESTORE_TABLES,assertKnowledgeRestoreSafe} from '../../src/lib/knowledgeWork/restoreGuard';
import {knowledgeMockHasData,knowledgeMockRestoreAvailable} from '../../src/integrations/supabase/knowledgeWorkMock';
import {handleBackup} from '../../worker/src/functions/backup';

vi.mock('../../worker/src/license',()=>({checkLicense:vi.fn(async()=>({tier:'standard'})),checkProfessional:vi.fn(async()=>true)}));
vi.mock('../../worker/src/functions/slack',()=>({resolveSlackToken:vi.fn(async()=>undefined)}));
afterEach(()=>vi.unstubAllGlobals());

const stagingTables=['knowledge_import_policy','knowledge_import_jobs','knowledge_import_sources','knowledge_import_cleanup_cursors',
  'knowledge_import_files','knowledge_import_usage_reconciliations','knowledge_import_maintenance_state'];
describe('knowledge import preservation before destructive restore',()=>{
  it('uses only real PostgreSQL source tables and includes every platform import ledger',()=>{
    const root=new URL('../../supabase/migrations/',import.meta.url);
    const sql=readdirSync(root).filter(n=>n.includes('knowledge')).map(n=>readFileSync(new URL(n,root),'utf8')).join('\n');
    expect(KNOWLEDGE_IMPORT_SOURCE_TABLES).toHaveLength(17);
    for(const table of KNOWLEDGE_IMPORT_SOURCE_TABLES)expect(sql).toMatch(new RegExp('CREATE TABLE IF NOT EXISTS public\\.'+table+'\\s*\\('));
    expect(KNOWLEDGE_IMPORT_SOURCE_TABLES).not.toContain('knowledge_import_files');
    expect(KNOWLEDGE_IMPORT_SOURCE_TABLES).not.toContain('knowledge_import_usage_reconciliations');
    expect(KNOWLEDGE_IMPORT_SOURCE_TABLES).not.toContain('knowledge_import_maintenance_state');
    expect(KNOWLEDGE_RESTORE_TABLES).toHaveLength(20);
    expect(KNOWLEDGE_RESTORE_TABLES).toEqual(expect.arrayContaining([...KNOWLEDGE_IMPORT_SOURCE_TABLES,...stagingTables]));
  });
  it.each(KNOWLEDGE_RESTORE_TABLES)('blocks incoming or live %s without requiring any KB page',table=>{
    const empty=Object.fromEntries(KNOWLEDGE_RESTORE_TABLES.map(name=>[name,[]]));
    const only={[table]:[{id:'synthetic-private-state',data:'private synthetic content'}]};
    expect(()=>assertKnowledgeRestoreSafe(only)).toThrow('knowledge_requires_server_restore');
    expect(()=>assertKnowledgeRestoreSafe({}, {...empty,...only})).toThrow('knowledge_requires_server_restore');
  });
  it.each(stagingTables)('Mock existence covers hidden %s without returning private data',table=>{
    const raw={members:[{id:'admin',auth_id:'auth-admin',role:'admin',is_active:true}],kb_pages:[],[table]:[{id:'synthetic-private-state',body:'PRIVATE STAGED CONTENT'}]};
    expect(knowledgeMockHasData(raw)).toBe(true);
    expect(knowledgeMockRestoreAvailable(raw,'auth-admin')).toBe(false);
    expect(()=>knowledgeMockRestoreAvailable(raw,undefined)).toThrow('knowledge_forbidden');
    expect(()=>knowledgeMockRestoreAvailable({...raw,members:[{...raw.members[0],role:'member'}]},'auth-admin')).toThrow('knowledge_forbidden');
  });
  it.each([null,{},'invalid'])('malformed import ledgers fail closed (%j)',value=>{
    expect(()=>assertKnowledgeRestoreSafe({knowledge_import_jobs:value})).toThrow('knowledge_requires_server_restore');
    expect(()=>assertKnowledgeImportSafe(table=>table==='knowledge_import_jobs'?value:[])).toThrow('Invalid knowledge import data');
  });
  it('does not interpret an empty inventory, exclusion manifest or seeded work clock as private business data',()=>{
    const empty=Object.fromEntries(KNOWLEDGE_RESTORE_TABLES.map(name=>[name,[]]));
    const manifest={kb_backup_manifest:[{status:'excluded_requires_server_backup',complete_workspace_backup:false}],kb_work_clock:[{id:1,generation:0}]};
    expect(()=>assertKnowledgeRestoreSafe(manifest,empty)).not.toThrow();
    expect(()=>assertKnowledgeImportSafe(()=>[])).not.toThrow();
    expect(()=>assertKnowledgeImportSafe(()=>undefined)).toThrow('Invalid knowledge import data');
  });
});

describe('ordinary team JSON backup remains available',()=>{
  it('backs up the workspace while excluding a real staging-only job and preserving its exclusion notice',async()=>{
    const db=new DatabaseSync(':memory:');
    try{
      db.exec('BEGIN;'+readFileSync(new URL('../../worker/schema.sql',import.meta.url),'utf8')+';COMMIT;');
      db.prepare('INSERT INTO knowledge_import_jobs(id,workspace_id,actor_id,version,data,expires_at,created_at) VALUES(?,?,?,?,?,?,?)')
        .run('staged-only','synthetic-workspace','actor',1,JSON.stringify({body:'PRIVATE STAGED CONTENT'}),'2099-01-01','2026-10-03');
      expect(db.prepare('SELECT count(*) n FROM kb_pages').get().n).toBe(0);
      const saved=[];const queried=[];
      const env={DB:{prepare(sql){queried.push(sql);return {bind(...args){return {
        all:async()=>({results:db.prepare(sql).all(...args)}),
        first:async()=>db.prepare(sql).get(...args)??null,
        run:async()=>db.prepare(sql).run(...args),
      };}};}},ATTACHMENTS:{put:vi.fn(async(key,bytes)=>{saved.push({key,body:JSON.parse(new TextDecoder().decode(bytes))});})}};
      const fetcher=vi.fn(()=>{throw Error('No network permitted');});vi.stubGlobal('fetch',fetcher);
      const c={env,req:{json:async()=>({manual:true})},get:()=>({member:{workspaceId:'synthetic-workspace'}}),
        json:(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})};
      const response=await handleBackup(c);expect(response.status).toBe(200);expect((await response.json()).success).toBe(true);
      expect(saved).toHaveLength(1);expect(saved[0].key).toMatch(/^backups\/ws\/synthetic-workspace\//);
      expect(saved[0].body.kb_backup_manifest).toEqual([expect.objectContaining({status:'excluded_requires_server_backup',complete_workspace_backup:false})]);
      expect(JSON.stringify(saved[0].body)).not.toContain('PRIVATE STAGED CONTENT');
      expect(saved[0].body).not.toHaveProperty('knowledge_import_jobs');
      expect(queried.some(sql=>sql.includes('knowledge_import_jobs'))).toBe(false);
      expect(db.prepare('SELECT count(*) n FROM knowledge_import_jobs').get().n).toBe(1);
      expect(fetcher).not.toHaveBeenCalled();
    }finally{db.close();}
  });
});
