// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
vi.mock('../src/notify', () => ({ notifyChanges: vi.fn() }));
import { writeKnowledge } from '../src/knowledge';
import { runQuery } from '../src/db';
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

describe('cloud knowledge attachment references', () => {
  const storagePath = 'ws/alpha/kb/page-1/example.txt';
  const attachment = {
    page_id: 'page-1', file_name: 'example.txt', file_size: 7,
    storage_path: storagePath, storage_bucket: 'kb-files',
  };
  const insert = (values: Record<string, unknown>) =>
    writeKnowledge(env, ctx, editor, { table: 'kb_attachments', op: 'insert', values: [values] });

  it('stores the client-generated ID so it can be read back after an uncertain insert', async () => {
    const id = 'e440b7b7-5559-4a1a-810e-91f9354b2c1a';
    expect((await insert({ ...attachment, id })).error).toBeNull();
    const stored = await runQuery(env, ctx, editor, {
      table: 'kb_attachments', op: 'select', filters: [{ col: 'id', op: 'eq', val: id }], maybeSingle: true,
    });
    expect(stored.error).toBeNull();
    expect(stored.data).toMatchObject({ id, page_id: attachment.page_id, storage_path: storagePath, uploaded_by: editor.member.id });
  });

  it('allows legacy inserts without an ID but rejects an invalid supplied ID', async () => {
    expect((await insert({ ...attachment, id: 'invalid id' })).error?.message).toBe('kb_invalid_request');
    const legacy = await insert(attachment);
    expect(legacy.error).toBeNull();
    expect(legacy.data).toMatchObject([{ id: expect.stringMatching(/^[0-9a-f-]{36}$/) }]);
  });

  it('acknowledges an exact guarded delete and keeps metadata for a stale path, page or lock', async () => {
    const id = 'cf-attachment-1';
    expect((await insert({ ...attachment, id })).error).toBeNull();
    const remove = (page: string, storage: string) => writeKnowledge(env, ctx, editor, {
      table: 'kb_attachments', op: 'delete', single: true, filters: [
        { col: 'id', op: 'eq', val: id },
        { col: 'page_id', op: 'eq', val: page },
        { col: 'storage_path', op: 'eq', val: storage },
      ],
    });
    expect((await remove('page-2', storagePath)).error?.message).toBe('kb_conflict');
    expect((await remove(attachment.page_id, 'ws/alpha/kb/page-1/stale.txt')).error?.message).toBe('kb_conflict');
    lock('boss');
    expect((await remove(attachment.page_id, storagePath)).error?.message).toBe('kb_conflict');
    expect(db.prepare('SELECT id FROM kb_attachments WHERE id=?').get(id)).toMatchObject({ id });
    lock('writer');
    const result = await remove(attachment.page_id, storagePath);
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ id, page_id: attachment.page_id, storage_path: storagePath, storage_bucket: 'kb-files' });
    expect(db.prepare('SELECT id FROM kb_attachments WHERE id=?').get(id)).toBeUndefined();
  });
});
