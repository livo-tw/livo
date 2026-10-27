import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { AuthCtx, Env } from '../src/env';

/** Real D1 schema, synthetic identities, and a minimal native SQLite D1 adapter. */
export function backendAccessFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO workspaces(id,name) VALUES('access-a','Example A'),('access-b','Example B');
    INSERT INTO auth_users(id,email,banned) VALUES
      ('login-member','member@example.com',0),('login-admin','admin@example.com',0),
      ('login-super','super@example.com',0),('login-other','other@example.com',0),('login-foreign','foreign@example.com',0);
    INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id,is_active) VALUES
      ('access-a','member','Example member','','member@example.com','member','login-member',1),
      ('access-a','admin','Example admin','','admin@example.com','admin','login-admin',1),
      ('access-a','super','Example owner','','super@example.com','super_admin','login-super',1),
      ('access-a','other','Example colleague','','other@example.com','member','login-other',1),
      ('access-b','foreign','Example foreign member','','foreign@example.com','member','login-foreign',1);
    INSERT INTO notifications(workspace_id,id,recipient_id,sender_id,type,content) VALUES
      ('access-a','notice-member','member','other','mention','Example member notice'),
      ('access-a','notice-admin','admin','other','mention','Example admin notice'),
      ('access-a','notice-super','super','other','mention','Example owner notice'),
      ('access-a','notice-other','other','member','mention','Example colleague notice'),
      ('access-b','notice-foreign','foreign','foreign','mention','Example foreign notice');`);
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...params: unknown[]) => statement(sql, params),
    all: async () => ({ results: db.prepare(sql).all(...args as never[]), success: true }),
    first: async () => db.prepare(sql).get(...args as never[]) ?? null,
  });
  const env = { DB: { prepare: (sql: string) => statement(sql) } } as unknown as Env;
  const auth = (id: string, role: string = id === 'super' ? 'super_admin' : id === 'admin' ? 'admin' : 'member'): AuthCtx => ({
    userId: `login-${id}`, email: `${id}@example.com`,
    member: { id, role, email: `${id}@example.com`, name: `Example ${id}`, workspaceId: id === 'foreign' ? 'access-b' : 'access-a' },
  });
  return { db, env, auth };
}
