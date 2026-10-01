// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { runQuery } from '../../worker/src/db';
import { knowledgeStorageAllowed, knowledgeLockAllowed } from '../../worker/src/knowledge';
import { TABLES } from '../../worker/src/tables';
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
    CREATE TABLE projects(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, is_archived INTEGER DEFAULT 0);
    CREATE TABLE field_locks(lock_key TEXT, locked_by TEXT, expires_at TEXT, workspace_id TEXT, PRIMARY KEY(workspace_id, lock_key));
    INSERT INTO projects VALUES ('project-a','default',0),('project-b','other',0);`);
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
afterEach(() => db.close());

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
    expect((await query(remove, actor('member-b', 'admin'))).error).toBeNull();
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
