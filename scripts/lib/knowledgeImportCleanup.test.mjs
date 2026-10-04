// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';
import { runImportCleanup } from '../../worker/src/knowledgeImportCleanup';
import { createImportCleanupRepository, runKnowledgeImportCleanup } from '../../worker/src/functions/knowledgeImportCleanup';
import { reconcileKnowledgeImportUsage } from '../../worker/src/knowledgeImportStorage';

let db, env, objects, uploaded, deletes, failDeletes;
const stamp = () => new Date().toISOString();
const key = (job, name = 'original', workspace = 'default', actor = 'disabled-user') => `kb-imports/${workspace}/${actor}/${job}/${name}`;
const relative = full => full.split('/').slice(2).join('/');

function seedJob(id, { workspace = 'default', actor = 'disabled-user', expired = true, data = {} } = {}) {
  const expires = new Date(Date.now() + (expired ? -86400000 : 86400000)).toISOString();
  const job = { id, actor_id: actor, source: 'pdf', status: 'parsing', version: 4, policy_version: 1,
    created_at: stamp(), expires_at: expires, items: [{ id: 'item', parsed: { body: 'PRIVATE ORIGINAL' } }], ...data };
  db.prepare('INSERT INTO knowledge_import_jobs VALUES(?,?,?,?,?,?,?)').run(id, workspace, actor, 4, JSON.stringify(job), expires, stamp());
  return job;
}

function seedObject(full, bytes = 5, uploadedAt) { objects.set(full, new Uint8Array(bytes)); if (uploadedAt !== undefined) uploaded.set(full, uploadedAt); }
function seedSource(full, workspace = 'default') {
  const id = 'source-' + objects.size;
  db.prepare('INSERT INTO kb_pages VALUES(?,?)').run(id, workspace);
  db.prepare('INSERT INTO kb_source_snapshots VALUES(?)').run(id);
  db.prepare('INSERT INTO knowledge_import_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    id, workspace, id, id, 'other-committed-job', id, 'file:source', 'hash', 1,
    JSON.stringify({ key: relative(full) }), '[]', 'another-private-creator', stamp());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2030-01-01T12:00:00.000Z'));
  db = new DatabaseSync(':memory:'); objects = new Map(); uploaded = new Map(); deletes = []; failDeletes = false;
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,storage_limit_mb INTEGER,storage_used_bytes INTEGER);
    INSERT INTO workspaces VALUES('default',100,0),('other',100,0);
    CREATE TABLE qa_upload_sessions(workspace_id TEXT,state TEXT,expected_size INTEGER);
    CREATE TABLE kb_pages(id TEXT,workspace_id TEXT,PRIMARY KEY(workspace_id,id));
    CREATE TABLE kb_source_snapshots(id TEXT PRIMARY KEY);`);
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../worker/knowledge-import-schema.sql'), 'utf8'));
  const prepare = sql => { let params = []; return {
    bind(...next) { params = next; return this; },
    async first() { return db.prepare(sql).get(...params) || null; },
    async all() { return { results: db.prepare(sql).all(...params) }; },
    async run() { return db.prepare(sql).run(...params); },
  }; };
  env = { DB: { prepare }, ATTACHMENTS: {
    async list({ prefix, limit = 1000, cursor }) {
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? keys.findIndex(k => k > cursor) : 0;
      const selected = start < 0 ? [] : keys.slice(start, start + limit);
      const truncated = start >= 0 && start + limit < keys.length;
      return { objects: selected.map(k => ({ key: k, size: objects.get(k).length, uploaded: uploaded.get(k) })), truncated,
        ...(truncated ? { cursor: selected.at(-1) } : {}) };
    },
    async delete(full) { if (failDeletes) throw new Error('transient R2 failure'); deletes.push(full); objects.delete(full); },
  } };
});
afterEach(() => { db.close(); vi.useRealTimers(); });

describe('scheduled private-import retention with actual SQLite', () => {
  it('cleans expired jobs without any actor rows, across tenants, while preserving every committed source', async () => {
    // No members table exists: maintenance must never require an active actor.
    seedJob('expired-a'); seedJob('expired-b', { workspace: 'other', actor: 'deleted-user' }); seedJob('live', { expired: false });
    const kept = key('expired-a', 'committed-original'); seedObject(kept); seedSource(kept);
    const preview = key('expired-a', 'payload/item/body.json'); seedObject(preview);
    const abandoned = key('expired-b', 'abandoned-run/asset', 'other', 'deleted-user'); seedObject(abandoned);
    seedObject(key('live'));
    const summary = await runImportCleanup(createImportCleanupRepository(env));
    expect(summary).toMatchObject({ claimed: 2, completed: 2, removed: 2, retained: 1, failed: 0 });
    expect(objects.has(kept)).toBe(true); expect(objects.has(key('live'))).toBe(true);
    expect(objects.has(preview)).toBe(false); expect(objects.has(abandoned)).toBe(false);
    const tombstone = JSON.parse(db.prepare("SELECT data FROM knowledge_import_jobs WHERE id='expired-a'").get().data);
    expect(tombstone.items).toEqual([]); expect(JSON.stringify(tombstone)).not.toContain('PRIVATE ORIGINAL');
    expect(db.prepare('SELECT count(*) n FROM knowledge_import_sources').get().n).toBe(1);
  });

  it('fences stale commits and concurrent cleanup claims, then sweeps a late PUT before removing the tombstone', async () => {
    seedJob('expired'); seedObject(key('expired'));
    const a = createImportCleanupRepository(env), b = createImportCleanupRepository(env);
    const claims = await a.claim(stamp(), new Date(Date.now() + 600000).toISOString(), 'lease-a', 20);
    expect(claims).toHaveLength(1);
    expect(await b.claim(stamp(), new Date(Date.now() + 600000).toISOString(), 'lease-b', 20)).toEqual([]);
    expect(db.prepare("UPDATE knowledge_import_jobs SET version=99 WHERE id='expired' AND version=4 RETURNING id").get()).toBeUndefined();
    expect(await b.finish({ ...claims[0], lease_token: 'lease-b' }, stamp(), stamp(), stamp())).toBe(false);
    await a.remove(claims[0], [relative(key('expired'))]);
    expect(await a.finish(claims[0], stamp(), new Date(Date.now() - 900000).toISOString(), new Date(Date.now() + 900000).toISOString())).toBe(true);
    seedObject(key('expired', 'late-write'));
    expect((await runImportCleanup(a)).claimed).toBe(0);
    vi.setSystemTime(new Date(Date.now() + 901000));
    const again = await runImportCleanup(a);
    expect(again).toMatchObject({ claimed: 1, completed: 1, removed: 1, failed: 0 });
    expect(db.prepare("SELECT id FROM knowledge_import_jobs WHERE id='expired'").get()).toBeUndefined();
    expect(objects.size).toBe(0);
  });

  it('does not let 20 failed old jobs starve the next unattempted expired job', async () => {
    for (let i = 0; i < 21; i++) { const id = `job-${String(i).padStart(2, '0')}`; seedJob(id); seedObject(key(id)); }
    failDeletes = true;
    expect((await runImportCleanup(createImportCleanupRepository(env))).failed).toBe(20);
    expect(JSON.parse(db.prepare("SELECT data FROM knowledge_import_jobs WHERE id='job-20'").get().data).cleanup_last_attempt).toBeUndefined();
    vi.setSystemTime(new Date(Date.now() + 601000)); failDeletes = false;
    const next = await runImportCleanup(createImportCleanupRepository(env), { limit: 1 });
    expect(next).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(objects.has(key('job-20'))).toBe(false);
    expect(objects.has(key('job-00'))).toBe(true);
  });

  it('retries failed deletion without releasing quota, including reservations with no R2 object', async () => {
    seedJob('expired'); const full = key('expired'); seedObject(full, 9);
    db.prepare('INSERT INTO knowledge_import_files VALUES(?,?,?,?,?,?,?,?,?)').run('default', full, 'expired', 9, 'hash', 'stored', 'op', stamp(), stamp());
    const missing = key('expired', 'unfinished-upload');
    db.prepare('INSERT INTO knowledge_import_files VALUES(?,?,?,?,?,?,?,?,?)').run('default', missing, 'expired', 7, 'hash2', 'writing', 'op2', stamp(), stamp());
    failDeletes = true;
    expect((await runImportCleanup(createImportCleanupRepository(env))).failed).toBe(1);
    expect(db.prepare("SELECT storage_used_bytes n FROM workspaces WHERE id='default'").get().n).toBe(16);
    vi.setSystemTime(new Date(Date.now() + 601000)); failDeletes = false;
    expect((await runImportCleanup(createImportCleanupRepository(env))).failed).toBe(0);
    expect(db.prepare("SELECT storage_used_bytes n FROM workspaces WHERE id='default'").get().n).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM knowledge_import_files').get().n).toBe(0);
  });

  it('persists a bounded legacy-usage cursor and accounts retained files exactly once', async () => {
    for (let i = 0; i < 105; i++) seedObject(key('legacy', `asset-${String(i).padStart(3, '0')}`), 3);
    const first = await runKnowledgeImportCleanup(env);
    expect(first.reconciliation).toMatchObject({ visited: 100, adopted: 100, done: false });
    const second = await runKnowledgeImportCleanup(env);
    expect(second.reconciliation).toMatchObject({ visited: 5, adopted: 5, done: true });
    expect((await runKnowledgeImportCleanup(env)).reconciliation.adopted).toBe(0);
    expect(db.prepare("SELECT storage_used_bytes n FROM workspaces WHERE id='default'").get().n).toBe(315);
  });

  it('only privileged maintenance removes demonstrably old no-job objects and preserves all committed references', async () => {
    const old = new Date(Date.now() - 86400001), orphan = key('old-orphan'), kept = key('committed-no-job');
    seedObject(orphan, 7, old); seedObject(kept, 11, old); seedSource(kept);
    seedObject(key('young'), 3, new Date(Date.now() - 86399999));
    seedObject(key('boundary'), 3, new Date(Date.now() - 86400000));
    seedObject(key('unknown')); seedObject(key('invalid'), 5, new Date(NaN));
    seedObject(key('string-date'), 5, old.toISOString());
    seedJob('existing'); seedObject(key('existing'), 5, old);
    // The quota admission/backfill default is accounting-only, never deletion.
    await reconcileKnowledgeImportUsage(env); expect(deletes).toEqual([]);
    await reconcileKnowledgeImportUsage(env, { orphanCleanup: true });
    expect(deletes).toEqual([orphan]); expect(objects.has(kept)).toBe(true);
    expect(objects.has(key('existing'))).toBe(true); expect(objects.size).toBe(7);
    expect(db.prepare('SELECT count(*) n FROM knowledge_import_sources').get().n).toBe(1);
    expect(db.prepare("SELECT storage_used_bytes n FROM workspaces WHERE id='default'").get().n).toBe(37);
  });

  it('does not release orphan quota until deletion succeeds, then releases it exactly once', async () => {
    const full = key('old-orphan', 'original', 'other', 'deleted-actor');
    seedObject(full, 19, new Date(Date.now() - 86400001)); failDeletes = true;
    await runKnowledgeImportCleanup(env);
    expect(objects.has(full)).toBe(true);
    expect(db.prepare("SELECT storage_used_bytes n FROM workspaces WHERE id='other'").get().n).toBe(19);
    expect(db.prepare('SELECT count(*) n FROM knowledge_import_files').get().n).toBe(1);
    failDeletes = false; await runKnowledgeImportCleanup(env); await runKnowledgeImportCleanup(env);
    expect(objects.has(full)).toBe(false); expect(deletes).toEqual([full]);
    expect(db.prepare("SELECT storage_used_bytes n FROM workspaces WHERE id='other'").get().n).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM knowledge_import_files').get().n).toBe(0);
  });

  it('never deletes a malformed inventory key outside the exact job prefix', async () => {
    seedJob('expired'); const repo = createImportCleanupRepository(env);
    repo.files = async () => ['another-user/other-job/private'];
    expect((await runImportCleanup(repo)).failed).toBe(1); expect(deletes).toEqual([]);
  });
});

describe('maintenance deployment entry points', () => {
  it('runs the Docker orphan scan with a fresh server check before each delete and continues after one failed object', async () => {
    let handler,tooMany=false,failObject=true;const operations=[];
    const objects=['old','new-reference','delete-failed','after-failure'].map(id=>({id,bucket_id:'kb-imports',key:`deleted-actor/${id}/original`,created_at:'2029-12-30T00:00:00Z',updated_at:'2029-12-30T00:00:00Z'}));
    objects.push({...objects[0],id:'ordinary-file',bucket_id:'kb-files'});
    const client={rpc:async(_name,{p_action,p_payload})=>{
      if(p_action==='orphan_scan')return {data:{objects:tooMany?Array(101).fill(objects[0]):objects,visited:5},error:null};
      expect(p_action).toBe('orphan_check');operations.push('check:'+p_payload.id);return {data:p_payload.id!=='new-reference',error:null};
    },storage:{from(bucket){expect(bucket).toBe('kb-imports');return {async remove(keys){const id=keys[0].split('/')[1];operations.push('remove:'+id);return {error:id==='delete-failed'&&failObject?{message:'unavailable'}:null};}};}}};
    const source=fs.readFileSync(path.resolve(__dirname,'../../docker/volumes/functions/knowledge-import-cleanup/index.ts'),'utf8');
    const js=transformSync(source.replace(/^import .*;\r?\n/gm,''),{loader:'ts',format:'cjs'}).code;
    new Function('createClient','importJobPrefix','IMPORT_CLEANUP_FILE_LIMIT','runImportCleanup','Deno',js)(
      ()=>client,()=>'',1000,async()=>({claimed:0,completed:0}),
      {env:{get:name=>name==='SUPABASE_SERVICE_ROLE_KEY'?'service-fixture':'http://local'},serve:fn=>{handler=fn;}});
    const request=()=>new Request('http://local/cleanup',{method:'POST',headers:{Authorization:'Bearer service-fixture'}});
    const response=await handler(request());expect(response.status).toBe(200);
    expect((await response.json()).orphans).toEqual({visited:5,removed:2,retained:1,failed:2});
    expect(operations).toEqual(['check:old','remove:old','check:new-reference','check:delete-failed','remove:delete-failed','check:after-failure','remove:after-failure']);
    failObject=false;const retry=await handler(request());expect((await retry.json()).orphans).toEqual({visited:5,removed:3,retained:1,failed:1});
    operations.length=0;tooMany=true;expect((await handler(request())).status).toBe(503);expect(operations).toEqual([]);
  });

  it('rejects member bearer tokens before creating a privileged Docker client', async () => {
    let handler; const createClient = vi.fn(); const cleanup = vi.fn();
    const source = fs.readFileSync(path.resolve(__dirname, '../../docker/volumes/functions/knowledge-import-cleanup/index.ts'), 'utf8');
    const js = transformSync(source.replace(/^import .*;\r?\n/gm, ''), { loader: 'ts', format: 'cjs' }).code;
    new Function('createClient', 'importJobPrefix', 'IMPORT_CLEANUP_FILE_LIMIT', 'runImportCleanup', 'Deno', js)(
      createClient, () => 'actor/job/', 1000, cleanup,
      { env: { get: key => key === 'SUPABASE_SERVICE_ROLE_KEY' ? 'service-secret-fixture' : 'http://local' }, serve: fn => { handler = fn; } });
    const response = await handler(new Request('http://local/cleanup', { method: 'POST', headers: { Authorization: 'Bearer member-jwt' } }));
    expect(response.status).toBe(403); expect(createClient).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
  });

  it('wires the real Cloud and Docker hourly schedules without exposing a member maintenance route', () => {
    const app = path.resolve(__dirname, '../..');
    const cloud = fs.readFileSync(path.join(app, 'worker/src/index.ts'), 'utf8');
    expect(cloud.slice(cloud.indexOf('async scheduled'))).toContain('runKnowledgeImportCleanup(env)');
    expect(cloud).not.toMatch(/app\.(?:post|get)\([^\n]*knowledge-import-cleanup/);
    const compose = fs.readFileSync(path.join(app, 'docker/docker-compose.yml'), 'utf8');
    expect(compose).toContain('/functions/v1/knowledge-import-cleanup');
    // The service-role key reaches curl on stdin, never on its command line (ps / /proc).
    const scheduler = compose.slice(compose.indexOf('livo-scheduler:'), compose.indexOf('\n  analytics:'));
    expect(scheduler).toContain("printf 'Authorization: Bearer %s\\nContent-Type: application/json\\n' \"$${SERVICE_ROLE_KEY}\"");
    expect(scheduler).toContain('-H @-');
    expect(scheduler).not.toMatch(/-H\s+"Authorization: Bearer \$\$\{SERVICE_ROLE_KEY\}"/);
  });
});
