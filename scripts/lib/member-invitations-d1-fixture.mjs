// Native SQLite implements the D1 API against the production schema.
// All identities, transport keys and mail recipients are synthetic.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { handleMemberInvitations } from '../../worker/src/functions/memberInvitations';
import { clearMemberCache, registerAuthRoutes, requireMember, sha256Hex } from '../../worker/src/auth';
import { runQuery } from '../../worker/src/db';
import { handleManageMember } from '../../worker/src/functions/manageMember';
import { handleImportJira } from '../../worker/src/functions/importJira';

const workerRequire = createRequire(new URL('../../worker/package.json', import.meta.url));
const { Hono } = await import(workerRequire.resolve('hono'));
const { sign } = await import(workerRequire.resolve('hono/jwt'));

async function signSyntheticJiraLicense(payload, secret) {
  // Private keys use the first eight lowercase hex chars of HMAC-SHA256.
  // Keep this fixture independent of private-only exports: the OSS edition's
  // normal Professional gate enables Jira import without a license key.
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature).subarray(0, 4), byte => byte.toString(16).padStart(2, '0')).join('');
}

class SqliteStatement {
  constructor(fixture, sql, args = []) {
    this.fixture = fixture;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) { return new SqliteStatement(this.fixture, this.sql, args); }

  async beforeStatement() {
    const hook = this.fixture.beforeNextStatement;
    if (hook?.match.test(this.sql)) {
      this.fixture.beforeNextStatement = null;
      await hook.run();
    }
  }

  async first(column) {
    await this.beforeStatement();
    const row = this.fixture.db.prepare(this.sql).get(...this.args) ?? null;
    return column ? row?.[column] ?? null : row;
  }

  async all() {
    await this.beforeStatement();
    return { results: this.fixture.db.prepare(this.sql).all(...this.args), success: true, meta: { changes: 0 } };
  }

  execute() {
    const statement = this.fixture.db.prepare(this.sql);
    if (statement.columns().length) {
      const results = statement.all(...this.args);
      return { results, success: true, meta: { changes: Number(this.fixture.db.prepare('SELECT changes() AS n').get().n) } };
    }
    const result = statement.run(...this.args);
    return { results: [], success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }

  async run() { await this.beforeStatement(); return this.execute(); }
}

export async function createMemberInvitationsFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const schema = readFileSync(new URL('../../worker/schema.sql', import.meta.url), 'utf8');
  db.exec(schema);
  const notifications = [], pending = [];
  const fixture = {
    db,
    notifications,
    beforeNextBatch: null,
    beforeNextStatement: null,
    DB: {
      prepare: (sql) => new SqliteStatement(fixture, sql),
      batch: async (statements) => {
        const statementHook = fixture.beforeNextStatement;
        if (statementHook && statements.some(statement => statementHook.match.test(statement.sql))) {
          fixture.beforeNextStatement = null;
          await statementHook.run();
        }
        const hook = fixture.beforeNextBatch;
        fixture.beforeNextBatch = null;
        hook?.();
        // Do not yield in the transaction: D1 serializes complete batches.
        db.exec('BEGIN');
        try {
          const results = statements.map(statement => statement.execute());
          db.exec('COMMIT');
          return results;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      exec: async (sql) => { db.exec(sql); return { count: 1, duration: 0 }; },
    },
    count: (table) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n),
    rows: (sql, ...args) => db.prepare(sql).all(...args),
    row: (sql, ...args) => db.prepare(sql).get(...args) ?? null,
    exec: (sql) => db.exec(sql),
    reapplySchema: () => db.exec(schema),
    close: () => {
      for (const id of ['login-owner', 'login-admin', 'login-member', 'login-foreign']) clearMemberCache(id);
      db.close();
    },
  };
  db.exec(`INSERT INTO workspaces(id,name,member_limit,status) VALUES
    ('a','Example Team',10,'active'),('b','Other Team',10,'active');
    INSERT INTO auth_users(id,email,password_hash,banned) VALUES
      ('login-owner','owner@example.com','synthetic-existing-hash',0),
      ('login-admin','admin@example.com','synthetic-existing-hash',0),
      ('login-member','member@example.com','synthetic-existing-hash',0),
      ('login-foreign','foreign@example.com','synthetic-existing-hash',0);
    INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id,is_active) VALUES
      ('a','owner','Example Owner','','owner@example.com','super_admin','login-owner',1),
      ('a','admin','Example Admin','','admin@example.com','admin','login-admin',1),
      ('a','member','Example Member','','member@example.com','member','login-member',1),
      ('b','foreign','Other Owner','','foreign@example.com','super_admin','login-foreign',1);`);
  const env = {
    DB: fixture.DB,
    JWT_SECRET: 'synthetic-jwt-signing-material-only-for-isolated-tests',
    APP_BASE_URL: 'https://app.example.com',
    RESEND_API_KEY: 'synthetic-resend-transport',
    RESEND_FROM_EMAIL: 'team@example.com',
    REALTIME: {
      idFromName: (name) => name,
      get: (workspace) => ({ fetch: async (_url, init) => {
        notifications.push({ workspace, events: JSON.parse(init.body) });
        return new Response(null, { status: 204 });
      } }),
    },
  };
  const context = {
    waitUntil: (promise) => { pending.push(promise); },
    passThroughOnException: () => {},
  };
  const app = new Hono();
  registerAuthRoutes(app);
  app.post('/api/functions/member-invitations', handleMemberInvitations);
  app.post('/api/functions/manage-member', requireMember, handleManageMember);
  app.post('/api/functions/import-jira', requireMember, handleImportJira);
  fixture.env = env;
  fixture.enableJiraImport = async () => {
    // Synthetic signing material exercises the private gate; OSS uses its
    // normal Professional stub. Neither edition's product gate is replaced.
    env.LICENSE_SECRET = 'synthetic-isolated-import-license-signing-material';
    const payload = 'LIVO-PRO-license@example.com-99999999';
    const signature = await signSyntheticJiraLicense(payload, env.LICENSE_SECRET);
    db.prepare('INSERT INTO system_settings(workspace_id,key,value) VALUES(?,?,?) ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value')
      .run('a', 'license', JSON.stringify({ key: `${payload}-${signature}` }));
    db.exec("INSERT OR IGNORE INTO statuses(workspace_id,id,name,is_done) VALUES('a','a-s1','To Do',0)");
  };
  fixture.query = (request) => runQuery(env, context, {
    userId: 'login-owner', email: 'owner@example.com',
    member: { id: 'owner', role: 'super_admin', email: 'owner@example.com', name: 'Example Owner', workspaceId: 'a' },
  }, request);
  fixture.call = async (body, bearer = '', options = {}) => {
    const headers = { 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.10', ...options.headers };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const method = options.method || 'POST';
    const res = await app.request(options.url || 'https://api.example.com/api/functions/member-invitations', {
      method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    }, env, context);
    await Promise.allSettled(pending.splice(0));
    return { status: res.status, body: await res.json(), headers: Object.fromEntries(res.headers) };
  };
  fixture.jwt = async (id = 'owner') => {
    const now = Math.floor(Date.now() / 1000);
    return sign({ sub: `login-${id}`, email: `${id}@example.com`, iat: now, exp: now + 3600 }, env.JWT_SECRET, 'HS256');
  };
  fixture.pat = async (id = 'owner') => {
    const token = `livo_pat_synthetic-${id}-personal-api-key`;
    const workspace = id === 'foreign' ? 'b' : 'a';
    db.prepare('INSERT INTO api_tokens(workspace_id,id,member_id,name,token_hash,created_by) VALUES(?,?,?,?,?,?)')
      .run(workspace, `pat-${id}`, id, 'Synthetic key', await sha256Hex(token), id);
    return token;
  };
  return fixture;
}
