// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { applyPostTenantSchemaUpgrades } from '../migrate/schema-upgrades.mjs';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const refreshableGuards = ['approval-commands.sql', 'task-reminder-preferences.sql', 'task-work-commands.sql', 'qa-coordination.sql', 'knowledge-work.sql', 'release-workspace.sql'];
let db: DatabaseSync;
afterEach(() => db?.close());

describe('additive QA configuration capability migration', () => {
  const adapter = () => ({
    queryRows: (sql: string) => db.prepare(sql).all(),
    applyFile: (name: string) => {
      expect(['qa-admin-capability.sql', ...refreshableGuards]).toContain(name);
      const migration = readFileSync(new URL('../migrate/' + name, import.meta.url), 'utf8');
      db.exec('BEGIN');
      try { db.exec(migration); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  });
  it('preserves roles and CASCADE/SET NULL children in both workspaces, then skips reruns', async () => {
    db = new DatabaseSync(':memory:');
    // Model the pre-capability schema while retaining the real merged domain guards.
    db.exec(schema.replace(/  is_qa_admin INTEGER NOT NULL DEFAULT 0 CHECK \(is_qa_admin IN \(0,1\)\),\r?\n/, ''));
    expect(db.prepare('PRAGMA table_info(members)').all().some(column => column.name === 'is_qa_admin')).toBe(false);
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE manuals(id TEXT PRIMARY KEY,member_id TEXT REFERENCES members(id) ON DELETE CASCADE,body TEXT);
      CREATE TABLE notes(id TEXT PRIMARY KEY,member_id TEXT REFERENCES members(id) ON DELETE SET NULL,body TEXT);
      INSERT INTO members(workspace_id,id,name,avatar,email,role) VALUES('a','member-a','A','','a@example.com','member'),('b','member-b','B','','b@example.com','super_admin');
      INSERT INTO manuals VALUES('a','member-a','Keep A'),('b','member-b','Keep B');
      INSERT INTO notes VALUES('a','member-a','Note A'),('b','member-b','Note B');`);
    const before = ['members','manuals','notes'].map(table => db.prepare(`SELECT ${table === 'members' ? 'workspace_id,id,role' : '*'} FROM ${table} ORDER BY id`).all());
    expect(await applyPostTenantSchemaUpgrades(adapter())).toEqual(['qa-admin-capability.sql', ...refreshableGuards]);
    expect(db.prepare('SELECT workspace_id,id,role FROM members ORDER BY id').all()).toEqual(before[0]);
    expect(db.prepare('SELECT * FROM manuals ORDER BY id').all()).toEqual(before[1]);
    expect(db.prepare('SELECT * FROM notes ORDER BY id').all()).toEqual(before[2]);
    expect(db.prepare('SELECT is_qa_admin FROM members ORDER BY id').all()).toEqual([{is_qa_admin:0},{is_qa_admin:0}]);
    db.exec("UPDATE members SET is_qa_admin=1 WHERE id='member-a'");
    expect(await applyPostTenantSchemaUpgrades(adapter())).toEqual(refreshableGuards);
    expect(db.prepare("SELECT role,is_qa_admin FROM members WHERE id='member-a'").get()).toEqual({role:'member',is_qa_admin:1});
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => db.exec("UPDATE members SET is_qa_admin=2 WHERE id='member-a'")).toThrow(/CHECK/);
    expect(() => db.exec("UPDATE members SET role='qa_admin' WHERE id='member-a'")).toThrow(/CHECK/);
  });
  it('uses the same flag and unchanged global role constraint on a fresh schema', async () => {
    db = new DatabaseSync(':memory:');
    db.exec(schema);
    expect(await applyPostTenantSchemaUpgrades(adapter())).toEqual(refreshableGuards);
    db.exec("INSERT INTO members(id,name,avatar,email,is_qa_admin) VALUES('qa-manager','Example QA','','qa@example.com',1)");
    expect(db.prepare("SELECT role,is_qa_admin FROM members WHERE id='qa-manager'").get()).toEqual({role:'member',is_qa_admin:1});
  });
  it('fails closed before altering members when member tenancy is incomplete', async () => {
    db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE tasks(workspace_id TEXT); CREATE TABLE members(id TEXT PRIMARY KEY);');
    await expect(applyPostTenantSchemaUpgrades(adapter())).rejects.toThrow('completed tenancy');
    expect(db.prepare('PRAGMA table_info(members)').all()).toHaveLength(1);
  });
});
