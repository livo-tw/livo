// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { runQuery } from '../../worker/src/db';
import { knowledgeStorageAllowed, knowledgeLockAllowed } from '../../worker/src/knowledge';
import { TABLES } from '../../worker/src/tables';
import { knowledgeCan, parseKnowledgePolicy } from '../../worker/src/knowledgeAccess';
import { handleDownload, handleUpload } from '../../worker/src/storage';
import { handleManageMember } from '../../worker/src/functions/manageMember';
vi.mock('../../worker/src/notify', () => ({ notifyChanges: vi.fn() }));

let db;
let env;
const ctx = { waitUntil: vi.fn() };
const actor = (id = 'member-a', role = 'member', workspaceId = 'default') => ({ userId: id, email: 'test@example.com', member: { id, role, workspaceId, email: 'test@example.com', name: 'Example' } });
function query(req, auth = actor()) {
  return runQuery(env, ctx, auth, { table: 'kb_pages', op: 'select', ...req });
}
async function create(values = {}, auth = actor()) {
  const result = await query({ op: 'insert', values: { title: 'Example guide', ...values }, single: true }, auth);
  expect(result.error).toBeNull();
  return result.data;
}
function lock(id, member = 'member-a', ws = 'default') {
  db.prepare('INSERT OR REPLACE INTO field_locks VALUES (?, ?, ?, ?)').run(`kb:${id}`, member, '2099-01-01T00:00:00.000Z', ws);
}
function update(p, values, auth = actor()) {
  return query({ op: 'update', filters: [{ col: 'id', op: 'eq', val: p.id }, { col: 'version', op: 'eq', val: p.version }], values, single: true }, auth);
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE members(id TEXT, role TEXT, job_title TEXT, is_active INTEGER, workspace_id TEXT, PRIMARY KEY(workspace_id,id));
    INSERT INTO members VALUES ('member-a','member','PM',1,'default'),('member-b','member','Engineer',1,'default'),('member-admin','admin','PM',1,'default'),('member-super','super_admin','Engineer',1,'default'),('other-admin','admin','Engineer',1,'default'),('member-b','admin','Engineer',1,'other');
    CREATE TABLE projects(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, is_archived INTEGER DEFAULT 0);
    CREATE TABLE field_locks(lock_key TEXT, locked_by TEXT, expires_at TEXT, workspace_id TEXT, PRIMARY KEY(workspace_id, lock_key));
    INSERT INTO projects VALUES ('project-a','default',0),('project-b','other',0);
    ALTER TABLE members ADD COLUMN auth_id TEXT; UPDATE members SET auth_id=id;`);
  const schema = fs.readFileSync(path.resolve(__dirname, '../../worker/schema.sql'), 'utf8');
  const kb = schema.slice(schema.indexOf('-- Knowledge base:'), schema.indexOf('CREATE TABLE IF NOT EXISTS auth_users'));
  db.exec(kb); db.exec(kb); // Fresh install and safe re-apply.
  env = { DB: { prepare(sql) {
    let params = [];
    return { bind(...args) { params = args; return this; },
      async all() { return { results: db.prepare(sql).all(...params) }; },
      async first() { return db.prepare(sql).get(...params) || null; },
      async run() { return db.prepare(sql).run(...params); } };
  } } };
});

const rule = (patch = {}) => ({ roles: [], positions: [], member_ids: [], ...patch });
const policy = (patch = {}) => ({ mode: 'custom', view: rule({ positions: ['PM'] }), edit: rule({ positions: ['PM'] }), comment: rule({ positions: ['PM'] }), ...patch });
const adminActor = () => actor('member-admin','admin');

describe('knowledge fine-grained ACL security', () => {
  it('accepts the single-row array the web client sends for pages and comments, and refuses a batch',async()=>{
    const created=await query({op:'insert',values:[{title:'From the web client'}],single:true});
    expect(created.error).toBeNull();expect(created.data.title).toBe('From the web client');
    expect((await query({table:'kb_comments',op:'insert',values:[{page_id:created.data.id,body:'Web comment'}]})).error).toBeNull();
    expect((await query({op:'insert',values:[{title:'One'},{title:'Two'}]})).error?.message).toBe('kb_invalid_request');
  });
  it('keeps a client-named page id (the web app reads the page back itself) and refuses a malformed one',async()=>{
    const page=await create({id:'0f6c6a4e-8d1b-4a39-9a8e-2f6b5c1d7e90'});
    expect(page.id).toBe('0f6c6a4e-8d1b-4a39-9a8e-2f6b5c1d7e90');
    expect((await query({op:'insert',values:{title:'Clash',id:'0f6c6a4e-8d1b-4a39-9a8e-2f6b5c1d7e90'}})).error).not.toBeNull();
    expect((await query({op:'insert',values:{title:'Bad id',id:"x'; --"}})).error?.message).toBe('kb_forbidden');
  });
  it('rejects a cached identity after its live authentication binding is changed',async()=>{
    const page=await create({access_policy:policy()},adminActor());
    db.prepare('UPDATE members SET auth_id=? WHERE id=?').run('replacement-user','member-a');
    expect((await query({filters:[{col:'id',op:'eq',val:page.id}]})).data).toEqual([]);
    expect(await knowledgeStorageAllowed(env,actor(),`kb/${page.id}/source.pdf`,'view')).toBe(false);
    expect(await knowledgeLockAllowed(env,actor(),`kb:${page.id}`)).toBe(false);
    expect((await query({op:'insert',values:{title:'New root'},single:true})).error?.message).toBe('kb_forbidden');
  });
  it('filters each row independently in a mixed public/private workspace',async()=>{
    await create({access_policy:policy()},adminActor());
    const ordinary=await create({title:'Public guide'});
    const other=actor('member-b');
    expect((await query({},other)).data.map(p=>p.id)).toEqual([ordinary.id]);
    expect((await query({head:true,count:'exact'},other)).count).toBe(1);
    lock(ordinary.id,'member-b');
    expect((await update(ordinary,{body:'Allowed edit'},other)).error).toBeNull();
  });
  it('filters direct reads, projections, counts, history, attachments and comments for all unauthorized roles', async () => {
    let p = await create({ access_policy: policy(), body: 'private' }, adminActor());
    lock(p.id,'member-admin'); p = (await update(p,{body:'private revision'},adminActor())).data;
    await query({ table:'kb_comments',op:'insert',values:{page_id:p.id,body:'private discussion'} });
    await query({ table:'kb_attachments',op:'insert',values:{page_id:p.id,file_name:'private.pdf',file_size:10,storage_path:`kb/${p.id}/private.pdf`} },adminActor());
    for (const auth of [actor('member-b'),actor('other-admin','admin'),actor('member-super','super_admin')]) {
      for (const table of ['kb_pages','kb_revisions','kb_attachments','kb_comments']) {
        expect((await query({table},auth)).data, table).toEqual([]);
        expect((await query({table,head:true,count:'exact'},auth)).count, table).toBe(0);
      }
      expect((await query({cols:'title',filters:[{col:'id',op:'eq',val:p.id}]},auth)).data).toEqual([]);
      expect(await knowledgeLockAllowed(env,auth,`kb:${p.id}`)).toBe(false);
      expect(await knowledgeStorageAllowed(env,auth,`kb/${p.id}/private.pdf`,'view')).toBe(false);
    }
  });
  it('intersects child rules with ancestors and denies inherited-parent escape', async () => {
    const p=await create({access_policy:policy()},adminActor());
    const child=await create({parent_id:p.id},adminActor());
    expect((await query({},actor('member-b'))).data).toEqual([]);
    lock(child.id);
    expect((await update(child,{parent_id:null})).error).not.toBeNull();
    expect((await query({op:'insert',values:{title:'Guess',parent_id:p.id}},actor('member-b'))).error).not.toBeNull();
  });
  it('allows exact role and member selectors without interpreting positions as roles', async () => {
    const p=await create({access_policy:policy({view:rule({roles:['admin'],member_ids:['member-b']})})},adminActor());
    expect((await query({},actor('other-admin','admin'))).data).toHaveLength(1);
    expect((await query({},actor('member-b'))).data).toHaveLength(1);
    expect((await query({},actor())).data).toEqual([]);
    expect((await query({},actor('member-super','super_admin'))).data).toEqual([]);
    expect(await knowledgeStorageAllowed(env,actor('member-b'),`kb/${p.id}/f`,'view')).toBe(true);
    expect(await knowledgeStorageAllowed(env,actor('member-b'),`kb/${p.id}/f`,'edit')).toBe(false);
  });
  it('keeps view, edit and comment independent and forces comment authorship', async () => {
    const p=await create({access_policy:policy({view:rule({roles:['member','admin']}),edit:rule({member_ids:['member-admin']}),comment:rule({member_ids:['member-b']})})},adminActor());
    lock(p.id,'member-b');
    expect((await update(p,{body:'illegal'},actor('member-b'))).error).not.toBeNull();
    expect((await query({table:'kb_comments',op:'insert',values:{page_id:p.id,body:'no'}},adminActor())).error).not.toBeNull();
    const c=await query({table:'kb_comments',op:'insert',single:true,values:{page_id:p.id,body:'yes',created_by:'forged'}},actor('member-b'));
    expect(c.error).toBeNull(); expect(c.data.created_by).toBe('member-b');
    expect((await query({table:'kb_comments',op:'update',filters:[{col:'id',op:'eq',val:c.data.id}],values:{body:'hijacked'}},adminActor())).error).not.toBeNull();
    expect((await query({table:'kb_comments',op:'update',filters:[{col:'id',op:'eq',val:c.data.id}],values:{body:'own edit'}},actor('member-b'))).error).toBeNull();
  });
  it('resolves position and active membership live even when auth context is unchanged', async () => {
    await create({access_policy:policy()},adminActor());
    expect((await query({})).data).toHaveLength(1);
    db.prepare("UPDATE members SET job_title='Engineer' WHERE workspace_id='default' AND id='member-a'").run();
    expect((await query({})).data).toEqual([]);
    db.prepare("UPDATE members SET job_title='PM',is_active=0 WHERE workspace_id='default' AND id='member-a'").run();
    expect((await query({})).data).toEqual([]);
  });
  it('rejects malformed selectors, self lockout and ACL changes from regular editors', async () => {
    expect(parseKnowledgePolicy({mode:'custom',view:rule()})).toBeNull();
    expect((await query({op:'insert',values:{title:'invalid',access_policy:{mode:'custom'}}},adminActor())).error).not.toBeNull();
    expect((await query({op:'insert',values:{title:'self lockout',access_policy:policy({view:rule({positions:['Other']})})}},adminActor())).error?.message).toBe('kb_self_lockout');
    const p=await create(); lock(p.id);
    expect((await update(p,{access_policy:policy()})).error).not.toBeNull();
    expect((await update(p,{access_policy:policy()},actor('member-a','admin'))).error).not.toBeNull();
    expect((await query({op:'insert',values:{title:'stale admin',access_policy:policy()}},actor('member-a','admin'))).error).not.toBeNull();
    expect((await query({table:'members',op:'update',filters:[{col:'id',op:'eq',val:'member-a'}],values:{job_title:'PM'}},actor('member-a','super_admin'))).error).not.toBeNull();
  });
  it('blocks legacy public attachments from being presented as newly private', async () => {
    const p=await create(); lock(p.id,'member-admin');
    db.prepare('INSERT INTO kb_attachments(id,workspace_id,page_id,file_name,file_size,storage_path,storage_bucket,uploaded_by) VALUES (?,?,?,?,?,?,?,?)').run('legacy','default',p.id,'legacy.pdf',10,`kb/${p.id}/legacy.pdf`,'task-images','member-a');
    expect((await update(p,{access_policy:policy()},adminActor())).error?.message).toBe('kb_legacy_public_attachments');
    expect((await query({table:'kb_attachments',op:'insert',values:{page_id:p.id,file_name:'x',file_size:1,storage_path:`kb/${p.id}/x`,storage_bucket:'task-images'}},adminActor())).error).not.toBeNull();
  });
  it('pure evaluator agrees on view prerequisites, missing ancestry and exact positions', () => {
    const pages=[{id:'p',parent_id:null,access_policy:policy({view:rule({positions:['PM']}),edit:rule({roles:['member']}),comment:rule()})}];
    expect(knowledgeCan(pages,'p',{id:'a',role:'member',jobTitle:'PM'},'edit')).toBe(true);
    expect(knowledgeCan(pages,'p',{id:'a',role:'member',jobTitle:'PM'},'comment')).toBe(false);
    expect(knowledgeCan(pages,'p',{id:'a',role:'member',jobTitle:'PM Lead'},'edit')).toBe(false);
    expect(knowledgeCan([{id:'c',parent_id:'missing'}],'c',{id:'a',role:'member'},'view')).toBe(false);
  });
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); });

describe('knowledge storage and identity boundaries',()=>{
  it('does not consult public caches or R2 for unauthorized private file reads', async () => {
    const p=await create({access_policy:policy()},adminActor());
    const cache={match:vi.fn(),put:vi.fn()}; vi.stubGlobal('caches',{default:cache});
    env.ATTACHMENTS={get:vi.fn(async()=>({body:'PDF',httpEtag:'test',writeHttpMetadata(h){h.set('content-type','application/pdf');}}))};
    const context=(auth)=>({env,get:()=>auth,json:(body,status=200)=>new Response(JSON.stringify(body),{status}),req:{raw:new Request('https://example.com/file')},executionCtx:ctx});
    expect((await handleDownload(context(undefined),'kb-files',`kb/${p.id}/file.pdf`)).status).toBe(404);
    expect((await handleDownload(context(actor('member-b')),'kb-files',`kb/${p.id}/file.pdf`)).status).toBe(404);
    expect(env.ATTACHMENTS.get).not.toHaveBeenCalled();
    const downloaded=await handleDownload(context(actor()),'kb-files',`kb/${p.id}/file.pdf`);
    expect(downloaded.status).toBe(200); expect(downloaded.headers.get('cache-control')).toBe('private, no-store');
    expect(cache.match).not.toHaveBeenCalled(); expect(cache.put).not.toHaveBeenCalled();
    expect(await knowledgeStorageAllowed(env,actor(),`ws/other/kb/${p.id}/file.pdf`,'view')).toBe(false);
  });
  it('refuses new public knowledge uploads and allows only private KB paths', async () => {
    const p=await create(); env.ATTACHMENTS={put:vi.fn()};
    const c={env,get:()=>actor(),json:(body,status=200)=>new Response(JSON.stringify(body),{status}),req:{header:()=>'',raw:{body:null}}};
    expect((await handleUpload(c,'task-images',`kb/${p.id}/file.pdf`)).status).toBe(403);
    expect((await handleUpload(c,'kb-files','outside/file.pdf')).status).toBe(403);
    expect(env.ATTACHMENTS.put).not.toHaveBeenCalled();
  });
  it('blocks administrator account-takeover paths before any account mutation', async () => {
    // Deactivating or deleting removes the member's login too: super_admin only, as in the app.
    for (const body of [{action:'create',jobTitle:'PM'},{action:'create',role:'super_admin'},{action:'reset_password',memberId:'member-a'},{action:'create_login',memberId:'member-a'},{action:'toggle_active',memberId:'member-a',isActive:false},{action:'delete',memberId:'member-a'}]) {
      let auth=adminActor(); const c={env,get:()=>auth,set:(_key,v)=>{auth=v;},req:{json:async()=>body},json:(v,status=200)=>new Response(JSON.stringify(v),{status})};
      expect((await handleManageMember(c)).status).toBe(403);
    }
    let auth=actor('member-a','super_admin');
    const stale={env,get:()=>auth,set:(_key,v)=>{auth=v;},req:{json:async()=>({action:'reset_password'})},json:(v,status=200)=>new Response(JSON.stringify(v),{status})};
    expect((await handleManageMember(stale)).status).toBe(403);
  });
});

describe('knowledge backend policy and atomic history', () => {
  it('registers boolean columns and keeps revisions server-written only', () => {
    expect(TABLES.kb_pages.boolCols).toEqual(['is_archived', 'admin_only']);
    expect(TABLES.kb_revisions.write).toEqual({ insert: 'none', update: 'none', delete: 'none' });
  });
  it('forces authorship and prevents members setting admin flags or spoofing ownership', async () => {
    const p = await create({ created_by: 'someone-else' });
    expect(p.created_by).toBe('member-a');
    expect((await query({ op: 'insert', values: { title: 'Private rule', admin_only: true } })).error).not.toBeNull();
    lock(p.id);
    expect((await update(p, { admin_only: true })).error).not.toBeNull();
    expect((await update(p, { is_archived: true })).error).not.toBeNull();
    expect((await update(p, { id: 'new-id' })).error).not.toBeNull();
    expect((await query({ op: 'upsert', values: { id: p.id, title: 'Bypass' } })).error).not.toBeNull();
  });
  it('requires a current edit lock and rejects stale saves without losing a revision', async () => {
    const p = await create({ body: 'original' });
    expect((await update(p, { body: 'unlocked' })).error).not.toBeNull();
    lock(p.id);
    const saved = await update(p, { body: 'new' });
    expect(saved.error).toBeNull();
    expect((await update(p, { body: 'stale' })).error).not.toBeNull();
    expect(db.prepare('SELECT body FROM kb_revisions').all()).toEqual([{ body: 'original' }]);
    expect(db.prepare('SELECT body FROM kb_pages').get()?.body).toBe('new');
  });
  it('retains exactly 20 previous bodies and records the current body before restore', async () => {
    let p = await create({ body: 'initial' }); lock(p.id);
    for (let n = 1; n <= 25; n++) { const result = await update(p, { body: `body ${n}` }); expect(result.error).toBeNull(); p = result.data; }
    const history = db.prepare('SELECT * FROM kb_revisions ORDER BY version DESC').all();
    expect(history).toHaveLength(20);
    expect(history[0].body).toBe('body 24');
    expect(history[19].version).toBe(6);
    expect((await update(p, { body: history[19].body })).error).toBeNull();
    expect(db.prepare('SELECT body FROM kb_revisions ORDER BY version DESC LIMIT 1').get()?.body).toBe('body 25');
  });
  it('isolates reads, parent references, attachments and writes by workspace', async () => {
    const p = await create({ project_id: 'project-a' });
    expect((await query({}, actor('member-b', 'admin', 'other'))).data).toEqual([]);
    expect((await query({ op: 'insert', values: { title: 'Bad', project_id: 'project-b' } })).error).not.toBeNull();
    expect((await query({ op: 'insert', values: { title: 'Bad', parent_id: p.id } }, actor('member-b', 'admin', 'other'))).error).not.toBeNull();
    lock(p.id, 'member-b', 'other');
    expect((await update(p, { body: 'cross-tenant' }, actor('member-b', 'admin', 'other'))).error).not.toBeNull();
    expect(await knowledgeStorageAllowed(env, actor('member-b', 'admin', 'other'), `ws/other/kb/${p.id}/file.pdf`)).toBe(false);
  });
  it('enforces max depth, prevents cycles and validates descendant depth when moving a subtree', async () => {
    const a = await create(), b = await create({ parent_id: a.id }), c = await create({ parent_id: b.id });
    expect((await query({ op: 'insert', values: { title: 'Too deep', parent_id: c.id } })).error?.message).toContain('kb_depth');
    lock(a.id);
    expect((await update(a, { parent_id: c.id })).error).not.toBeNull();
    const other = await create();
    expect((await update(a, { parent_id: other.id })).error).not.toBeNull();
    expect((await query({ op: 'delete', filters: [{ col: 'id', op: 'eq', val: a.id }] })).error).not.toBeNull();
  });
  it('does not move a page into an archived project', async () => {
    const p = await create(); lock(p.id);
    db.prepare('UPDATE projects SET is_archived = 1 WHERE id = ?').run('project-a');
    expect((await update(p, { project_id: 'project-a' })).error?.message).toContain('kb_invalid_project');
  });
  it('allows authors or admins to delete, but prevents a member deleting someone else’s page', async () => {
    const p = await create();
    const remove = { op: 'delete', filters: [{ col: 'id', op: 'eq', val: p.id }] };
    expect((await query(remove, actor('member-b'))).error).not.toBeNull();
    expect((await query(remove, actor('member-b', 'admin'))).error).not.toBeNull(); // A stale role cannot elevate the live member.
    expect((await query(remove, actor('member-admin', 'admin'))).error).toBeNull();
  });
  it('locks admin-only pages and files, supports admin unarchive, and rejects forged revisions', async () => {
    const admin = actor('member-admin', 'admin');
    let p = await create({ admin_only: true }, admin);
    expect(await knowledgeLockAllowed(env, actor(), `kb:${p.id}`)).toBe(false);
    expect(await knowledgeLockAllowed(env, admin, `kb:${p.id}`)).toBe(true);
    lock(p.id);
    expect((await update(p, { body: 'no' })).error).not.toBeNull();
    expect(await knowledgeStorageAllowed(env, actor(), `kb/${p.id}/file.pdf`)).toBe(false);
    expect((await query({ table: 'kb_revisions', op: 'insert', values: { page_id: p.id, body: 'forged' } })).error).not.toBeNull();
    lock(p.id, admin.member.id);
    p = (await update(p, { is_archived: true }, admin)).data;
    expect((await update(p, { body: 'archived edit' }, admin)).error).not.toBeNull();
    expect((await update(p, { is_archived: false }, admin)).error).toBeNull();
  });
  it('validates attachment paths and honors page locks in both metadata and object writes', async () => {
    const p = await create();
    const attachment = { page_id: p.id, file_name: 'guide.pdf', file_size: 100, file_type: 'application/pdf', storage_path: `kb/${p.id}/guide.pdf` };
    expect((await query({ table: 'kb_attachments', op: 'insert', values: { ...attachment, storage_path: 'kb/another/file.pdf' } })).error).not.toBeNull();
    lock(p.id, 'member-b');
    expect((await query({ table: 'kb_attachments', op: 'insert', values: attachment })).error).not.toBeNull();
    expect(await knowledgeStorageAllowed(env, actor(), attachment.storage_path)).toBe(false);
    lock(p.id);
    const result = await query({ table: 'kb_attachments', op: 'insert', values: attachment });
    expect(result.error).toBeNull();
  });
});

it('ships Docker RLS, protected storage paths, immutable history and realtime policies', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20261002_knowledge_base.sql'), 'utf8');
  for (const table of ['kb_pages','kb_revisions','kb_attachments']) expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
  expect(sql).toContain('created_by = public.current_member_id()');
  expect(sql).toContain('OLD.admin_only');
  expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON public.kb_revisions');
  expect(sql).toContain('AS RESTRICTIVE FOR INSERT TO public');
  expect(sql).toContain('kb_lock_guard');
  expect(sql).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE');
});
