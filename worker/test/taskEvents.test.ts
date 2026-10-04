// @vitest-environment node
// Real D1 schema on native SQLite; synthetic data only.
import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { withFullTaskRows } from '../src/taskEvents';
import type { Env } from '../src/env';
import type { ChangeEvent } from '../src/protocol';

let db: DatabaseSync, env: Env;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO workspaces(id,name) VALUES('a','Synthetic A'),('b','Synthetic B');
    INSERT INTO product_lines(workspace_id,id,name) VALUES('a','line-a','A');
    INSERT INTO projects(workspace_id,id,line_id,name,key,is_archived) VALUES('a','p','line-a','P','P',0);
    INSERT INTO statuses(workspace_id,id,name) VALUES('a','todo','Todo');
    INSERT INTO members(workspace_id,id,name,avatar,email,role,is_active) VALUES('a','member','Member','','member@example.com','member',1);
    INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id,requires_approval)
      VALUES('a','t','P-1','p','Full title','todo','member',1);`);
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    all: async () => ({ results: db.prepare(sql).all(...args as never[]), success: true }),
  });
  env = { DB: { prepare: (sql: string) => statement(sql) } } as unknown as Env;
});

describe('withFullTaskRows', () => {
  it('replaces a partial command row with the full stored task, in wire format', async () => {
    const partial: ChangeEvent = { table: 'tasks', eventType: 'UPDATE', new: { id: 't', status_id: 'todo' }, old: null };
    const [event] = await withFullTaskRows(env, 'a', [partial]);
    expect(event.new).toMatchObject({ id: 't', title: 'Full title', project_id: 'p', task_key: 'P-1', requires_approval: true });
  });
  it('keeps other tables and DELETE events, and never reads another workspace', async () => {
    const request: ChangeEvent = { table: 'approval_requests', eventType: 'UPDATE', new: { id: 'r' }, old: null };
    const removed: ChangeEvent = { table: 'tasks', eventType: 'DELETE', new: null, old: { id: 't' } };
    const foreign: ChangeEvent = { table: 'tasks', eventType: 'UPDATE', new: { id: 't' }, old: null };
    expect(await withFullTaskRows(env, 'a', [request, removed])).toEqual([request, removed]);
    // The row exists only in workspace a: a broadcast for b is dropped, not sent half-empty.
    expect(await withFullTaskRows(env, 'b', [foreign, request])).toEqual([request]);
  });
  it('never fails the command when the read fails', async () => {
    const broken = { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('D1 unavailable'); } }) }) } } as unknown as Env;
    const request: ChangeEvent = { table: 'approval_requests', eventType: 'UPDATE', new: { id: 'r' }, old: null };
    expect(await withFullTaskRows(broken, 'a', [{ table: 'tasks', eventType: 'UPDATE', new: { id: 't' }, old: null }, request])).toEqual([request]);
  });
});
