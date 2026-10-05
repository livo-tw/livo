// @vitest-environment node
// Real schema on native SQLite; synthetic data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
vi.mock('../src/notify', () => ({ notifyChanges: () => {} }));
import { handleManageMember } from '../src/functions/manageMember';
import type { AppContext, Env } from '../src/env';

let db: DatabaseSync, env: Env;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const app = new Hono<AppContext>();
app.post('/manage-member', async (c, next) => {
  c.set('auth', { userId: 'login-owner', email: 'owner@example.com', member: { id: 'owner', role: 'super_admin', email: 'owner@example.com', name: 'Owner', workspaceId: 'a' } });
  await next();
}, handleManageMember);
const remove = async (memberId: string) => {
  const res = await app.request('/manage-member', { method: 'POST', body: JSON.stringify({ action: 'delete', memberId }), headers: { 'content-type': 'application/json' } }, env, ctx);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO product_lines(workspace_id,id,name) VALUES('a','line-a','A');
    INSERT INTO projects(workspace_id,id,line_id,name,key,is_archived) VALUES('a','p','line-a','P','P',0);
    INSERT INTO statuses(workspace_id,id,name) VALUES('a','todo','Todo');
    INSERT INTO auth_users(id,email,banned) VALUES('login-owner','owner@example.com',0),('login-worker','worker@example.com',0),('login-new','new@example.com',0);
    INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id,is_active) VALUES
      ('a','owner','Owner','','owner@example.com','super_admin','login-owner',1),
      ('a','worker','Worker','','worker@example.com','member','login-worker',1),
      ('a','new','Added by mistake','','new@example.com','member','login-new',1);
    INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id,assignee_id) VALUES('a','t','T-1','p','Work','todo','owner','worker');`);
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args as never[]) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args as never[]), success: true }),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args as never[]).changes) } }),
    execute: () => db.prepare(sql).run(...args as never[]),
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

describe('deleting a member', () => {
  it('refuses a member who has tasks with a code the app can explain, and keeps the login', async () => {
    const { status, body } = await remove('worker');
    expect(status).toBe(409);
    expect(body.error).toBe('member_has_history');
    expect(count("SELECT count(*) AS n FROM members WHERE id='worker'")).toBe(1);
    expect(count("SELECT count(*) AS n FROM auth_users WHERE id='login-worker'")).toBe(1);
  });

  it('removes a member without history together with the login', async () => {
    const { status, body } = await remove('new');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(count("SELECT count(*) AS n FROM members WHERE id='new'")).toBe(0);
    expect(count("SELECT count(*) AS n FROM auth_users WHERE id='login-new'")).toBe(0);
  });
});
