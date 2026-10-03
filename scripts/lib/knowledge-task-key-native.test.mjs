// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const schema = fs.readFileSync(new URL('../../worker/schema.sql', import.meta.url), 'utf8');
const upgrade = fs.readFileSync(new URL('../../worker/knowledge-workflow.schema.sql', import.meta.url), 'utf8');
let db;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;${schema}
    INSERT INTO members(id,name,avatar,role,email) VALUES('owner','Synthetic owner','','member','owner@example.com');
    INSERT INTO product_lines(id,name) VALUES('line','Synthetic line');
    INSERT INTO projects(id,line_id,name,key) VALUES('project','line','Synthetic project','EX');
    INSERT INTO statuses(id,name,is_done) VALUES('open','Open',0);
    INSERT INTO tasks(id,task_key,project_id,title,status_id,creator_id) VALUES('task','EX-1','project','Original','open','owner');`);
});
afterEach(() => db.close());
const upsert = (id, key, title) => db.prepare(`INSERT INTO tasks(id,task_key,project_id,title,status_id,creator_id)
  VALUES(?,?,'project',?,'open','owner') ON CONFLICT(id) DO UPDATE SET title=excluded.title,task_key=excluded.task_key`).run(id, key, title);

describe('knowledge task key protection with existing task upserts', () => {
  it('allows the same card to keep its key when an upsert updates its title', () => {
    upsert('task', 'EX-1', 'Edited');
    expect(db.prepare('SELECT task_key,title FROM tasks WHERE id=?').get('task')).toMatchObject({ task_key: 'EX-1', title: 'Edited' });
  });
  it('still rejects a different new card reusing the key', () => {
    expect(() => upsert('other', 'EX-1', 'Collision')).toThrow('kb_workflow_task_key_conflict');
    expect(db.prepare('SELECT count(*) n FROM tasks').get().n).toBe(1);
  });
  it('still rejects renaming an existing different card to the used key', () => {
    upsert('other', 'EX-2', 'Other');
    expect(() => upsert('other', 'EX-1', 'Collision')).toThrow('kb_workflow_task_key_conflict');
    expect(db.prepare('SELECT task_key,title FROM tasks WHERE id=?').get('other')).toMatchObject({ task_key: 'EX-2', title: 'Other' });
  });
  it('replaces the legacy trigger on repeat upgrades without dropping task data', () => {
    db.exec(`DROP TRIGGER kb_task_key_insert;
      CREATE TRIGGER kb_task_key_insert BEFORE INSERT ON tasks
      WHEN EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND task_key=NEW.task_key)
      BEGIN SELECT RAISE(ABORT,'kb_workflow_task_key_conflict'); END;`);
    expect(() => upsert('task', 'EX-1', 'Before upgrade')).toThrow('kb_workflow_task_key_conflict');
    for (let n = 0; n < 2; n++) db.exec(upgrade);
    upsert('task', 'EX-1', 'After upgrade');
    expect(() => upsert('other', 'EX-1', 'Collision')).toThrow('kb_workflow_task_key_conflict');
    expect(db.prepare('SELECT count(*) n FROM tasks').get().n).toBe(1);
    expect(db.prepare('SELECT title FROM tasks WHERE id=?').get('task').title).toBe('After upgrade');
  });
});
