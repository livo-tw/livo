// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { applyPostTenantSchemaUpgrades } from '../migrate/schema-upgrades.mjs';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrate/deployment-environments.sql', import.meta.url), 'utf8');
const defaults = ['Dev', 'QA', 'Stage', 'Live Staging', 'Prod'];

describe('shared deployment environments in real SQLite', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(schema);
    for (const ws of ['a', 'b']) {
      db.prepare('INSERT INTO auth_users(id,email) VALUES(?,?)').run(`auth-${ws}`, `${ws}@example.com`);
      db.prepare('INSERT INTO product_lines(workspace_id,id,name) VALUES(?,?,?)').run(ws, `line-${ws}`, 'Example line');
      db.prepare('INSERT INTO projects(workspace_id,id,line_id,name,key) VALUES(?,?,?,?,?)').run(ws, `project-${ws}`, `line-${ws}`, 'Example project', ws);
      db.prepare('INSERT INTO members(workspace_id,id,name,avatar,role,email,auth_id) VALUES(?,?,?,?,?,?,?)').run(ws, `member-${ws}`, 'Example member', '', 'admin', `${ws}@example.com`, `auth-${ws}`);
      db.prepare('INSERT INTO statuses(workspace_id,id,name) VALUES(?,?,?)').run(ws, `status-${ws}`, 'Open');
      db.prepare('INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id) VALUES(?,?,?,?,?,?,?)')
        .run(ws, `task-${ws}`, `${ws}-1`, `project-${ws}`, 'Example task', `status-${ws}`, `member-${ws}`);
      db.prepare('INSERT INTO system_settings(workspace_id,key,value) VALUES(?,?,?)').run(ws, 'feature_toggles', '{"qa":true}');
    }
  });
  afterEach(() => db.close());
  function setting(value: unknown, ws = 'a') {
    db.prepare("INSERT INTO system_settings(workspace_id,key,value) VALUES(?,'deployment_environments',?) ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value")
      .run(ws, JSON.stringify(value));
  }
  const set = (values: string[], ws = 'a') => setting({ version: 1, values }, ws);
  function insert(environment: string, id = 'deployment', ws = 'a') {
    db.prepare('INSERT INTO task_deployments(workspace_id,id,task_id,environment) VALUES(?,?,?,?)').run(ws, id, `task-${ws}`, environment);
  }
  function issue(environment = 'QA', version = 1, extra = {}) {
    return { id: 'issue', workspaceId: 'a', projectId: 'project-a', state: 'new', version,
      title: 'Example issue', reporterId: 'member-a', assigneeId: null, qaOwnerId: null,
      taskIds: [], targets: [], observedEnvironment: environment, ...extra };
  }
  function putIssue(environment = 'QA') {
    db.prepare('INSERT INTO qa_issues(workspace_id,id,project_id,state,reporter_id,title,version,updated_at,data) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('a', 'issue', 'project-a', 'new', 'member-a', 'Example issue', 1, 'now', JSON.stringify(issue(environment)));
  }
  function claim(id: string, operation: string, expected: number, data = issue('QA', expected + 1), restoredBy: string | null = null, authId: string | null = 'auth-a') {
    db.prepare('INSERT INTO qa_commands(workspace_id,id,issue_id,actor_id,actor_role,actor_auth_id,expected_version,operation,request_hash,issue_data,result_json,created_at,restored_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('a', id, 'issue', 'member-a', 'admin', authId, expected, operation, 'hash', JSON.stringify(data), JSON.stringify(data), 'now', restoredBy);
  }
  it('accepts defaults before configuration and supports ordered custom values per workspace', () => {
    defaults.forEach((value, i) => insert(value, `default-${i}`));
    set(['Preview', 'Canary']);
    insert('Preview', 'preview');
    expect(() => insert('QA', 'retired')).toThrow('deployment_environment_unavailable');
    insert('QA', 'tenant-b-default', 'b');
    expect(() => insert('Preview', 'tenant-b-private', 'b')).toThrow('deployment_environment_unavailable');
    set(['B only'], 'b');
    insert('B only', 'tenant-b-custom', 'b');
    expect(() => insert('B only', 'tenant-a-private')).toThrow('deployment_environment_unavailable');
    expect(db.prepare("SELECT json_extract(value,'$.values') AS choices FROM livo_deployment_environment_settings_valid WHERE workspace_id='a'").get()?.choices)
      .toBe('["Preview","Canary"]');
  });
  it.each([
    null, [], {}, { version: '1', values: ['QA'] }, { version: 2, values: ['QA'] },
    { version: 1, values: [] }, { version: 1, values: 'QA' }, { version: 1, values: [null] },
    { version: 1, values: ['QA', 'QA'] }, { version: 1, values: [' QA'] },
    { version: 1, values: ['QA\u3000'] }, { version: 1, values: ['QA\ufeff'] },
    { version: 1, values: ['Q\nA'] }, { version: 1, values: ['Q\u007fA'] },
    { version: 1, values: ['Q\0A'] }, { version: 1, values: [''] },
    { version: 1, values: ['x'.repeat(121)] }, { version: 1, values: Array.from({ length: 31 }, (_, i) => String(i)) },
    { version: 1, values: ['QA'], extra: true },
  ])('rejects malformed catalog %j without replacing a valid catalog', invalid => {
    set(['QA']);
    expect(() => setting(invalid)).toThrow('invalid_deployment_environments');
    insert('QA');
    expect(db.prepare("SELECT value FROM system_settings WHERE workspace_id='a' AND key='deployment_environments'").get()?.value)
      .toBe('{"version":1,"values":["QA"]}');
  });
  it('uses 120 Unicode characters, case-sensitive uniqueness and a 30-item maximum', () => {
    set(['QA', 'qa', '😀'.repeat(120)]);
    insert('😀'.repeat(120));
    set(Array.from({ length: 30 }, (_, i) => String(i)));
    insert('29', 'last');
    expect(() => set(['😀'.repeat(121)])).toThrow('invalid_deployment_environments');
  });
  it('rejects key or workspace renames while permitting an unrelated setting', () => {
    set(['QA']);
    expect(() => db.exec("UPDATE system_settings SET key='renamed' WHERE workspace_id='a' AND key='deployment_environments'"))
      .toThrow('deployment_environment_setting_key_immutable');
    expect(() => db.exec("UPDATE system_settings SET workspace_id='other' WHERE workspace_id='a' AND key='deployment_environments'"))
      .toThrow('deployment_environment_setting_key_immutable');
    db.exec("INSERT INTO system_settings(workspace_id,key,value) VALUES('a','unrelated','not JSON')");
  });
  it('fails closed if an invalid setting predates installation of the guard', () => {
    db.exec('DROP TRIGGER deployment_environment_setting_insert');
    db.exec("INSERT INTO system_settings(workspace_id,key,value) VALUES('a','deployment_environments','bad JSON')");
    db.exec(schema);
    expect(() => insert('QA')).toThrow('deployment_environment_unavailable');
    expect(() => insert('Preview')).toThrow('deployment_environment_unavailable');
    insert('QA', 'other-tenant', 'b');
  });
  it('keeps retired values on their original row while rejecting reuse, moves and replacements', () => {
    insert('Dev');
    set(['QA']);
    db.exec("UPDATE task_deployments SET status='deployed',deploy_date='2026-10-06' WHERE workspace_id='a' AND id='deployment'");
    expect(db.prepare("SELECT environment,status,deploy_date FROM task_deployments WHERE workspace_id='a' AND id='deployment'").get())
      .toMatchObject({ environment: 'Dev', status: 'deployed', deploy_date: '2026-10-06' });
    for (const change of ["id='different'", "task_id='task-b'", "workspace_id='b'", "environment='Unknown'"]) {
      // Configure both tenants without Dev so a scope change cannot select it.
      set(['QA'], 'b');
      expect(() => db.exec(`UPDATE task_deployments SET ${change} WHERE id='deployment'`)).toThrow('deployment_environment_unavailable');
    }
    expect(() => insert('Dev', 'new-row')).toThrow('deployment_environment_unavailable');
    db.exec("UPDATE task_deployments SET environment='QA' WHERE workspace_id='a' AND id='deployment'");
  });
  it('rejects a now-retired QA observation atomically before the command receipt', () => {
    const prepared = issue('QA');
    set(['Preview']);
    expect(() => claim('create-stale', 'create', -1, prepared)).toThrow('qa_invalid_environment');
    expect(db.prepare('SELECT count(*) n FROM qa_commands').get()?.n).toBe(0);
    claim('create-current', 'create', -1, issue('Preview'));
  });
  it.each(['missing', 'foreign', 'banned', 'inactive'] as const)('rejects %s QA identity even for a valid environment', kind => {
    set(['Preview']);
    if (kind === 'banned') db.exec("UPDATE auth_users SET banned=1 WHERE id='auth-a'");
    if (kind === 'inactive') db.exec("UPDATE members SET is_active=0 WHERE id='member-a'");
    const authId = kind === 'missing' ? null : kind === 'foreign' ? 'auth-b' : 'auth-a';
    expect(() => claim('denied', 'create', -1, issue('Preview'), null, authId)).toThrow('qa_forbidden');
    expect(db.prepare('SELECT count(*) n FROM qa_commands').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM qa_issues').get()?.n).toBe(0);
  });
  it('allows a QA edit retaining its historical observation and rejects a newly inactive value', () => {
    putIssue(); set(['Preview']);
    claim('retained', 'edit', 1);
    expect(() => claim('changed-retired', 'edit', 1, issue('Dev', 2))).toThrow('qa_invalid_environment');
    claim('changed-active', 'edit', 1, issue('Preview', 2));
    claim('comment', 'comment', 1);
  });
  it('checks every fix target against the current workspace list without blocking restore', () => {
    putIssue(); set(['Preview']); set(['Foreign'], 'b');
    for (const targets of [[{ environment: 'QA' }], [{ environment: 'Foreign' }], [{}], ['invalid'], null]) {
      expect(() => claim('invalid-target', 'submit_fix', 1, issue('QA', 2, { targets }))).toThrow('qa_invalid_environment');
    }
    claim('active-target', 'submit_fix', 1, issue('QA', 2, { targets: [{ environment: 'Preview' }] }));
    db.exec("UPDATE members SET role='super_admin' WHERE workspace_id='a' AND id='member-a'");
    claim('restored', 'submit_fix', 1, issue('Legacy', 2, { targets: [{ environment: 'Historical target' }] }), 'member-a');
  });
});

describe('D1 deployment schema upgrade probes', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    // Exercise the real sibling tables/probes too: only planning columns and
    // the deployment environment CHECK are rolled back to their legacy form.
    const legacySchema = schema.slice(0, schema.indexOf('-- Atomic approval commands.'))
      .replace(/^  due_date_(kind|version|change_reason|changed_by) .*\r?\n/gm, '')
      .replace('  environment TEXT NOT NULL,', "  environment TEXT NOT NULL CHECK (environment IN ('Dev','QA','Stage','Live Staging','Prod')),");
    db.exec(legacySchema);
    for (const ws of ['a', 'b']) {
      db.prepare('INSERT INTO product_lines(workspace_id,id,name) VALUES(?,?,?)').run(ws, `line-${ws}`, 'Example line');
      db.prepare('INSERT INTO projects(workspace_id,id,line_id,name,key) VALUES(?,?,?,?,?)').run(ws, `project-${ws}`, `line-${ws}`, 'Example project', ws);
      db.prepare('INSERT INTO members(workspace_id,id,name,avatar,role,email) VALUES(?,?,?,?,?,?)').run(ws, `member-${ws}`, 'Example member', '', 'admin', `${ws}@example.com`);
      db.prepare('INSERT INTO statuses(workspace_id,id,name) VALUES(?,?,?)').run(ws, `status-${ws}`, 'Open');
      db.prepare('INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id) VALUES(?,?,?,?,?,?,?)')
        .run(ws, `task-${ws}`, `${ws}-1`, `project-${ws}`, 'Example task', `status-${ws}`, `member-${ws}`);
    }
    db.exec("INSERT INTO task_deployments VALUES('a','old-a','task-a','Dev','deployed','2026-01-01'),('b','old-b','task-b','QA','scheduled',NULL)");
  });
  afterEach(() => db.close());
  const rows = () => db.prepare('SELECT * FROM task_deployments ORDER BY id').all();
  function adapter() {
    return {
      queryRows: (sql: string) => db.prepare(sql).all(),
      applyFile: (name: string) => {
        expect(['deployment-environments.sql','approval-commands.sql','task-reminder-alters.sql','task-reminder-preferences.sql','task-work-commands.sql','qa-coordination.sql','knowledge-work.sql','release-workspace.sql']).toContain(name);
        db.exec('BEGIN');
        try { db.exec(readFileSync(new URL(`../migrate/${name}`,import.meta.url),'utf8')); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    };
  }
  it('upgrades all rows unchanged, retains FK/index/status checks and safely skips reruns', async () => {
    const before = rows();
    expect(await applyPostTenantSchemaUpgrades(adapter())).toEqual(['deployment-environments.sql','approval-commands.sql','task-reminder-alters.sql','task-reminder-preferences.sql','task-work-commands.sql','qa-coordination.sql','knowledge-work.sql','release-workspace.sql']);
    expect(rows()).toEqual(before);
    expect(await applyPostTenantSchemaUpgrades(adapter())).toEqual(['approval-commands.sql','task-reminder-preferences.sql','task-work-commands.sql','qa-coordination.sql','knowledge-work.sql','release-workspace.sql']);
    expect(db.prepare('PRAGMA table_info(tasks)').all().map(column=>column.name)).toEqual(expect.arrayContaining(['due_date_kind','due_date_version','due_date_change_reason','due_date_changed_by']));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_work_receipts'").get()).toBeTruthy();
    db.exec("INSERT INTO task_deployments VALUES('a','custom','task-a','Canary','scheduled',NULL)");
    expect(() => db.exec("INSERT INTO task_deployments VALUES('a','invalid','task-a','Canary','invalid',NULL)")).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO task_deployments VALUES('a','missing','absent','Canary','scheduled',NULL)")).toThrow(/FOREIGN KEY/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_task_deployments_task'").get()).toBeTruthy();
  });
  it('refuses an incomplete tenancy or unexpected extra columns before changing data', async () => {
    db.exec('ALTER TABLE task_deployments ADD COLUMN future_data TEXT');
    const before = rows();
    await expect(applyPostTenantSchemaUpgrades(adapter())).rejects.toThrow('Unexpected task_deployments columns');
    expect(rows()).toEqual(before);
    db.close(); db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY)');
    await expect(applyPostTenantSchemaUpgrades(adapter())).rejects.toThrow('completed tenancy');
  });
  it('rolls back a failed rebuild without leaving a staging table or losing rows', () => {
    const before = rows();
    db.exec('BEGIN');
    expect(() => db.exec(migration.replace('RENAME TO task_deployments;', 'RENAME TO tasks;'))).toThrow();
    db.exec('ROLLBACK');
    expect(rows()).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='task_deployments_environment_upgrade'").get()).toBeUndefined();
  });
});
