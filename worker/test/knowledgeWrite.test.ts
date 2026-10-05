// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
vi.mock('../src/notify', () => ({ notifyChanges: vi.fn() }));
import { writeKnowledge } from '../src/knowledge';
import type { AuthCtx, Ctx, Env } from '../src/env';
import type { QueryRequest } from '../src/protocol';

let db: DatabaseSync, env: Env;
const ctx = { waitUntil: () => undefined } as unknown as Ctx;
const actor = (id: string, role: string): AuthCtx => ({ userId: id, email: `${id}@example.com`, member: { id, workspaceId: 'alpha', role, email: `${id}@example.com`, name: id } });
const editor = actor('writer', 'member'), admin = actor('boss', 'super_admin');
const save = (who: AuthCtx, values: Record<string, unknown>, version = 1): QueryRequest =>
  ({ table: 'kb_pages', op: 'update', values, filters: [{ col: 'id', op: 'eq', val: 'page-1' }, { col: 'version', op: 'eq', val: version }] } as QueryRequest);
const lock = (member: string) => db.prepare("INSERT OR REPLACE INTO field_locks(workspace_id,lock_key,locked_by,expires_at) VALUES('alpha','kb:page-1',?,?)").run(member, '2999-01-01T00:00:00.000Z');

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(path.resolve(__dirname, '../schema.sql'), 'utf8'));
  db.exec(`INSERT INTO auth_users(id,email) VALUES('writer','writer@example.com'),('boss','boss@example.com');
    INSERT INTO members(workspace_id,id,name,avatar,is_active,role,job_title,email,auth_id) VALUES
      ('alpha','writer','Writer','',1,'member','Engineer','writer@example.com','writer'),
      ('alpha','boss','Boss','',1,'super_admin','Lead','boss@example.com','boss');
    INSERT INTO kb_pages(workspace_id,id,parent_id,project_id,sort_order,title,body,access_policy,created_by,updated_by)
      VALUES('alpha','page-1',NULL,NULL,0,'Guide','<p>old</p>','{"mode":"inherit"}','boss','boss'),
            ('alpha','page-2',NULL,NULL,1,'Other','','{"mode":"inherit"}','boss','boss');`);
  const statement = (sql: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...values as never[]) || null,
    all: async () => ({ results: db.prepare(sql).all(...values as never[]) }),
    run: async () => db.prepare(sql).run(...values as never[]),
  });
  env = { DB: { prepare: (sql: string) => statement(sql) } } as unknown as Env;
});
afterEach(() => db.close());

describe('saving a knowledge page on the cloud backend', () => {
  it('lets an editor save when the placement fields are resent unchanged', async () => {
    lock('writer');
    const result = await writeKnowledge(env, ctx, editor, save(editor, { title: 'Guide', body: '<p>new</p>', category: 'general', project_id: null, parent_id: null, sort_order: 0 }));
    expect(result.error).toBeNull();
    expect(db.prepare("SELECT body,version FROM kb_pages WHERE id='page-1'").get()).toMatchObject({ body: '<p>new</p>', version: 2 });
  });
  it('still refuses an editor who actually moves the page', async () => {
    lock('writer');
    const result = await writeKnowledge(env, ctx, editor, save(editor, { title: 'Guide', body: '<p>new</p>', parent_id: 'page-2' }));
    expect(result.error?.message).toBe('kb_forbidden');
  });
  it('lets an administrator edit text on a page that still has an old public attachment', async () => {
    db.prepare("INSERT INTO kb_attachments(id,workspace_id,page_id,file_name,file_size,storage_path,storage_bucket,uploaded_by) VALUES('att-1','alpha','page-1','a.txt',1,'kb/page-1/a.txt','task-images','boss')").run();
    lock('boss');
    const result = await writeKnowledge(env, ctx, admin, save(admin, { title: 'Guide', body: '<p>admin</p>', parent_id: null, access_policy: { mode: 'inherit' } }));
    expect(result.error).toBeNull();
  });
});
