// @vitest-environment node
// Real schema and triggers on native SQLite; synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
vi.mock('../src/license', () => ({ isProfessional: async () => true }));
vi.mock('../src/notify', () => ({ notifyChanges: () => Promise.resolve() }));
vi.mock('../src/functions/emailNotify', () => ({ sendNotificationEmails: () => Promise.resolve() }));
vi.mock('../src/functions/webhooks', () => ({ dispatchWebhooks: () => Promise.resolve() }));
import { runQuery } from '../src/db';
import { requireMember, sha256Hex } from '../src/auth';
import { executeTaskWorkCommand } from '../src/taskWork';
import { knowledgeSnapshot } from '../src/knowledgeWork';
import { handleKnowledgePreferences } from '../src/knowledgePreferences';
import { commandAuthId, liveMember } from '../src/liveMember';
import type { AppContext, AuthCtx, Env } from '../src/env';
import type { QueryRequest } from '../src/protocol';

type Row = Record<string, unknown>;
let db: DatabaseSync, env: Env, seq = 0;

const who = (userId: string, memberId: string, workspaceId = 'a'): AuthCtx => ({
  userId, email: `${memberId}@example.com`,
  member: { id: memberId, role: 'member', email: `${memberId}@example.com`, name: 'Example', workspaceId },
});
const jwt = () => who('login-member', 'member');
const pat = (token: string, memberId = 'member') => who(`pat:${token}`, memberId);
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const query = (auth: AuthCtx, req: Partial<QueryRequest> & { table: string; op: QueryRequest['op'] }) => runQuery(env, ctx, auth, req as QueryRequest);
const insertTask = (auth: AuthCtx) => query(auth, { table: 'tasks', op: 'insert', values: {
  id: `task-${++seq}`, task_key: `K-${seq}`, project_id: 'p', title: 'Created with a key', status_id: 'todo', creator_id: auth.member.id,
} });
const renameTask = (auth: AuthCtx, title: string) => query(auth, { table: 'tasks', op: 'update', values: { title }, filters: [{ col: 'id', op: 'eq', val: 't' }] });
const readPages = async (auth: AuthCtx) => ((await query(auth, { table: 'kb_pages', op: 'select' })).data as Row[] | null ?? []).map(p => p.id);
const title = () => (db.prepare("SELECT title FROM tasks WHERE id='t'").get() as Row).title;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO workspaces(id,name) VALUES('a','Synthetic A'),('b','Synthetic B');
    INSERT INTO product_lines(workspace_id,id,name) VALUES('a','line-a','A');
    INSERT INTO projects(workspace_id,id,line_id,name,key,is_archived) VALUES('a','p','line-a','P','P',0);
    INSERT INTO statuses(workspace_id,id,name) VALUES('a','todo','Todo');
    INSERT INTO auth_users(id,email,banned) VALUES('login-member','member@example.com',0),('login-banned','banned@example.com',1),
      ('login-gone','gone@example.com',0),('login-foreign','foreign@example.com',0);
    INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id,is_active) VALUES
      ('a','member','Member','','member@example.com','member','login-member',1),
      ('a','nologin','Integration','','nologin@example.com','member',NULL,1),
      ('a','banned','Banned','','banned@example.com','member','login-banned',1),
      ('a','gone','Former','','gone@example.com','member','login-gone',0),
      ('b','foreign','Foreign','','foreign@example.com','admin','login-foreign',1);
    INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id,assignee_id) VALUES('a','t','T-1','p','Original','todo','member','member');
    INSERT INTO api_tokens(workspace_id,id,name,token_hash,member_id,created_by,revoked_at) VALUES
      ('a','tok-member','Script','h1','member','member',NULL),
      ('a','tok-revoked','Old script','h2','member','member','2026-01-01T00:00:00.000Z'),
      ('a','tok-nologin','Integration','h3','nologin','member',NULL),
      ('a','tok-banned','Banned script','h4','banned','member',NULL),
      ('a','tok-gone','Former script','h5','gone','member',NULL),
      ('b','tok-cross','Foreign row','h6','member','foreign',NULL);`);
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args as never[]) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args as never[]), success: true }),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args as never[]).changes) } }),
    execute: () => ({ results: db.prepare(sql).all(...args as never[]), success: true }),
  });
  env = { DB: {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ execute: () => unknown }>) => {
      db.exec('BEGIN');
      try { const results = statements.map(s => s.execute()); db.exec('COMMIT'); return results; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  } } as unknown as Env;
});
afterEach(() => db.close());

describe('live member check for sessions and personal API keys', () => {
  it('lets a session and its member key create and update tasks', async () => {
    expect((await insertTask(jwt())).error).toBeNull();
    expect((await insertTask(pat('tok-member'))).error).toBeNull();
    expect((await insertTask(pat('tok-nologin', 'nologin'))).error).toBeNull();
    expect((await renameTask(pat('tok-member'), 'Renamed with a key')).error).toBeNull();
    expect(title()).toBe('Renamed with a key');
    expect(db.prepare("SELECT count(*) AS n FROM tasks WHERE title='Created with a key'").get()).toEqual({ n: 3 });
  });

  it('refuses revoked keys, keys of deactivated or banned members and cross-workspace key rows', async () => {
    for (const auth of [pat('tok-revoked'), pat('tok-gone', 'gone'), pat('tok-banned', 'banned'), pat('tok-cross'), pat('tok-member', 'nologin'), pat('missing')]) {
      expect((await insertTask(auth)).error).not.toBeNull();
      expect((await renameTask(auth, 'Changed by a dead key')).error).not.toBeNull();
      expect(await liveMember(env, auth)).toBeNull();
    }
    expect(title()).toBe('Original');
    expect(db.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 1 });
  });

  it('stops a key revoked or a member deactivated after authentication', async () => {
    const key = pat('tok-member');
    expect((await renameTask(key, 'First')).error).toBeNull();
    db.exec("UPDATE api_tokens SET revoked_at='2026-10-01T00:00:00.000Z' WHERE id='tok-member'");
    expect((await renameTask(key, 'Second')).error).not.toBeNull();
    const session = jwt();
    db.exec("UPDATE members SET is_active=0 WHERE id='member'");
    expect((await renameTask(session, 'Third')).error).not.toBeNull();
    expect(title()).toBe('First');
  });

  it('reads and writes the knowledge base with a key exactly as the member', async () => {
    const created = await query(jwt(), { table: 'kb_pages', op: 'insert', values: { title: 'Runbook' }, single: true });
    expect(created.error).toBeNull();
    const page = (created.data as Row).id;
    expect(await readPages(jwt())).toEqual([page]);
    expect(await readPages(pat('tok-member'))).toEqual([page]);
    const viaKey = await query(pat('tok-member'), { table: 'kb_pages', op: 'insert', values: { title: 'Written by a key' }, single: true });
    expect(viaKey.error).toBeNull();
    expect((viaKey.data as Row).created_by).toBe('member');
    for (const auth of [pat('tok-revoked'), pat('tok-gone', 'gone'), pat('tok-banned', 'banned'), pat('tok-cross')]) {
      expect(await readPages(auth)).toEqual([]);
      expect((await query(auth, { table: 'kb_pages', op: 'insert', values: { title: 'Denied' }, single: true })).error?.message).toBe('kb_forbidden');
      expect((await handleKnowledgePreferences(env, auth, { p_action: 'read' })).error?.message).toBe('kb_forbidden');
    }
    expect((await handleKnowledgePreferences(env, pat('tok-member'), { p_action: 'read' })).error).toBeNull();
    // A custom page limited to another member stays hidden from the key, as from the member.
    const policy = JSON.stringify({ mode: 'custom', view: { roles: [], positions: [], member_ids: ['nologin'] }, edit: { roles: [], positions: [], member_ids: [] }, comment: { roles: [], positions: [], member_ids: [] } });
    db.prepare('UPDATE kb_pages SET access_policy=? WHERE id=?').run(policy, String(page));
    expect(await readPages(jwt())).not.toContain(page);
    expect(await readPages(pat('tok-member'))).not.toContain(page);
  });

  it('records the member login for trigger-guarded commands and refuses keys without one', async () => {
    expect(await commandAuthId(env, jwt())).toBe('login-member');
    expect(await commandAuthId(env, pat('tok-member'))).toBe('login-member');
    for (const auth of [pat('tok-revoked'), pat('tok-nologin', 'nologin'), pat('tok-gone', 'gone'), pat('tok-banned', 'banned')])
      expect(await commandAuthId(env, auth)).toBeNull();
    const result = await executeTaskWorkCommand(env, pat('tok-member'), { commandId: 'key-work-1', operation: 'add_item', taskId: 't', list: 'checks', text: 'Synthetic item', isDone: false });
    expect(result).toMatchObject({ replayed: false });
    expect(db.prepare('SELECT count(*) AS n FROM task_checks').get()).toEqual({ n: 1 });
    await expect(executeTaskWorkCommand(env, pat('tok-revoked'), { commandId: 'key-work-2', operation: 'add_item', taskId: 't', list: 'checks', text: 'Denied', isDone: false })).rejects.toThrow();
    expect((await knowledgeSnapshot(env, pat('tok-member'))).authId).toBe('login-member');
    await expect(knowledgeSnapshot(env, pat('tok-nologin', 'nologin'))).rejects.toThrow('knowledge_forbidden');
    await expect(knowledgeSnapshot(env, pat('tok-revoked'))).rejects.toThrow('knowledge_forbidden');
  });

  it('authenticates a key only for an active, unbanned member of the key workspace', async () => {
    const app = new Hono<AppContext>();
    app.get('/private', requireMember, c => c.json({ member: c.get('auth').member.id, user: c.get('auth').userId }));
    const rehash = db.prepare('UPDATE api_tokens SET token_hash=? WHERE id=?');
    for (const id of ['tok-member', 'tok-banned', 'tok-cross', 'tok-gone', 'tok-revoked']) rehash.run(await sha256Hex(`livo_pat_${id}`), id);
    db.exec("UPDATE api_tokens SET last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    const call = async (id: string) => app.request('/private', { headers: { Authorization: `Bearer livo_pat_${id}` } }, env, ctx);
    const ok = await call('tok-member');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ member: 'member', user: 'pat:tok-member' });
    expect((await call('tok-banned')).status).toBe(403);
    expect((await call('tok-gone')).status).toBe(403);
    expect((await call('tok-cross')).status).toBe(401);
    expect((await call('tok-revoked')).status).toBe(401);
  });
});
