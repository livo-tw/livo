// @vitest-environment node
// Runs the real migrate/apply-tenant-alters.mjs against native SQLite through a
// fake `npx wrangler d1 execute` (child_process.execSync stub). Synthetic data only.
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sqlTriggerTargets } from '../../worker/migrate/schema-upgrades.mjs';

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../worker');
const schema = readFileSync(path.join(WORKER, 'schema.sql'), 'utf8');
const PREFIX = 'livo-d1-upgrade-order-';
let temp, dbFile, stub;

const STUB = `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.LIVO_FAKE_D1);
const fail = message => { const error = new Error(message); error.stdout = ''; error.stderr = message; throw error; };
cp.execSync = command => {
  const prefix = 'npx wrangler d1 execute livo-db --local -y ';
  if (!command.startsWith(prefix)) fail('unexpected command: ' + command);
  const args = command.slice(prefix.length), file = args.match(/^--file="([^"]+)"$/), sql = args.match(/^--command "([^"]*)"( --json)?$/);
  try {
    if (file) { db.exec(readFileSync(file[1], 'utf8')); return ''; }
    if (!sql) fail('unparsed arguments: ' + args);
    const rows = db.prepare(sql[1]).all();
    return sql[2] ? JSON.stringify([{ results: rows, success: true }]) : '';
  } catch (error) { fail(String(error && error.message)); }
};
syncBuiltinESMExports();
`;

const alters = () => execFileSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(stub).href, path.join(WORKER, 'migrate', 'apply-tenant-alters.mjs'), '--local'],
  { cwd: WORKER, encoding: 'utf8', stdio: 'pipe', env: { PATH: process.env.PATH, LIVO_FAKE_D1: dbFile } });
const open = () => new DatabaseSync(dbFile);
const names = (db, type, like) => db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name LIKE ? ORDER BY name').all(type, like).map(r => r.name);
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

beforeEach(() => {
  temp = mkdtempSync(path.join(tmpdir(), PREFIX));
  dbFile = path.join(temp, 'd1.sqlite');
  stub = path.join(temp, 'fake-wrangler.mjs');
  writeFileSync(stub, STUB);
});
afterEach(() => {
  if (!path.resolve(temp).startsWith(path.resolve(tmpdir()) + path.sep + PREFIX)) throw new Error('Unsafe test cleanup target');
  rmSync(temp, { recursive: true, force: true });
});

describe('D1 upgrade order', () => {
  it('upgrades a database that has the knowledge base but predates QA, repeatably', () => {
    const db = open();
    try {
      db.exec(schema);
      // An older deployment: knowledge base present, QA tables never created,
      // login reservations without the per-source columns.
      const qaTables = names(db, 'table', 'qa_%').filter(n => n.startsWith('qa_'));
      for (const table of qaTables) db.exec(`DROP TABLE ${table}`);
      // Guards added together with QA (on other tables) did not exist either.
      for (const { name, sql } of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all())
        if (qaTables.some(table => new RegExp(`\\b${table}\\b`).test(sql))) db.exec(`DROP TRIGGER ${name}`);
      db.exec('DROP INDEX idx_auth_login_reservations_pair; ALTER TABLE auth_login_reservations DROP COLUMN pair_window; ALTER TABLE auth_login_reservations DROP COLUMN pair_key;');
      db.exec("INSERT INTO kb_pages(workspace_id,id,title,body,created_by,updated_by) VALUES('a','page','Kept','Synthetic body','m','m')");
      expect(names(db, 'table', 'qa_issues')).toEqual([]);
    } finally { db.close(); }

    for (let run = 0; run < 2; run++) {
      const output = alters();
      expect(output).toContain('[knowledge-work] deferred to schema.sql');
    }
    const after = open();
    try {
      expect(columns(after, 'auth_login_reservations')).toEqual(expect.arrayContaining(['pair_key', 'pair_window']));
      expect(after.prepare("SELECT title FROM kb_pages WHERE id='page'").get()).toEqual({ title: 'Kept' });
      after.exec(schema); // CI and start-livo.bat apply schema.sql right after the alters.
      expect(names(after, 'table', 'qa_issues')).toEqual(['qa_issues']);
      expect(names(after, 'trigger', 'kb_clock_qa_%')).toHaveLength(6);
      expect(names(after, 'index', 'idx_auth_login_reservations_pair')).toHaveLength(1);
    } finally { after.close(); }

    // Once QA exists the knowledge-work guards are (re)applied by the alters step itself.
    const output = alters();
    expect(output).not.toContain('[knowledge-work] deferred');
    const final = open();
    try {
      expect(final.prepare("SELECT title FROM kb_pages WHERE id='page'").get()).toEqual({ title: 'Kept' });
      expect(names(final, 'trigger', 'kb_clock_qa_%')).toHaveLength(6);
    } finally { final.close(); }
  }, 60_000);

  it('upgrades a current database without deferring anything', () => {
    const db = open();
    try { db.exec(schema); } finally { db.close(); }
    expect(alters()).not.toContain('deferred');
    expect(alters()).not.toContain('deferred');
  }, 60_000);

  it('adds invitation email trust and manual Slack issuer columns to an already-tenanted database without changing legacy rows', () => {
    const db = open();
    try {
      db.exec(schema);
      db.exec("ALTER TABLE members DROP COLUMN email_identity_verified; ALTER TABLE external_account_bindings DROP COLUMN verified_by_member_id; ALTER TABLE external_account_bindings DROP COLUMN reconfirm_required;");
      db.exec("INSERT INTO members(workspace_id,id,name,avatar,email,role) VALUES('a','legacy-member','Example Legacy','','legacy@example.com','member'); INSERT INTO external_account_bindings(workspace_id,id,member_id,platform,platform_user_id,is_verified,verified_by) VALUES('a','legacy-binding','legacy-member','slack','U_EXAMPLE',1,'admin');");
    } finally { db.close(); }
    alters(); alters();
    const after = open();
    try {
      expect(after.prepare("SELECT name,email,email_identity_verified FROM members WHERE id='legacy-member'").get()).toEqual({ name: 'Example Legacy', email: 'legacy@example.com', email_identity_verified: 1 });
      expect(after.prepare("SELECT is_verified,verified_by,verified_by_member_id,reconfirm_required FROM external_account_bindings WHERE id='legacy-binding'").get()).toEqual({ is_verified: 1, verified_by: 'admin', verified_by_member_id: null, reconfirm_required: 0 });
      expect(() => after.exec("UPDATE members SET email_identity_verified=2 WHERE id='legacy-member'")).toThrow();
      expect(() => after.exec("UPDATE external_account_bindings SET reconfirm_required=2 WHERE id='legacy-binding'")).toThrow();
      after.exec(schema);
      expect(after.prepare("SELECT email_identity_verified FROM members WHERE id='legacy-member'").get()).toEqual({ email_identity_verified: 1 });
    } finally { after.close(); }
  }, 60_000);

  it('derives every pre-existing table the knowledge-work guards attach to', () => {
    const targets = sqlTriggerTargets(readFileSync(path.join(WORKER, 'migrate', 'knowledge-work.sql'), 'utf8'));
    expect(targets).toEqual(expect.arrayContaining(['qa_issues', 'qa_attachments', 'kb_pages', 'members', 'task_planning_import_guard']));
    expect(targets).not.toContain('kb_publications'); // created by the same file
    expect(sqlTriggerTargets('CREATE TRIGGER IF NOT EXISTS g BEFORE UPDATE OF title, body ON kb_pages BEGIN SELECT 1; END;')).toEqual(['kb_pages']);
  });
});
