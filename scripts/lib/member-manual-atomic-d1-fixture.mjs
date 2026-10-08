// Two real SQLite connections share one temporary file. SQL, constraints,
// password hashing, authentication and the member handler are production code.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { clearMemberCache, registerAuthRoutes, requireMember } from '../../worker/src/auth';
import { handleManageMember } from '../../worker/src/functions/manageMember';

const workerRequire = createRequire(new URL('../../worker/package.json', import.meta.url));
const { Hono } = await import(workerRequire.resolve('hono'));
const { sign } = await import(workerRequire.resolve('hono/jwt'));

class Statement {
  constructor(connection, sql, args = []) {
    this.connection = connection;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) { return new Statement(this.connection, this.sql, args); }

  async invokeHook(name) {
    const hook = this.connection[name];
    if (hook?.match.test(this.sql)) {
      this.connection[name] = null;
      await hook.run();
    }
  }

  execute(batch = false) {
    const prepared = this.connection.db.prepare(this.sql);
    const results = prepared.columns().length ? prepared.all(...this.args) : [];
    const result = prepared.columns().length ? null : prepared.run(...this.args);
    const changes = result?.changes ?? this.connection.db.prepare('SELECT changes() AS n').get().n;
    const reply = { results, success: true, meta: { changes: Number(changes) } };
    // Observers are synchronous and can read the other native connection during
    // an open transaction. Requests never yield between statements in a batch.
    this.connection.observeStatement?.({ sql: this.sql, args: this.args, batch, results });
    return reply;
  }

  async run() {
    await this.invokeHook('beforeNextStatement');
    const reply = this.execute();
    await this.invokeHook('afterNextStatement');
    return reply;
  }

  async all() { return this.run(); }

  async first(column) {
    const reply = await this.run();
    const row = reply.results[0] ?? null;
    return column ? row?.[column] ?? null : row;
  }
}

export async function createManualAtomicFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'livo-manual-atomic-'));
  const path = join(directory, 'members.sqlite');
  const first = new DatabaseSync(path);
  first.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000');
  first.exec(readFileSync(new URL('../../worker/schema.sql', import.meta.url), 'utf8'));
  first.exec(`INSERT INTO workspaces(id,name,member_limit,status) VALUES
    ('a','Synthetic Team A',10,'active'),('b','Synthetic Team B',10,'active');
    INSERT INTO auth_users(id,email,password_hash,banned) VALUES
      ('manual-owner-a','owner-a@example.com','synthetic-owner-hash',0),
      ('manual-owner-b','owner-b@example.com','synthetic-owner-hash',0);
    INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id,is_active) VALUES
      ('a','manual-owner-a','Owner A','','owner-a@example.com','super_admin','manual-owner-a',1),
      ('b','manual-owner-b','Owner B','','owner-b@example.com','super_admin','manual-owner-b',1);`);
  const second = new DatabaseSync(path);
  second.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000');
  const notifications = [];
  const makeConnection = async (db, workspace) => {
    const pending = [];
    const connection = {
      db, workspace, beforeNextStatement: null, afterNextStatement: null, observeStatement: null,
      row: (sql, ...args) => db.prepare(sql).get(...args) ?? null,
      rows: (sql, ...args) => db.prepare(sql).all(...args),
      exec: (sql) => db.exec(sql),
      DB: null,
    };
    connection.DB = {
      prepare: (sql) => new Statement(connection, sql),
      batch: async (statements) => {
        // A pre-batch hook lets another connection commit after application
        // preflights, while preserving the batch's actual atomic boundary.
        const hook = connection.beforeNextStatement;
        if (hook && statements.some(statement => hook.match.test(statement.sql))) {
          connection.beforeNextStatement = null;
          await hook.run();
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          const replies = statements.map(statement => statement.execute(true));
          db.exec('COMMIT');
          return replies;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    };
    const env = {
      DB: connection.DB,
      JWT_SECRET: 'synthetic-manual-member-signing-material',
      REALTIME: {
        idFromName: name => name,
        get: scope => ({ fetch: async (_url, init) => {
          notifications.push({ scope, events: JSON.parse(init.body) });
          return new Response(null, { status: 204 });
        } }),
      },
    };
    const context = { waitUntil: promise => pending.push(promise), passThroughOnException: () => {} };
    const app = new Hono();
    registerAuthRoutes(app);
    app.post('/api/functions/manage-member', requireMember, handleManageMember);
    const userId = `manual-owner-${workspace}`;
    const now = Math.floor(Date.now() / 1000);
    const bearer = await sign({ sub: userId, email: `owner-${workspace}@example.com`, iat: now, exp: now + 3600 }, env.JWT_SECRET, 'HS256');
    connection.call = async (body, endpoint = '/api/functions/manage-member') => {
      const response = await app.request(`https://api.example.com${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${bearer}`, 'CF-Connecting-IP': '192.0.2.11' },
        body: JSON.stringify(body),
      }, env, context);
      await Promise.allSettled(pending.splice(0));
      return { status: response.status, body: await response.json() };
    };
    return connection;
  };
  const a = await makeConnection(first, 'a'), b = await makeConnection(second, 'b');
  return {
    a, b, notifications,
    close: () => {
      clearMemberCache('manual-owner-a'); clearMemberCache('manual-owner-b');
      first.close(); second.close(); rmSync(directory, { recursive: true, force: true });
    },
  };
}
