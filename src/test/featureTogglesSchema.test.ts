// @vitest-environment node
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../../worker/schema.sql', import.meta.url), 'utf8');
const boundary = schema.indexOf('-- Feature switches:');
// These are pre-command upgrade fixtures. Full current schema authorization,
// atomic decisions and OFF/withdrawal behavior are covered by the native
// scripts/lib/approval-command-d1.test.mjs suite with all command guards active.
const legacyFeatureSchema = schema.slice(0,schema.indexOf('-- Atomic approval commands.'));
const databases: DatabaseSync[] = [];
function database(withFeatures = true) {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(withFeatures ? legacyFeatureSchema : legacyFeatureSchema.slice(0, boundary));
  // These fixtures exercise switch guards independently of unrelated foreign keys.
  db.exec('PRAGMA foreign_keys = OFF');
  return db;
}
function task(db: DatabaseSync, ws = 'default') {
  db.prepare(`INSERT INTO tasks (workspace_id,id,task_key,project_id,title,status_id,creator_id)
    VALUES (?,?,'EX-1','example-project','Example task','todo','example-member')`).run(ws, `${ws}-task`);
}
function setting(db: DatabaseSync, enabled: boolean, ws = 'default') {
  db.prepare(`INSERT INTO system_settings (workspace_id,key,value) VALUES (?,'feature_toggles',?)
    ON CONFLICT(workspace_id,key) DO UPDATE SET value = excluded.value`).run(ws, JSON.stringify({ approvals: enabled }));
}
function request(db: DatabaseSync, ws = 'default', status = 'pending') {
  db.prepare(`INSERT INTO approval_requests (workspace_id,id,task_id,requested_by,from_status,to_status,status)
    VALUES (?,?,?,'example-member','todo','done',?)`).run(ws, `${ws}-request`, `${ws}-task`, status);
}
function link(db: DatabaseSync, ws = 'default') {
  db.prepare(`UPDATE tasks SET approval_status='pending_approval',current_approval_id=?
    WHERE workspace_id=? AND id=?`).run(`${ws}-request`, ws, `${ws}-task`);
}
afterEach(() => { databases.splice(0).forEach(db => db.close()); });

describe('D1 legacy feature switch compatibility', () => {
  it('seeds fresh installs OFF and tolerates repeated schema application', () => {
    const db = database();
    db.exec(legacyFeatureSchema);
    expect(db.prepare("SELECT value FROM system_settings WHERE workspace_id='default' AND key='feature_toggles'").get())
      .toMatchObject({ value: '{"approvals":false}' });
  });
  it.each(['pending', 'approved', 'cancelled'])('preserves legacy installs with %s request history', status => {
    const db = database(false);
    task(db); request(db, 'default', status);
    db.exec(legacyFeatureSchema.slice(boundary));
    const value = db.prepare("SELECT value FROM system_settings WHERE workspace_id='default' AND key='feature_toggles'").get();
    expect(value).toMatchObject({ value: '{"approvals":true}' });
  });
  it('preserves inactive legacy rules and explicit OFF across reruns', () => {
    const db = database(false);
    db.exec("INSERT INTO approval_rules (id,from_status,to_status,is_active,created_by) VALUES ('rule-1','todo','done',0,'example-member')");
    db.exec(legacyFeatureSchema.slice(boundary));
    expect(db.prepare("SELECT value FROM system_settings WHERE workspace_id='default' AND key='feature_toggles'").get()).toMatchObject({ value: '{"approvals":true}' });
    setting(db, false); db.exec(legacyFeatureSchema);
    expect(db.prepare("SELECT value FROM system_settings WHERE workspace_id='default' AND key='feature_toggles'").get()).toMatchObject({ value: '{"approvals":false}' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM approval_rules').get()).toMatchObject({ count: 1 });
  });
  it('refuses new requests and task pending markers while OFF', () => {
    const db = database(); task(db);
    expect(() => request(db)).toThrow('disabled');
    expect(() => link(db)).toThrow('no longer pending');
  });
  it('refuses OFF while pending, cancels atomically, then permits OFF', () => {
    const db = database(); task(db); setting(db, true); request(db); link(db);
    expect(() => setting(db, false)).toThrow('Withdraw pending');
    db.exec("UPDATE approval_requests SET status='cancelled' WHERE workspace_id='default' AND id='default-request'");
    expect(db.prepare("SELECT approval_status,current_approval_id FROM tasks WHERE id='default-task'").get())
      .toMatchObject({ approval_status: null, current_approval_id: null });
    setting(db, false);
    expect(() => link(db)).toThrow('no longer pending');
    expect(db.prepare('SELECT status FROM approval_requests').get()).toMatchObject({ status: 'cancelled' });
    setting(db, true);
    expect(db.prepare('SELECT status FROM approval_requests').get()).toMatchObject({ status: 'cancelled' });
  });
  it('protects orphaned task markers and requests that arrive during confirmation', () => {
    const db = database(); task(db); setting(db, true); request(db);
    expect(() => setting(db, false)).toThrow('Withdraw pending');
    db.exec("UPDATE approval_requests SET status='cancelled' WHERE id='default-request'");
    db.exec("UPDATE tasks SET current_approval_id='legacy-missing-request' WHERE id='default-task'");
    expect(() => setting(db, false)).toThrow('Withdraw pending');
  });
  it('isolates workspace defaults, pending checks and cancellation', () => {
    const db = database();
    for (const ws of ['alpha', 'beta']) { task(db, ws); setting(db, true, ws); request(db, ws); link(db, ws); }
    db.exec("UPDATE approval_requests SET status='cancelled' WHERE workspace_id='alpha' AND id='alpha-request'");
    setting(db, false, 'alpha');
    expect(db.prepare("SELECT approval_status FROM tasks WHERE workspace_id='beta'").get()).toMatchObject({ approval_status: 'pending_approval' });
    expect(() => setting(db, false, 'beta')).toThrow('Withdraw pending');
    expect(() => request(db, 'new-workspace')).toThrow('disabled');
  });
  it('drops approval notifications while OFF and keeps other notifications', () => {
    const db = database();
    const insert = (id: string, type: string) => db.prepare("INSERT INTO notifications(id,recipient_id,sender_id,type) VALUES (?,'recipient','sender',?)").run(id, type);
    insert('notification-1', 'approval_requested');
    insert('notification-2', 'status_changed');
    expect(db.prepare('SELECT COUNT(*) AS count FROM notifications').get()).toMatchObject({ count: 1 });
    setting(db, true);
    insert('notification-3', 'approval_completed');
    expect(db.prepare('SELECT COUNT(*) AS count FROM notifications').get()).toMatchObject({ count: 2 });
  });
});
