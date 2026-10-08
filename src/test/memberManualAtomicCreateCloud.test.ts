// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type Reply = { status: number; body: { success?: boolean; error?: string; code?: string; message?: string; memberId?: string } };
type Hook = { match: RegExp; run: () => Promise<void> };
type Connection = {
  beforeNextStatement: Hook | null;
  afterNextStatement: Hook | null;
  observeStatement: ((event: { sql: string; args: unknown[]; batch: boolean; results: Row[] }) => void) | null;
  row: (sql: string, ...args: unknown[]) => Row | null;
  rows: (sql: string, ...args: unknown[]) => Row[];
  exec: (sql: string) => void;
  call: (body: Row, endpoint?: string) => Promise<Reply>;
};
type Fixture = { a: Connection; b: Connection; notifications: unknown[]; close: () => void };
const fixtureModulePath = '../../scripts/lib/member-manual-atomic-d1-fixture.mjs';
const { createManualAtomicFixture } = await import(fixtureModulePath) as { createManualAtomicFixture: () => Promise<Fixture> };
let fixture: Fixture;
const email = 'atomic-new@example.com';
const create = (connection: Connection, overrides: Row = {}) => connection.call({
  action: 'create', name: 'Synthetic New Member', email, password: 'synthetic-member-password', ...overrides,
});
const auth = (connection: Connection, address = email) => connection.row('SELECT * FROM auth_users WHERE email=? COLLATE NOCASE', address);
const member = (connection: Connection, address = email) => connection.row('SELECT * FROM members WHERE email=? COLLATE NOCASE', address);
const noOrphans = () => {
  expect(fixture.b.rows('SELECT m.id FROM members m LEFT JOIN auth_users a ON a.id=m.auth_id WHERE m.auth_id IS NOT NULL AND a.id IS NULL')).toEqual([]);
  expect(fixture.b.rows('SELECT a.id FROM auth_users a LEFT JOIN members m ON m.auth_id=a.id WHERE m.id IS NULL')).toEqual([]);
};
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const seedExistingAuth = (banned = 0) => fixture.b.exec(`
  INSERT INTO auth_users(id,email,password_hash,banned,created_at)
    VALUES('existing-unlinked','${email}','preserve-original-password-hash',${banned},'2026-01-01T00:00:00Z');
  INSERT INTO auth_refresh_tokens(token_hash,user_id,expires_at)
    VALUES('preserve-existing-session','existing-unlinked','2099-01-01T00:00:00Z');`);

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network is forbidden in the isolated manual member test'); }));
  fixture = await createManualAtomicFixture();
});
afterEach(() => { fixture?.close(); vi.unstubAllGlobals(); });

describe('manual member creation across two native SQLite connections', () => {
  it('exposes neither row to the second connection between auth and member writes', async () => {
    const observations: Array<{ auth: Row | null; member: Row | null; batch: boolean }> = [];
    fixture.a.observeStatement = event => {
      if (/INSERT INTO (auth_users|members)\b/i.test(event.sql)) {
        observations.push({ auth: auth(fixture.b), member: member(fixture.b), batch: event.batch });
      }
    };
    expect(await create(fixture.a)).toMatchObject({ status: 200, body: { success: true } });
    expect(observations).toHaveLength(2);
    expect(observations).toEqual([{ auth: null, member: null, batch: true }, { auth: null, member: null, batch: true }]);
    expect(member(fixture.b)?.auth_id).toBe(auth(fixture.b)?.id);
    noOrphans();
  });

  it('rolls back a fresh auth when the last seat disappears after quota preflight', async () => {
    fixture.a.beforeNextStatement = { match: /INSERT INTO members\b/i, run: async () => {
      fixture.b.exec("UPDATE workspaces SET member_limit=1 WHERE id='a'");
    } };
    expect(await create(fixture.a)).toMatchObject({ status: 403, body: { error: 'member_limit', code: 'member_limit' } });
    expect(auth(fixture.a)).toBeNull(); expect(auth(fixture.b)).toBeNull();
    expect(member(fixture.a)).toBeNull(); expect(member(fixture.b)).toBeNull();
    expect(fixture.notifications).toHaveLength(0);
    noOrphans();
  });

  it('keeps an overlapping other workspace from adopting auth belonging to a rolled-back request', async () => {
    let provisionalId: unknown, second: Promise<Reply> | undefined;
    const observedByB: unknown[] = [];
    fixture.b.observeStatement = event => {
      if (/SELECT id FROM auth_users WHERE email/i.test(event.sql) && event.args[0] === email) observedByB.push(event.results[0]?.id ?? null);
    };
    fixture.a.observeStatement = event => {
      if (/INSERT INTO auth_users\b/i.test(event.sql)) {
        provisionalId = event.args[0];
        second = create(fixture.b, { password: 'synthetic-password-chosen-by-b' });
      }
    };
    // The old implementation yielded after its standalone auth INSERT, letting
    // B adopt it. An atomic batch never yields at this standalone hook.
    fixture.a.afterNextStatement = { match: /INSERT INTO auth_users\b/i, run: async () => { await second; } };
    fixture.a.beforeNextStatement = { match: /INSERT INTO members\b/i, run: async () => {
      fixture.b.exec("UPDATE workspaces SET member_limit=1 WHERE id='a'");
    } };
    expect(await create(fixture.a)).toMatchObject({ status: 403, body: { code: 'member_limit' } });
    expect(second).toBeDefined();
    expect(await second).toMatchObject({ status: 200, body: { success: true } });
    expect(observedByB).toEqual([null]);
    expect(auth(fixture.b)?.id).not.toBe(provisionalId);
    expect(member(fixture.b)).toMatchObject({ workspace_id: 'b', auth_id: auth(fixture.b)?.id });
    expect(await fixture.b.call({ email, password: 'synthetic-password-chosen-by-b' }, '/api/auth/login')).toMatchObject({ status: 200 });
    noOrphans();
  });

  it('prevents a dead reference when B caches provisional auth before A rolls back its quota failure', async () => {
    const bRead = deferred(), aDone = deferred();
    let second: Promise<Reply> | undefined, provisionalId: unknown, capturedAuthId: unknown;
    fixture.b.observeStatement = event => {
      if (/SELECT id FROM auth_users WHERE email/i.test(event.sql) && event.args[0] === email) capturedAuthId = event.results[0]?.id ?? null;
    };
    fixture.b.afterNextStatement = { match: /SELECT id FROM auth_users WHERE email/i, run: async () => {
      bRead.release();
      await aDone.promise;
    } };
    fixture.a.observeStatement = event => {
      if (/INSERT INTO auth_users\b/i.test(event.sql)) {
        provisionalId = event.args[0];
        second = create(fixture.b, { password: 'synthetic-password-chosen-by-b' });
      }
    };
    fixture.a.afterNextStatement = { match: /INSERT INTO auth_users\b/i, run: async () => { await bRead.promise; } };
    fixture.a.beforeNextStatement = { match: /INSERT INTO members\b/i, run: async () => {
      fixture.b.exec("UPDATE workspaces SET member_limit=1 WHERE id='a'");
    } };
    const firstReply = await create(fixture.a).finally(aDone.release);
    const secondReply = await second;
    const deadReferences = fixture.b.rows('SELECT m.id FROM members m LEFT JOIN auth_users a ON a.id=m.auth_id WHERE m.auth_id IS NOT NULL AND a.id IS NULL');
    // Record the concrete historical sequence before assertions: A's quota
    // failure removed auth already cached by B, whose member write succeeded.
    console.info('manual cached-auth race outcome', {
      firstStatus: firstReply.status, firstCode: firstReply.body.code,
      secondStatus: secondReply?.status,
      bReadProvisionalAuth: capturedAuthId === provisionalId,
      deadReferenceCount: deadReferences.length,
    });
    expect(firstReply).toMatchObject({ status: 403, body: { code: 'member_limit' } });
    expect(secondReply).toMatchObject({ status: 200, body: { success: true } });
    expect(deadReferences).toEqual([]);
    expect(capturedAuthId).toBeNull();
    expect(auth(fixture.b)?.id).not.toBe(provisionalId);
    expect(member(fixture.b)?.auth_id).toBe(auth(fixture.b)?.id);
    noOrphans();
  });

  it.each(['a', 'b'])('returns friendly email_taken when two absent preflights race for workspace %s', async workspace => {
    const bRead = deferred(), aDone = deferred();
    // Both native connections target A when the other owner moves into A;
    // workspace scope is still resolved by the real authentication middleware.
    if (workspace === 'a') fixture.b.exec("UPDATE members SET workspace_id='a' WHERE id='manual-owner-b'");
    fixture.a.afterNextStatement = { match: /SELECT id FROM auth_users WHERE email/i, run: async () => { await bRead.promise; } };
    fixture.b.afterNextStatement = { match: /SELECT id FROM auth_users WHERE email/i, run: async () => { bRead.release(); await aDone.promise; } };
    const first = create(fixture.a).finally(aDone.release);
    const second = create(fixture.b);
    const replies = await Promise.all([first, second]);
    expect(replies[0]).toMatchObject({ status: 200, body: { success: true } });
    expect(replies[1]).toMatchObject({ status: 409, body: { error: 'email_taken', message: '此 Email 已被使用' } });
    expect(replies[1].body).not.toHaveProperty('memberId');
    expect(fixture.b.rows('SELECT id FROM auth_users WHERE email=?', email)).toHaveLength(1);
    expect(fixture.b.rows('SELECT id FROM members WHERE email=?', email)).toHaveLength(1);
    expect(fixture.notifications).toHaveLength(1);
    noOrphans();
  });

  it('rolls back its fresh login when a member email is claimed after preflight', async () => {
    fixture.a.beforeNextStatement = { match: /INSERT INTO members\b/i, run: async () => {
      fixture.b.exec(`INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id)
        VALUES('b','foreign-email-claim','Foreign Existing','','${email}','member',NULL)`);
    } };
    expect(await create(fixture.a)).toMatchObject({ status: 409, body: { error: 'email_taken' } });
    expect(auth(fixture.b)).toBeNull();
    expect(member(fixture.b)).toMatchObject({ id: 'foreign-email-claim', workspace_id: 'b', auth_id: null });
    expect(fixture.notifications).toHaveLength(0);
    noOrphans();
  });

  it('rolls back auth and member on a real SQLite fault in the second write', async () => {
    fixture.b.exec(`CREATE TRIGGER synthetic_member_fault BEFORE INSERT ON members
      WHEN NEW.email='${email}' BEGIN SELECT RAISE(ABORT,'synthetic member fault'); END;`);
    expect(await create(fixture.a)).toMatchObject({ status: 400 });
    expect(auth(fixture.b)).toBeNull(); expect(member(fixture.b)).toBeNull();
    expect(fixture.notifications).toHaveLength(0);
    noOrphans();
  });

  it.each([0, 1])('adopts an existing auth while preserving its password, banned=%s and sessions', async banned => {
    seedExistingAuth(banned);
    const before = auth(fixture.b), sessions = fixture.b.rows('SELECT * FROM auth_refresh_tokens');
    expect(await create(fixture.a, { password: 'must-not-reset-existing-password' })).toMatchObject({ status: 200 });
    expect(auth(fixture.b)).toEqual(before);
    expect(member(fixture.b)?.auth_id).toBe('existing-unlinked');
    expect(fixture.b.rows('SELECT * FROM auth_refresh_tokens')).toEqual(sessions);
    noOrphans();
  });

  it('preserves existing auth and sessions after a quota rollback', async () => {
    seedExistingAuth(1);
    const before = auth(fixture.b), sessions = fixture.b.rows('SELECT * FROM auth_refresh_tokens');
    fixture.a.beforeNextStatement = { match: /INSERT INTO members\b/i, run: async () => { fixture.b.exec("UPDATE workspaces SET member_limit=1 WHERE id='a'"); } };
    expect(await create(fixture.a)).toMatchObject({ status: 403, body: { code: 'member_limit' } });
    expect(auth(fixture.b)).toEqual(before); expect(member(fixture.b)).toBeNull();
    expect(fixture.b.rows('SELECT * FROM auth_refresh_tokens')).toEqual(sessions);
  });

  it.each(['delete', 'change_email'])('rejects auth_changed when an existing login is %s before member insert', async mutation => {
    seedExistingAuth();
    fixture.a.beforeNextStatement = { match: /INSERT INTO members\b/i, run: async () => {
      fixture.b.exec(mutation === 'delete'
        ? "DELETE FROM auth_users WHERE id='existing-unlinked'"
        : "UPDATE auth_users SET email='different-address@example.com' WHERE id='existing-unlinked'");
    } };
    expect(await create(fixture.a)).toMatchObject({ status: 409, body: { error: 'auth_changed', message: '登入帳號已變更，請重新新增成員' } });
    expect(member(fixture.b)).toBeNull();
    expect(fixture.b.rows('SELECT m.id FROM members m LEFT JOIN auth_users a ON a.id=m.auth_id WHERE a.id IS NULL')).toEqual([]);
    expect(fixture.notifications).toHaveLength(0);
  });
});
