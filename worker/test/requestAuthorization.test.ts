// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { requireMember } from '../src/auth';
import { runQuery } from '../src/db';
import type { AppContext } from '../src/env';
import type { QueryRequest } from '../src/protocol';
import { backendAccessFixture } from './backendAccessFixture';

vi.mock('../src/notify', () => ({ notifyChanges() {} }));

let fixture: ReturnType<typeof backendAccessFixture>;
beforeEach(() => { fixture = backendAccessFixture(); });
afterEach(() => { fixture.db.close(); });

async function protectedQuery() {
  const app = new Hono<AppContext>();
  const env = { ...fixture.env, JWT_SECRET: 'example-test-signing-key' };
  app.post('/api/query', requireMember, async c => c.json(await runQuery(
    c.env, { waitUntil() {} }, c.get('auth'), await c.req.json(),
  )));
  const token = await sign({
    sub: 'login-member', email: 'member@example.com', exp: Math.floor(Date.now() / 1000) + 300,
  }, env.JWT_SECRET, 'HS256');
  return () => app.request('/api/query', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ table: 'members', op: 'select' }),
  }, env);
}

describe('live Cloud query authorization', () => {
  it.each([
    ["UPDATE members SET is_active=0 WHERE id='member'", 403],
    ["UPDATE auth_users SET banned=1 WHERE id='login-member'", 403],
    ["UPDATE auth_users SET email='changed@example.com' WHERE id='login-member'", 401],
  ])('checks current identity after a previously authorized request (%s)', async (change, status) => {
    const query = await protectedQuery();
    const initial = await query();
    expect(initial.status).toBe(200);
    expect((await initial.json()).data).toHaveLength(4);

    fixture.db.exec(change);
    const denied = await query();
    expect(denied.status).toBe(status);
    expect((await denied.json()).data).toBeUndefined();
  });

  it('repairs an unlinked verified member and refuses to replace an existing login', async () => {
    const query = await protectedQuery();
    fixture.db.exec("UPDATE members SET auth_id=NULL,email_identity_verified=1 WHERE id='member'");
    expect((await query()).status).toBe(200);
    const link = () => fixture.db.prepare("SELECT auth_id FROM members WHERE id='member'").get()?.auth_id;
    expect(link()).toBe('login-member');

    fixture.db.exec("UPDATE members SET auth_id='login-other' WHERE id='member'");
    expect((await query()).status).toBe(403);
    expect(link()).toBe('login-other');
  });

  it('does not relink an unverified email or a banned login', async () => {
    const query = await protectedQuery();
    fixture.db.exec("UPDATE members SET auth_id=NULL,email_identity_verified=0 WHERE id='member'");
    expect((await query()).status).toBe(403);
    fixture.db.exec("UPDATE members SET email_identity_verified=1 WHERE id='member'; UPDATE auth_users SET banned=1 WHERE id='login-member'");
    expect((await query()).status).toBe(403);
    expect(fixture.db.prepare("SELECT auth_id FROM members WHERE id='member'").get()?.auth_id).toBeNull();
  });
});

describe('Cloud standup duration workspace boundaries', () => {
  const request = (id: string, extra: Partial<QueryRequest>) => runQuery(
    fixture.env, { waitUntil() {} }, fixture.auth(id), { table: 'standup_member_durations', op: 'insert', ...extra },
  );
  const values = { id: 'duration-example', standup_session_id: 'session-b', member_id: 'foreign', speak_duration: 90 };
  const conflict = 'standup_session_id,member_id';

  beforeEach(() => {
    fixture.db.exec("INSERT INTO standup_sessions(id,workspace_id,created_by) VALUES('session-a','access-a','member'),('session-b','access-b','foreign')");
  });

  it('rejects foreign session or member references before they can reserve a legitimate key', async () => {
    for (const bad of [
      values,
      { ...values, standup_session_id: 'session-a' },
      { ...values, member_id: 'member' },
    ]) {
      const result = await request('member', { values: bad });
      expect(result.error?.message).toContain('standup_duration_workspace_mismatch');
    }
    expect((await request('foreign', { values })).error).toBeNull();
    const saved = fixture.db.prepare("SELECT workspace_id,speak_duration FROM standup_member_durations WHERE id='duration-example'").get();
    expect(saved).toMatchObject({ workspace_id: 'access-b', speak_duration: 90 });
  });

  it('blocks cross-workspace edits and upserts, then accepts a valid duration update', async () => {
    const own = { ...values, standup_session_id: 'session-a', member_id: 'member' };
    expect((await request('member', { values: own })).error).toBeNull();
    const foreignUpsert = await request('member', { op: 'upsert', onConflict: conflict, values });
    expect(foreignUpsert.error?.message).toContain('standup_duration_workspace_mismatch');
    const foreignEdit = await request('member', {
      op: 'update', filters: [{ col: 'id', op: 'eq', val: own.id }], values: { member_id: 'foreign' },
    });
    expect(foreignEdit.error?.message).toContain('standup_duration_workspace_mismatch');

    const valid = await request('member', { op: 'upsert', onConflict: conflict, values: { ...own, speak_duration: 60 } });
    expect(valid.error).toBeNull();
    expect(fixture.db.prepare("SELECT member_id,speak_duration FROM standup_member_durations WHERE id='duration-example'").get())
      .toMatchObject({ member_id: 'member', speak_duration: 60 });
  });

  it('preserves historical durations after the member has been removed', async () => {
    const legacy = { ...values, standup_session_id: 'session-a', member_id: 'removed-speaker' };
    expect((await request('member', { values: legacy })).error).toBeNull();
    expect(fixture.db.prepare("SELECT member_id FROM standup_member_durations WHERE id='duration-example'").get()?.member_id)
      .toBe('removed-speaker');
  });
});
