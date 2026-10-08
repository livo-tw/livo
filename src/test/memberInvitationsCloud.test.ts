// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Invitation = {
  id: string; role: string; jobTitle: string; isQaAdmin: boolean;
  status: string; createdBy: string; expiresAt: string;
};
type Reply = {
  status: number;
  body: {
    error?: { code?: string; message?: string } | string;
    code?: string; message?: string;
    partial?: { tasksInserted: number; commentsInserted: number; specsInserted: number };
    invitation?: Invitation; invitations?: Invitation[]; inviteToken?: string; inviteUrl?: string;
    workspaceName?: string; role?: string; jobTitle?: string; isQaAdmin?: boolean;
    name?: string; email?: string; expiresAt?: string; sent?: boolean; success?: boolean;
    session?: { access_token: string; refresh_token: string; user: { id: string; email: string } };
    user?: { id: string; email: string };
  };
};
type Fixture = {
  env: { RESEND_API_KEY?: string; RESEND_FROM_EMAIL?: string; DEMO_ACCOUNT_EMAIL?: string; DEMO_MODE?: string };
  notifications: Array<{ workspace: string; events: Array<{ table: string }> }>;
  beforeNextBatch: (() => void) | null;
  beforeNextStatement: { match: RegExp; run: () => Promise<void> } | null;
  call: (body: Record<string, unknown>, bearer?: string, options?: { method?: string; url?: string; headers?: Record<string, string> }) => Promise<Reply>;
  jwt: (id?: string) => Promise<string>;
  pat: (id?: string) => Promise<string>;
  count: (table: string) => number;
  rows: (sql: string, ...args: unknown[]) => Array<Record<string, unknown>>;
  row: (sql: string, ...args: unknown[]) => Record<string, unknown>;
  exec: (sql: string) => void;
  reapplySchema: () => void;
  enableJiraImport: () => Promise<void>;
  query: (request: Record<string, unknown>) => Promise<{ data: unknown; error?: { code?: string; message?: string } }>;
  close: () => void;
};
type Mail = { to: string[]; subject: string; html: string };

// Keep Worker globals out of the frontend's TypeScript compilation. The fixture
// imports and exercises the actual Hono handler, auth and production SQL schema.
const fixtureModulePath = '../../scripts/lib/member-invitations-d1-fixture.mjs';
const { createMemberInvitationsFixture } = await import(fixtureModulePath) as {
  createMemberInvitationsFixture: () => Promise<Fixture>;
};
let fixture: Fixture, ownerJwt: string, mail: Mail[], deliveryStatus: number;
let deliveryGate: Promise<void> | null;
let providerEffect: (() => void) | null;

const errorCode = (reply: Reply) => reply.body.code ?? (typeof reply.body.error === 'string' ? reply.body.error : reply.body.error?.code);
const call = (body: Record<string, unknown>, bearer = '') => fixture.call(body, bearer);
const create = async (grant: Record<string, unknown> = {}, bearer = ownerJwt) => {
  const reply = await call({ action: 'create', ...grant }, bearer);
  expect(reply.status).toBe(200);
  expect(Boolean(reply.body.inviteToken)).toBe(true);
  const url = new URL(reply.body.inviteUrl!);
  expect(url.origin).toBe('https://app.example.com');
  expect(url.pathname).toBe('/demo/join');
  expect(url.search).toBe('');
  expect(new URLSearchParams(url.hash.slice(1)).get('invite') === reply.body.inviteToken).toBe(true);
  return { invitation: reply.body.invitation!, token: reply.body.inviteToken! };
};
const confirmationFromMail = (index = mail.length - 1) => {
  const links = [...mail[index].html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1].replace(/&amp;/g, '&')));
  const link = links.find(url => url.pathname === '/demo/join' && new URLSearchParams(url.hash.slice(1)).has('confirmation'));
  expect(Boolean(link)).toBe(true);
  expect(link?.origin).toBe('https://app.example.com');
  expect(link?.search).toBe('');
  return new URLSearchParams(link!.hash.slice(1)).get('confirmation')!;
};
const confirm = async (inviteToken: string, email = 'new@example.com', name = 'Example Newcomer') => {
  const reply = await call({ action: 'request_confirmation', inviteToken, email, name });
  expect(reply.status).toBe(200);
  expect(reply.body.sent).toBe(true);
  return confirmationFromMail();
};
const accept = (confirmationToken: string, extra: Record<string, unknown> = {}) =>
  call({ action: 'accept', confirmationToken, password: 'synthetic-valid-password', ...extra });
const manage = (body: Record<string, unknown>) => fixture.call(body, ownerJwt, { url: 'https://api.example.com/api/functions/manage-member' });
const importExamplePerson = (accounts: Array<{ name: string; email: string }> = []) => fixture.call({
  csv: 'Summary,Issue key,Status,Project key,Project name,Assignee\nExample work,EXAMPLE-1,To Do,EXAMPLE,Example Project,Example Imported\n',
  accounts,
}, ownerJwt, { url: 'https://api.example.com/api/functions/import-jira' });
const prepareInactive = () => fixture.exec(`
  INSERT INTO auth_users(id,email,password_hash,banned) VALUES('login-inactive','inactive@example.com','preserve-inactive-hash',1);
  INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id,is_active)
    VALUES('a','inactive','Example Inactive','','inactive@example.com','member','login-inactive',0);`);
const expectUnjoined = () => {
  expect(fixture.count('auth_users')).toBe(4);
  expect(fixture.count('members')).toBe(4);
  expect(fixture.count('auth_refresh_tokens')).toBe(0);
  expect(fixture.notifications).toHaveLength(0);
};

beforeEach(async () => {
  mail = [];
  deliveryStatus = 200;
  deliveryGate = null;
  providerEffect = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (target !== 'https://api.resend.com/emails') throw new Error('Unexpected external request in isolated invitation test');
    mail.push(JSON.parse(String(init?.body)) as Mail);
    if (deliveryGate) await deliveryGate;
    providerEffect?.();
    return Response.json({ id: 'synthetic-delivery' }, { status: deliveryStatus });
  }));
  fixture = await createMemberInvitationsFixture();
  ownerJwt = await fixture.jwt();
});
afterEach(() => {
  fixture?.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Cloudflare member invitations on native SQLite', () => {
  it('verifies email before atomically creating the fixed member grant, password and session', async () => {
    const { invitation, token } = await create({ role: 'member', jobTitle: 'Engineering', isQaAdmin: true });
    expect(invitation).toMatchObject({ role: 'member', jobTitle: 'Engineering', isQaAdmin: true, status: 'pending', createdBy: 'owner' });
    expectUnjoined();
    const preview = await call({ action: 'preview', inviteToken: token });
    expect(preview).toMatchObject({ status: 200, body: { workspaceName: 'Example Team', role: 'member', jobTitle: 'Engineering', isQaAdmin: true } });
    const stored = fixture.rows('SELECT * FROM member_invitations');
    expect(JSON.stringify(stored).includes(token)).toBe(false);
    const request = await call({ action: 'request_confirmation', inviteToken: token, name: '  Example Newcomer  ', email: ' NEW@EXAMPLE.COM ' });
    expect(request).toMatchObject({ status: 200, body: { sent: true } });
    expect(mail[0].to).toEqual(['new@example.com']);
    const confirmationToken = confirmationFromMail();
    expect(JSON.stringify(request.body).includes(confirmationToken)).toBe(false);
    expect(JSON.stringify(fixture.rows('SELECT * FROM member_invitation_confirmations')).includes(confirmationToken)).toBe(false);
    const confirmationPreview = await call({ action: 'confirmation_preview', confirmationToken });
    expect(confirmationPreview).toMatchObject({ status: 200, body: { name: 'Example Newcomer', email: 'new@example.com', role: 'member', jobTitle: 'Engineering', isQaAdmin: true } });
    await call({ action: 'confirmation_preview', confirmationToken });
    expectUnjoined();
    const accepted = await accept(confirmationToken);
    expect(accepted.status).toBe(200);
    expect(accepted.body.success).toBe(true);
    expect(accepted.body.session?.user.email).toBe('new@example.com');
    expect(Boolean(accepted.body.session?.access_token && accepted.body.session?.refresh_token)).toBe(true);
    const member = fixture.row('SELECT * FROM members WHERE email=?', 'new@example.com');
    expect(member).toMatchObject({ workspace_id: 'a', name: 'Example Newcomer', role: 'member', job_title: 'Engineering', is_qa_admin: 1, is_active: 1 });
    const auth = fixture.row('SELECT * FROM auth_users WHERE email=?', 'new@example.com');
    expect(member.auth_id).toBe(auth.id);
    expect(typeof auth.password_hash === 'string' && auth.password_hash.startsWith('pbkdf2$')).toBe(true);
    expect(auth.password_hash === 'synthetic-valid-password').toBe(false);
    expect(fixture.count('auth_refresh_tokens')).toBe(1);
    const signedIn = await fixture.call({}, accepted.body.session!.access_token, { method: 'GET', url: 'https://api.example.com/api/auth/user' });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user?.email).toBe('new@example.com');
    const list = await call({ action: 'list' }, ownerJwt);
    expect(list.body.invitations?.find(item => item.id === invitation.id)?.status).toBe('used');
    expect(JSON.stringify(list.body).includes(token)).toBe(false);
    expect(fixture.notifications.every(item => item.workspace === 'ws:a')).toBe(true);
  });

  it('permits exactly one concurrent accept and refuses every replay', async () => {
    const { token } = await create();
    const confirmationToken = await confirm(token);
    const attempts = await Promise.all([accept(confirmationToken), accept(confirmationToken)]);
    expect(attempts.filter(reply => reply.status === 200)).toHaveLength(1);
    expect(attempts.filter(reply => reply.status >= 400)).toHaveLength(1);
    expect(fixture.count('auth_users')).toBe(5);
    expect(fixture.count('members')).toBe(5);
    expect(fixture.count('auth_refresh_tokens')).toBe(1);
    expect((await accept(confirmationToken)).status).toBeGreaterThanOrEqual(400);
    expect((await call({ action: 'preview', inviteToken: token })).status).toBeGreaterThanOrEqual(400);
  });

  it('shares a single invitation claim across different verified recipients', async () => {
    const { token } = await create();
    const first = await confirm(token, 'first@example.com');
    const second = await confirm(token, 'second@example.com');
    const attempts = await Promise.all([accept(first), accept(second)]);
    expect(attempts.filter(reply => reply.status === 200)).toHaveLength(1);
    expect(fixture.count('members')).toBe(5);
    expect(fixture.count('auth_users')).toBe(5);
    expect(fixture.count('auth_refresh_tokens')).toBe(1);
  });

  it.each(['admin', 'super_admin'])('lets super admin create an email-verified %s grant', async role => {
    const { token } = await create({ role });
    const confirmationToken = await confirm(token);
    expect((await accept(confirmationToken)).status).toBe(200);
    expect(fixture.row("SELECT role,is_qa_admin FROM members WHERE email='new@example.com'")).toMatchObject({ role, is_qa_admin: 0 });
  });

  it.each(['create', 'list', 'revoke'])('requires an authenticated member for management action %s', async action => {
    expect((await call({ action, invitationId: 'unknown' })).status).toBe(401);
    expect(fixture.count('member_invitations')).toBe(0);
  });

  it('lets admin issue ordinary member invitations and denies privilege grants', async () => {
    const adminJwt = await fixture.jwt('admin');
    await create({}, adminJwt);
    for (const grant of [{ role: 'admin' }, { role: 'super_admin' }, { isQaAdmin: true }, { jobTitle: 'Engineering' }]) {
      const reply = await call({ action: 'create', ...grant }, adminJwt);
      expect(reply.status).toBe(403);
      expect(errorCode(reply)).toBe('forbidden');
    }
    expect(fixture.count('member_invitations')).toBe(1);
    const memberJwt = await fixture.jwt('member');
    expect((await call({ action: 'create' }, memberJwt)).status).toBe(403);
  });

  it('lists only an admin own invitations while super admin sees the workspace list', async () => {
    const ownerInvite = await create();
    const adminJwt = await fixture.jwt('admin');
    const adminInvite = await create({}, adminJwt);
    const adminList = await call({ action: 'list' }, adminJwt);
    expect(adminList.status).toBe(200);
    expect(adminList.body.invitations?.map(invitation => invitation.id)).toEqual([adminInvite.invitation.id]);
    const ownerList = await call({ action: 'list' }, ownerJwt);
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.invitations?.map(invitation => invitation.id).sort()).toEqual([ownerInvite.invitation.id, adminInvite.invitation.id].sort());
  });

  it('lets an admin revoke only their own invitation and lets super admin revoke any workspace invite', async () => {
    const ownerInvite = await create();
    const adminJwt = await fixture.jwt('admin');
    const own = await create({}, adminJwt);
    expect((await call({ action: 'revoke', invitationId: ownerInvite.invitation.id }, adminJwt)).status).toBe(403);
    expect((await call({ action: 'revoke', invitationId: own.invitation.id }, adminJwt)).status).toBe(200);
    const secondOwn = await create({}, adminJwt);
    expect((await call({ action: 'revoke', invitationId: secondOwn.invitation.id }, ownerJwt)).status).toBe(200);
    expect((await call({ action: 'preview', inviteToken: ownerInvite.token })).status).toBe(200);
  });

  it('lets a downgraded issuer revoke an own previously privileged grant', async () => {
    const { invitation } = await create({ role: 'super_admin' });
    fixture.exec("UPDATE members SET role='admin' WHERE workspace_id='a' AND id='owner'");
    expect((await call({ action: 'revoke', invitationId: invitation.id }, ownerJwt)).status).toBe(200);
    expect(fixture.row('SELECT revoked_at FROM member_invitations WHERE id=?', invitation.id).revoked_at !== null).toBe(true);
  });

  it.each([
    { role: 'admin' }, { role: 'super_admin' }, { jobTitle: 'Engineering' }, { isQaAdmin: true },
  ])('lists a grant unavailable after its issuer loses authority: %j', async grant => {
    const { invitation, token } = await create(grant);
    fixture.exec("UPDATE members SET role='admin' WHERE workspace_id='a' AND id='owner'");
    const list = await call({ action: 'list' }, ownerJwt);
    expect(list.status).toBe(200);
    expect(list.body.invitations?.find(item => item.id === invitation.id)?.status).toBe('unavailable');
    expect((await call({ action: 'preview', inviteToken: token })).status).toBe(400);
    expect((await call({ action: 'revoke', invitationId: invitation.id }, ownerJwt)).status).toBe(200);
  });

  it('keeps an ordinary member grant pending and usable after its issuer becomes an admin', async () => {
    const { invitation, token } = await create();
    fixture.exec("UPDATE members SET role='admin' WHERE workspace_id='a' AND id='owner'");
    const list = await call({ action: 'list' }, ownerJwt);
    expect(list.body.invitations?.find(item => item.id === invitation.id)?.status).toBe('pending');
    expect((await call({ action: 'preview', inviteToken: token })).status).toBe(200);
    expect((await accept(await confirm(token))).status).toBe(200);
  });

  it.each(['inactive', 'member', 'banned', 'relinked', 'ambiguous'])('shows unavailable for an issuer that is %s', async change => {
    fixture.exec("UPDATE members SET role='super_admin' WHERE workspace_id='a' AND id='admin'");
    const reader = await fixture.jwt('admin');
    const { invitation, token } = await create();
    const changes: Record<string, string> = {
      inactive: "UPDATE members SET is_active=0 WHERE workspace_id='a' AND id='owner'",
      member: "UPDATE members SET role='member' WHERE workspace_id='a' AND id='owner'",
      banned: "UPDATE auth_users SET banned=1 WHERE id='login-owner'",
      relinked: "UPDATE members SET auth_id='replacement-login' WHERE workspace_id='a' AND id='owner'",
      ambiguous: "INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id,is_active) VALUES('a','duplicate-login','Example Duplicate','','duplicate-login@example.com','member','login-owner',1)",
    };
    fixture.exec(changes[change]);
    const list = await call({ action: 'list' }, reader);
    expect(list.status).toBe(200);
    expect(list.body.invitations?.find(item => item.id === invitation.id)?.status).toBe('unavailable');
    expect((await call({ action: 'preview', inviteToken: token })).status).toBe(400);
  });

  it('keeps used, revoked and expired statuses ahead of unavailable', async () => {
    const used = await create({ role: 'admin' });
    expect((await accept(await confirm(used.token))).status).toBe(200);
    const revoked = await create({ role: 'admin' });
    await call({ action: 'revoke', invitationId: revoked.invitation.id }, ownerJwt);
    const expired = await create({ role: 'admin' });
    const unavailable = await create({ role: 'admin' });
    fixture.exec(`DROP TRIGGER member_invitation_immutable;
      UPDATE member_invitations SET expires_at='2000-01-01T00:00:00.000Z' WHERE id='${expired.invitation.id}';`);
    fixture.reapplySchema();
    fixture.exec("UPDATE members SET role='admin' WHERE workspace_id='a' AND id='owner'");
    const list = await call({ action: 'list' }, ownerJwt);
    const status = (id: string) => list.body.invitations?.find(item => item.id === id)?.status;
    expect(status(used.invitation.id)).toBe('used');
    expect(status(revoked.invitation.id)).toBe('revoked');
    expect(status(expired.invitation.id)).toBe('expired');
    expect(status(unavailable.invitation.id)).toBe('unavailable');
  });

  it('prunes expired proof personal data and old attempts only in the accessed workspace', async () => {
    const own = await create();
    const liveToken = await confirm(own.token);
    const other = await create({}, await fixture.jwt('foreign'));
    const oldCreated = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    const oldExpires = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    for (const [ws, invitation] of [['a', own.invitation.id], ['b', other.invitation.id]]) {
      for (const state of ['pending', 'sent', 'failed', 'used']) {
        fixture.exec(`INSERT INTO member_invitation_confirmations
          (workspace_id,id,invitation_id,token_hash,name,email,created_at,expires_at,send_state,used_at)
          VALUES('${ws}','old-${state}','${invitation}','hash-${ws}-${state}','Old Private Name','old-${state}@example.com',
            '${oldCreated}','${oldExpires}','${state === 'used' ? 'sent' : state}',${state === 'used' ? `'${oldCreated}'` : 'NULL'});`);
      }
    }
    fixture.exec(`INSERT INTO member_invitation_send_attempts(workspace_id,id,invitation_id,email_hash,source_hash,created_at)
      VALUES('a','old-attempt','${own.invitation.id}','old-email-a','old-source-a','${oldCreated}'),
        ('b','old-attempt','${other.invitation.id}','old-email-b','old-source-b','${oldCreated}');`);
    const otherProofs = JSON.stringify(fixture.rows("SELECT * FROM member_invitation_confirmations WHERE workspace_id='b'"));
    const otherAttempts = JSON.stringify(fixture.rows("SELECT * FROM member_invitation_send_attempts WHERE workspace_id='b'"));
    expect((await call({ action: 'preview', inviteToken: own.token })).status).toBe(200);
    expect(fixture.rows("SELECT id FROM member_invitation_confirmations WHERE workspace_id='a' AND id LIKE 'old-%'")).toHaveLength(0);
    expect(fixture.row("SELECT id FROM member_invitation_send_attempts WHERE workspace_id='a' AND id='old-attempt'")).toBeNull();
    expect(JSON.stringify(fixture.rows("SELECT * FROM member_invitation_confirmations WHERE workspace_id='b'"))).toBe(otherProofs);
    expect(JSON.stringify(fixture.rows("SELECT * FROM member_invitation_send_attempts WHERE workspace_id='b'"))).toBe(otherAttempts);
    expect((await call({ action: 'confirmation_preview', confirmationToken: liveToken })).status).toBe(200);
    expect(fixture.count('member_invitations')).toBe(2);
    const throttled = await call({ action: 'request_confirmation', inviteToken: own.token, name: 'Example', email: 'new@example.com' });
    expect(throttled.status).toBe(429);
    expect(errorCode(throttled)).toBe('rate_limited');
    expect((await accept(liveToken)).status).toBe(200);
  });

  it('keeps the exact rolling-day boundary and expired-proof retention window', async () => {
    const { invitation, token } = await create();
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    vi.setSystemTime(now);
    const cutoff = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const justInside = new Date(now - 24 * 60 * 60 * 1000 + 1).toISOString();
    fixture.exec('DROP TRIGGER member_invitation_attempt_guard');
    for (const [id, expiry] of [['at-cutoff', cutoff], ['retained-expired', justInside]]) {
      fixture.exec(`INSERT INTO member_invitation_confirmations
        (workspace_id,id,invitation_id,token_hash,name,email,created_at,expires_at)
        VALUES('a','${id}','${invitation.id}','hash-${id}','Private Name','${id}@example.com','${cutoff}','${expiry}');`);
    }
    fixture.exec(`INSERT INTO member_invitation_send_attempts(workspace_id,id,invitation_id,email_hash,source_hash,created_at)
      VALUES('a','at-cutoff','${invitation.id}','email-at-cutoff','source-at-cutoff','${cutoff}');`);
    for (let i = 0; i < 10; i++) fixture.exec(`INSERT INTO member_invitation_send_attempts
      (workspace_id,id,invitation_id,email_hash,source_hash,created_at)
      VALUES('a','inside-${i}','${invitation.id}','email-${i}','source-${i}','${justInside}');`);
    fixture.reapplySchema();
    expect((await call({ action: 'list' }, ownerJwt)).status).toBe(200);
    expect(fixture.row("SELECT id FROM member_invitation_confirmations WHERE id='at-cutoff'")).toBeNull();
    expect(fixture.row("SELECT id FROM member_invitation_confirmations WHERE id='retained-expired'")).not.toBeNull();
    expect(fixture.row("SELECT id FROM member_invitation_send_attempts WHERE id='at-cutoff'")).toBeNull();
    expect(fixture.rows("SELECT id FROM member_invitation_send_attempts WHERE workspace_id='a'")).toHaveLength(10);
    const throttled = await call({ action: 'request_confirmation', inviteToken: token, name: 'Example', email: 'another@example.com' });
    expect(throttled.status).toBe(429);
    expect(errorCode(throttled)).toBe('rate_limited');
    expect(mail).toHaveLength(0);
  });

  it('bounds each cleanup batch while preserving invitation metadata and a fresh proof', async () => {
    const { invitation, token } = await create();
    const liveToken = await confirm(token);
    const old = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    fixture.exec('DROP TRIGGER member_invitation_attempt_guard');
    for (let i = 0; i < 201; i++) {
      fixture.exec(`INSERT INTO member_invitation_confirmations
        (workspace_id,id,invitation_id,token_hash,name,email,created_at,expires_at)
        VALUES('a','old-${i}','${invitation.id}','hash-old-${i}','Private Name','old-${i}@example.com','${old}','${old}');
        INSERT INTO member_invitation_send_attempts(workspace_id,id,invitation_id,email_hash,source_hash,created_at)
        VALUES('a','old-${i}','${invitation.id}','email-old-${i}','source-old-${i}','${old}');`);
    }
    fixture.reapplySchema();
    const storedInvite = JSON.stringify(fixture.row('SELECT * FROM member_invitations WHERE id=?', invitation.id));
    expect((await call({ action: 'list' }, ownerJwt)).status).toBe(200);
    expect(fixture.rows("SELECT id FROM member_invitation_confirmations WHERE id LIKE 'old-%'")).toHaveLength(1);
    expect(fixture.rows("SELECT id FROM member_invitation_send_attempts WHERE id LIKE 'old-%'")).toHaveLength(1);
    expect((await call({ action: 'list' }, ownerJwt)).status).toBe(200);
    expect(fixture.rows("SELECT id FROM member_invitation_confirmations WHERE id LIKE 'old-%'")).toHaveLength(0);
    expect(fixture.rows("SELECT id FROM member_invitation_send_attempts WHERE id LIKE 'old-%'")).toHaveLength(0);
    expect(JSON.stringify(fixture.row('SELECT * FROM member_invitations WHERE id=?', invitation.id))).toBe(storedInvite);
    expect((await call({ action: 'confirmation_preview', confirmationToken: liveToken })).status).toBe(200);
    expect((await accept(liveToken)).status).toBe(200);
  });

  it('removes old consumed proofs while keeping joined accounts and ordinary sign-in usable', async () => {
    const { invitation, token } = await create();
    const confirmationToken = await confirm(token);
    expect((await accept(confirmationToken)).status).toBe(200);
    const accounts = JSON.stringify(fixture.rows('SELECT * FROM auth_users ORDER BY id'));
    const members = JSON.stringify(fixture.rows('SELECT * FROM members ORDER BY id'));
    const sessions = JSON.stringify(fixture.rows('SELECT * FROM auth_refresh_tokens ORDER BY token_hash'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 26 * 60 * 60 * 1000);
    const list = await call({ action: 'list' }, await fixture.jwt());
    expect(list.status).toBe(200);
    expect(list.body.invitations?.find(item => item.id === invitation.id)?.status).toBe('used');
    expect(fixture.count('member_invitation_confirmations')).toBe(0);
    expect(fixture.count('member_invitation_send_attempts')).toBe(0);
    expect(JSON.stringify(fixture.rows('SELECT * FROM auth_users ORDER BY id'))).toBe(accounts);
    expect(JSON.stringify(fixture.rows('SELECT * FROM members ORDER BY id'))).toBe(members);
    expect(JSON.stringify(fixture.rows('SELECT * FROM auth_refresh_tokens ORDER BY token_hash'))).toBe(sessions);
    expect((await accept(confirmationToken)).status).toBe(400);
    const signIn = await fixture.call({ email: 'new@example.com', password: 'synthetic-valid-password' }, '', {
      url: 'https://api.example.com/api/auth/login',
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.session?.user.email).toBe('new@example.com');
  });

  it('creates no invitation or token when outgoing mail is not configured', async () => {
    delete fixture.env.RESEND_API_KEY;
    const reply = await call({ action: 'create' }, ownerJwt);
    expect(reply.status).toBe(503);
    expect(errorCode(reply)).toBe('email_not_configured');
    expect(Boolean(reply.body.inviteToken || reply.body.inviteUrl)).toBe(false);
    expect(fixture.count('member_invitations')).toBe(0);
    expect(mail).toHaveLength(0);
    expectUnjoined();
  });

  it('keeps list and revoke usable after mail configuration is removed', async () => {
    const { invitation } = await create();
    delete fixture.env.RESEND_API_KEY;
    const list = await call({ action: 'list' }, ownerJwt);
    expect(list.status).toBe(200);
    expect(list.body.invitations).toHaveLength(1);
    expect((await call({ action: 'revoke', invitationId: invitation.id }, ownerJwt)).status).toBe(200);
  });

  it('limits invitation creation atomically to 20 per issuer in a rolling day', async () => {
    for (let i = 0; i < 19; i++) await create();
    const attempts = await Promise.all([call({ action: 'create' }, ownerJwt), call({ action: 'create' }, ownerJwt)]);
    expect(attempts.filter(reply => reply.status === 200)).toHaveLength(1);
    expect(attempts.filter(reply => reply.status === 429 && errorCode(reply) === 'rate_limited')).toHaveLength(1);
    expect(fixture.count('member_invitations')).toBe(20);
    await create({}, await fixture.jwt('admin'));
    await create({}, await fixture.jwt('foreign'));
    expect(fixture.count('member_invitations')).toBe(22);
    expectUnjoined();
  });

  it.each(['create', 'list', 'revoke'])('rejects a real personal API key for management action %s', async action => {
    const pat = await fixture.pat();
    const reply = await call({ action }, pat);
    expect(reply.status).toBe(403);
    expect(errorCode(reply)).toBe('api_key_forbidden');
    expect(fixture.count('member_invitations')).toBe(0);
  });

  it('rechecks a cached administrator role against live membership', async () => {
    const adminJwt = await fixture.jwt('admin');
    await create({}, adminJwt);
    fixture.exec("UPDATE members SET role='member' WHERE workspace_id='a' AND id='admin'");
    expect((await call({ action: 'create' }, adminJwt)).status).toBe(403);
    expect(fixture.count('member_invitations')).toBe(1);
  });

  it('denies admin revocation of a privileged invitation while preserving the link', async () => {
    const { invitation, token } = await create({ role: 'super_admin' });
    const reply = await call({ action: 'revoke', invitationId: invitation.id }, await fixture.jwt('admin'));
    expect(reply.status).toBe(403);
    expect((await call({ action: 'preview', inviteToken: token })).status).toBe(200);
  });

  it('preserves the configured demo-account restriction when DEMO_MODE is unset', async () => {
    const { invitation } = await create();
    fixture.env.DEMO_ACCOUNT_EMAIL = ' OWNER@EXAMPLE.COM ';
    for (const action of ['create', 'list', 'revoke']) {
      const reply = await call({ action, ...(action === 'revoke' ? { invitationId: invitation.id } : {}) }, ownerJwt);
      expect(reply.status).toBe(403);
      expect(errorCode(reply)).toBe('demo_blocked');
    }
    expect(fixture.count('member_invitations')).toBe(1);
  });

  it('denies generic query access to every server-only invitation table', async () => {
    const { token } = await create();
    await confirm(token);
    for (const table of ['member_invitations', 'member_invitation_confirmations', 'member_invitation_send_attempts']) {
      for (const op of ['select', 'insert', 'update', 'delete']) {
        const reply = await fixture.query({ table, op, cols: '*', values: { role: 'super_admin' }, filters: [{ col: 'workspace_id', op: 'eq', val: 'a' }] });
        expect(Boolean(reply.error)).toBe(true);
        expect(reply.data).toBeNull();
      }
    }
    expectUnjoined();
    expect((await call({ action: 'preview', inviteToken: token })).status).toBe(200);
  });

  it('reapplies schema without losing pending links or confirmation proofs', async () => {
    const { token } = await create();
    const confirmationToken = await confirm(token);
    const invitations = JSON.stringify(fixture.rows('SELECT * FROM member_invitations'));
    const confirmations = JSON.stringify(fixture.rows('SELECT * FROM member_invitation_confirmations'));
    fixture.reapplySchema();
    expect(JSON.stringify(fixture.rows('SELECT * FROM member_invitations'))).toBe(invitations);
    expect(JSON.stringify(fixture.rows('SELECT * FROM member_invitation_confirmations'))).toBe(confirmations);
    expect((await accept(confirmationToken)).status).toBe(200);
  });

  it('keeps real cloud workspaces usable when the default workspace is a demo', async () => {
    fixture.env.DEMO_MODE = '1';
    const { token } = await create();
    const confirmationToken = await confirm(token);
    expect((await accept(confirmationToken)).status).toBe(200);
  });

  it('never exposes or revokes invitations in another workspace', async () => {
    const { invitation, token } = await create();
    const foreignJwt = await fixture.jwt('foreign');
    const list = await call({ action: 'list' }, foreignJwt);
    expect(list.status).toBe(200);
    expect(list.body.invitations).toEqual([]);
    expect((await call({ action: 'revoke', invitationId: invitation.id }, foreignJwt)).status).toBeGreaterThanOrEqual(400);
    expect((await call({ action: 'preview', inviteToken: token })).status).toBe(200);
    const pieces = token.split('.');
    pieces[1] = Buffer.from(JSON.stringify({ w: 'b', i: invitation.id })).toString('base64url');
    expect((await call({ action: 'preview', inviteToken: pieces.join('.') })).status).toBeGreaterThanOrEqual(400);
    expectUnjoined();
  });

  it('rejects malformed and tampered tokens on every public action', async () => {
    const { token } = await create();
    const bad = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    for (const invalid of ['', 'garbage', bad]) {
      for (const body of [
        { action: 'preview', inviteToken: invalid },
        { action: 'request_confirmation', inviteToken: invalid, name: 'Example', email: 'new@example.com' },
        { action: 'confirmation_preview', confirmationToken: invalid },
        { action: 'accept', confirmationToken: invalid, password: 'synthetic-valid-password' },
      ]) expect((await call(body)).status).toBeGreaterThanOrEqual(400);
    }
    expect(mail).toHaveLength(0);
    expectUnjoined();
  });

  it('requires a delivered email confirmation token before accepting', async () => {
    const { token } = await create();
    expect((await accept(token)).status).toBeGreaterThanOrEqual(400);
    const request = await call({ action: 'request_confirmation', inviteToken: token, name: 'Example', email: 'new@example.com', password: 'attacker-chosen-password' });
    expect(request.status).toBe(400);
    expect(mail).toHaveLength(0);
    expectUnjoined();
  });

  it.each(['email', 'name', 'role', 'jobTitle', 'isQaAdmin', 'authId', 'workspaceId'])('refuses joiner supplied authority field %s', async field => {
    const { token } = await create();
    const confirmationToken = await confirm(token);
    expect((await accept(confirmationToken, { [field]: field === 'isQaAdmin' ? true : 'forged' })).status).toBe(400);
    expectUnjoined();
    expect((await accept(confirmationToken)).status).toBe(200);
  });

  it('keeps original invitation usable when transport is not configured', async () => {
    const { token } = await create();
    delete fixture.env.RESEND_API_KEY;
    const reply = await call({ action: 'request_confirmation', inviteToken: token, name: 'Example', email: 'new@example.com' });
    expect(reply.status).toBe(503);
    expect(errorCode(reply)).toBe('email_not_configured');
    expect(mail).toHaveLength(0);
    expectUnjoined();
    expect((await call({ action: 'preview', inviteToken: token })).status).toBe(200);
  });

  it('reports provider refusal without confirming email, creating accounts or consuming the invite', async () => {
    const { token } = await create();
    deliveryStatus = 503;
    const reply = await call({ action: 'request_confirmation', inviteToken: token, name: 'Example', email: 'new@example.com' });
    expect(reply.status).toBe(503);
    expect(errorCode(reply)).toBe('email_send_failed');
    expect(reply.body.sent).not.toBe(true);
    const failedConfirmation = confirmationFromMail();
    expect(JSON.stringify(reply.body).includes(failedConfirmation)).toBe(false);
    expect((await accept(failedConfirmation)).status).toBeGreaterThanOrEqual(400);
    expect((await call({ action: 'confirmation_preview', confirmationToken: failedConfirmation })).status).toBeGreaterThanOrEqual(400);
    expect((await call({ action: 'preview', inviteToken: token })).status).toBe(200);
    expectUnjoined();
  });

  it('waits for the mail provider and never treats a pending delivery as email proof', async () => {
    const { token } = await create();
    let releaseDelivery: () => void;
    deliveryGate = new Promise(resolve => { releaseDelivery = resolve; });
    let returned = false;
    const request = call({ action: 'request_confirmation', inviteToken: token, name: 'Example', email: 'new@example.com' })
      .then(reply => { returned = true; return reply; });
    await vi.waitFor(() => expect(mail).toHaveLength(1));
    expect(returned).toBe(false);
    const confirmationToken = confirmationFromMail();
    expect((await accept(confirmationToken)).status).toBeGreaterThanOrEqual(400);
    expect((await call({ action: 'confirmation_preview', confirmationToken })).status).toBeGreaterThanOrEqual(400);
    expectUnjoined();
    releaseDelivery();
    expect((await request).status).toBe(200);
    expect((await accept(confirmationToken)).status).toBe(200);
  });

  it('does not report mail success when a delivery marker no longer owns the pending proof', async () => {
    const { token } = await create();
    providerEffect = () => fixture.exec("UPDATE member_invitation_confirmations SET send_state='failed' WHERE workspace_id='a' AND email='new@example.com'");
    const reply = await call({ action: 'request_confirmation', inviteToken: token, name: 'Example', email: 'new@example.com' });
    expect(reply.status).toBe(503);
    expect(errorCode(reply)).toBe('server_error');
    expect(reply.body.sent).not.toBe(true);
    const confirmationToken = confirmationFromMail();
    expect((await call({ action: 'confirmation_preview', confirmationToken })).status).toBeGreaterThanOrEqual(400);
    expect((await accept(confirmationToken)).status).toBeGreaterThanOrEqual(400);
    expect(fixture.row("SELECT send_state FROM member_invitation_confirmations WHERE workspace_id='a' AND email='new@example.com'").send_state).toBe('failed');
    expectUnjoined();
    expect((await call({ action: 'preview', inviteToken: token })).status).toBe(200);
  });

  it('keeps an accepted provider request unverified if recording delivery fails', async () => {
    const { token } = await create();
    fixture.exec("CREATE TRIGGER injected_delivery_marker_failure BEFORE UPDATE OF send_state ON member_invitation_confirmations WHEN NEW.send_state='sent' BEGIN SELECT RAISE(ABORT,'synthetic_delivery_marker_failure'); END");
    const reply = await call({ action: 'request_confirmation', inviteToken: token, name: 'Example', email: 'new@example.com' });
    expect(reply.status).toBe(503);
    expect(errorCode(reply)).toBe('server_error');
    expect(reply.body.sent).not.toBe(true);
    const confirmationToken = confirmationFromMail();
    expect((await accept(confirmationToken)).status).toBeGreaterThanOrEqual(400);
    expect(fixture.row("SELECT send_state FROM member_invitation_confirmations WHERE workspace_id='a' AND email='new@example.com'").send_state).toBe('pending');
    expectUnjoined();
  });

  it('uses the workspace mail configuration when there is no instance transport', async () => {
    const { token } = await create();
    delete fixture.env.RESEND_API_KEY;
    fixture.exec("INSERT INTO email_config(id,api_key,from_address) VALUES('a','synthetic-workspace-transport','workspace@example.com')");
    await confirm(token);
    expect(mail).toHaveLength(1);
    expectUnjoined();
  });

  it('escapes applicant and workspace names in the confirmation mail', async () => {
    fixture.exec("UPDATE workspaces SET name='<Example Team>' WHERE id='a'");
    const { token } = await create();
    await confirm(token, 'new@example.com', '<script>alert(1)</script>');
    expect(mail[0].html.includes('<script>')).toBe(false);
    expect(mail[0].html.includes('&lt;script&gt;')).toBe(true);
    expect(mail[0].html.includes('&lt;Example Team&gt;')).toBe(true);
    expectUnjoined();
  });

  it('reserves the email send attempt atomically so concurrent requests send once', async () => {
    const { token } = await create();
    const request = { action: 'request_confirmation', inviteToken: token, name: 'Example', email: 'new@example.com' };
    const replies = await Promise.all([call(request), call(request)]);
    expect(replies.filter(reply => reply.status === 200)).toHaveLength(1);
    expect(replies.filter(reply => reply.status === 429)).toHaveLength(1);
    expect(mail).toHaveLength(1);
    expectUnjoined();
  });

  it('limits the same email across different invitation links', async () => {
    const first = await create(), second = await create();
    const replies = await Promise.all([first, second].map(invite => call({ action: 'request_confirmation', inviteToken: invite.token, name: 'Example', email: 'new@example.com' })));
    expect(replies.filter(reply => reply.status === 200)).toHaveLength(1);
    expect(replies.filter(reply => reply.status === 429)).toHaveLength(1);
    expect(mail).toHaveLength(1);
    expectUnjoined();
  });

  it('allows nine coworkers on a shared office source to request their own confirmation', async () => {
    for (let i = 0; i < 9; i++) {
      const { token } = await create();
      const reply = await call({ action: 'request_confirmation', inviteToken: token, name: 'Example', email: `example-${i}@example.com` });
      expect(reply.status).toBe(200);
    }
    expect(mail).toHaveLength(9);
    expectUnjoined();
  });

  it('limits a shared source to 100 sends a day across otherwise valid invitations', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 11; i++) tokens.push((await create()).token);
    for (let i = 0; i < 100; i++) {
      const reply = await call({ action: 'request_confirmation', inviteToken: tokens[Math.floor(i / 10)], name: 'Example', email: `example-${i}@example.com` });
      expect(reply.status).toBe(200);
    }
    const reply = await call({ action: 'request_confirmation', inviteToken: tokens[10], name: 'Example', email: 'example-100@example.com' });
    expect(reply.status).toBe(429);
    expect(errorCode(reply)).toBe('rate_limited');
    expect(mail).toHaveLength(100);
    expectUnjoined();
  });

  it('limits total sends for an invitation across different source addresses', async () => {
    const { token } = await create();
    for (let i = 0; i < 11; i++) {
      const reply = await fixture.call({ action: 'request_confirmation', inviteToken: token, name: 'Example', email: `example-${i}@example.com` }, '', { headers: { 'CF-Connecting-IP': `192.0.2.${i + 1}` } });
      expect(reply.status).toBe(i < 10 ? 200 : 429);
    }
    expect(mail).toHaveLength(10);
    expectUnjoined();
  });

  it('fails closed without an edge source address in production', async () => {
    const { token } = await create();
    const reply = await fixture.call({ action: 'request_confirmation', inviteToken: token, name: 'Example', email: 'new@example.com' }, '', { headers: { 'CF-Connecting-IP': '' } });
    expect(reply.status).toBe(503);
    expect(mail).toHaveLength(0);
    expectUnjoined();
  });

  it('revocation invalidates the invitation and every outstanding confirmation', async () => {
    const { invitation, token } = await create();
    const confirmationToken = await confirm(token);
    expect((await call({ action: 'revoke', invitationId: invitation.id }, ownerJwt)).status).toBe(200);
    for (const body of [{ action: 'preview', inviteToken: token }, { action: 'confirmation_preview', confirmationToken }])
      expect((await call(body)).status).toBeGreaterThanOrEqual(400);
    expect((await accept(confirmationToken)).status).toBeGreaterThanOrEqual(400);
    const list = await call({ action: 'list' }, ownerJwt);
    expect(list.body.invitations?.find(item => item.id === invitation.id)?.status).toBe('revoked');
    expectUnjoined();
  });

  it('replays revocation idempotently without changing its original revocation time', async () => {
    const { invitation } = await create();
    expect((await call({ action: 'revoke', invitationId: invitation.id }, ownerJwt)).status).toBe(200);
    const original = fixture.row('SELECT revoked_at FROM member_invitations WHERE id=?', invitation.id).revoked_at;
    expect((await call({ action: 'revoke', invitationId: invitation.id }, ownerJwt)).status).toBe(200);
    expect(fixture.row('SELECT revoked_at FROM member_invitations WHERE id=?', invitation.id).revoked_at).toBe(original);
  });

  it('rejects expired invitations and confirmations without consuming anything', async () => {
    const { invitation, token } = await create();
    const confirmationToken = await confirm(token);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
    expect((await accept(confirmationToken)).status).toBeGreaterThanOrEqual(400);
    expect((await call({ action: 'preview', inviteToken: token })).status).toBe(200);
    vi.setSystemTime(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    expect((await call({ action: 'preview', inviteToken: token })).status).toBeGreaterThanOrEqual(400);
    const list = await call({ action: 'list' }, await fixture.jwt());
    expect(list.body.invitations?.find(item => item.id === invitation.id)?.status).toBe('expired');
    expectUnjoined();
  });

  it.each(['member', 'auth'])('refuses an existing %s email without changing or adopting that identity', async kind => {
    const { token } = await create();
    if (kind === 'auth') fixture.exec("INSERT INTO auth_users(id,email,password_hash,banned) VALUES('orphan','existing@example.com','preserve-original-hash',1)");
    else fixture.exec("INSERT INTO members(workspace_id,id,name,avatar,email,role,is_active) VALUES('a','unlinked','Example Existing','','existing@example.com','member',0)");
    const before = JSON.stringify(fixture.rows(kind === 'auth' ? 'SELECT * FROM auth_users' : 'SELECT * FROM members'));
    const reply = await call({ action: 'request_confirmation', inviteToken: token, name: 'Replacement', email: 'EXISTING@EXAMPLE.COM' });
    expect(reply.status).toBe(409);
    expect(errorCode(reply)).toBe('email_taken');
    expect(JSON.stringify(fixture.rows(kind === 'auth' ? 'SELECT * FROM auth_users' : 'SELECT * FROM members'))).toBe(before);
    expect(mail).toHaveLength(0);
    expect(fixture.count('auth_refresh_tokens')).toBe(0);
  });

  it('preserves another workspace member and rolls back a global email collision at accept', async () => {
    const { invitation, token } = await create();
    fixture.exec("INSERT INTO members(workspace_id,id,name,avatar,email,role,is_active) VALUES('b','unlinked','Example Existing','','existing@example.com','member',0)");
    const existingBefore = JSON.stringify(fixture.row("SELECT * FROM members WHERE workspace_id='b' AND id='unlinked'"));
    const confirmationToken = await confirm(token, 'EXISTING@EXAMPLE.COM');
    expect(mail[0].to).toEqual(['existing@example.com']);
    const preview = await call({ action: 'confirmation_preview', confirmationToken });
    expect(preview.status).toBe(200);
    expect(preview.body.workspaceName).toBe('Example Team');
    expect(JSON.stringify(preview.body).includes('Example Existing')).toBe(false);
    const reply = await accept(confirmationToken);
    expect(reply.status).toBe(409);
    expect(errorCode(reply)).toBe('email_taken');
    expect(fixture.count('auth_users')).toBe(4);
    expect(fixture.count('members')).toBe(5);
    expect(fixture.count('auth_refresh_tokens')).toBe(0);
    expect(JSON.stringify(fixture.row("SELECT * FROM members WHERE workspace_id='b' AND id='unlinked'"))).toBe(existingBefore);
    expect(fixture.row('SELECT used_at FROM member_invitations WHERE id=?', invitation.id).used_at).toBeNull();
    expect(fixture.rows('SELECT used_at FROM member_invitation_confirmations').every(row => row.used_at === null)).toBe(true);
    expect((await call({ action: 'preview', inviteToken: token })).status).toBe(200);
    expect((await call({ action: 'confirmation_preview', confirmationToken })).status).toBe(200);
  });

  it('rolls back both token claims when email is taken after confirmation', async () => {
    const { invitation, token } = await create();
    const confirmationToken = await confirm(token);
    fixture.exec("INSERT INTO auth_users(id,email,password_hash,banned) VALUES('orphan','new@example.com','preserve-original-hash',1)");
    const reply = await accept(confirmationToken);
    expect(reply.status).toBe(409);
    expect(errorCode(reply)).toBe('email_taken');
    expect(fixture.row("SELECT * FROM auth_users WHERE id='orphan'")).toMatchObject({ password_hash: 'preserve-original-hash', banned: 1 });
    expect(fixture.count('members')).toBe(4);
    expect(fixture.count('auth_refresh_tokens')).toBe(0);
    expect(fixture.row('SELECT used_at FROM member_invitations WHERE id=?', invitation.id).used_at).toBeNull();
    expect(fixture.rows('SELECT used_at FROM member_invitation_confirmations').every(row => row.used_at === null)).toBe(true);
  });

  it('allocates the last workspace seat to only one concurrent invitation', async () => {
    fixture.exec("UPDATE workspaces SET member_limit=4 WHERE id='a'");
    const firstInvite = await create(), secondInvite = await create();
    const first = await confirm(firstInvite.token, 'first@example.com');
    const second = await confirm(secondInvite.token, 'second@example.com');
    const replies = await Promise.all([accept(first), accept(second)]);
    expect(replies.filter(reply => reply.status === 200)).toHaveLength(1);
    expect(replies.filter(reply => errorCode(reply) === 'member_limit')).toHaveLength(1);
    expect(fixture.rows("SELECT id FROM members WHERE workspace_id='a' AND is_active=1")).toHaveLength(4);
    expect(fixture.count('auth_users')).toBe(5);
    expect(fixture.count('auth_refresh_tokens')).toBe(1);
    expect(fixture.rows('SELECT used_at FROM member_invitations').filter(row => row.used_at !== null)).toHaveLength(1);
  });

  it('rechecks capacity inside the accept transaction after a competing member joins', async () => {
    fixture.exec("UPDATE workspaces SET member_limit=4 WHERE id='a'");
    const { invitation, token } = await create();
    const confirmationToken = await confirm(token);
    fixture.beforeNextStatement = { match: /UPDATE member_invitations AS i SET used_at/, run: async () => fixture.exec("INSERT INTO members(workspace_id,id,name,avatar,email,role,is_active) VALUES('a','competitor','Example Competitor','','competitor@example.com','member',1)") };
    const reply = await accept(confirmationToken);
    expect(reply.status).toBe(409);
    expect(errorCode(reply)).toBe('member_limit');
    expect(fixture.count('auth_users')).toBe(4);
    expect(fixture.count('auth_refresh_tokens')).toBe(0);
    expect(fixture.row('SELECT used_at FROM member_invitations WHERE id=?', invitation.id).used_at).toBeNull();
    expect(fixture.row("SELECT id FROM members WHERE email='new@example.com'")).toBeNull();
  });

  it('rejects a workspace suspended immediately before the accept transaction', async () => {
    const { invitation, token } = await create();
    const confirmationToken = await confirm(token);
    fixture.beforeNextStatement = { match: /UPDATE member_invitations AS i SET used_at/, run: async () => fixture.exec("UPDATE workspaces SET status='suspended' WHERE id='a'") };
    expect((await accept(confirmationToken)).status).toBeGreaterThanOrEqual(400);
    expectUnjoined();
    expect(fixture.row('SELECT used_at FROM member_invitations WHERE id=?', invitation.id).used_at).toBeNull();
  });

  it.each(['inactive', 'downgraded', 'banned', 'relinked'])('rechecks %s issuer authorization inside the claim transaction', async change => {
    const { invitation, token } = await create({ role: 'admin' });
    const confirmationToken = await confirm(token);
    const sql = {
      inactive: "UPDATE members SET is_active=0 WHERE workspace_id='a' AND id='owner'",
      downgraded: "UPDATE members SET role='admin' WHERE workspace_id='a' AND id='owner'",
      banned: "UPDATE auth_users SET banned=1 WHERE id='login-owner'",
      relinked: "UPDATE members SET auth_id='distinct-replacement-login' WHERE workspace_id='a' AND id='owner'",
    }[change];
    fixture.beforeNextStatement = { match: /UPDATE member_invitations AS i SET used_at/, run: async () => fixture.exec(sql) };
    expect((await accept(confirmationToken)).status).toBeGreaterThanOrEqual(400);
    expectUnjoined();
    expect(fixture.row('SELECT used_at FROM member_invitations WHERE id=?', invitation.id).used_at).toBeNull();
  });

  it('does not consume tokens or leave an account when member insertion fails late', async () => {
    const { invitation, token } = await create();
    const confirmationToken = await confirm(token);
    fixture.exec("CREATE TRIGGER injected_invitation_failure BEFORE INSERT ON members WHEN NEW.email='new@example.com' BEGIN SELECT RAISE(ABORT,'synthetic_member_insert_failure'); END");
    expect((await accept(confirmationToken)).status).toBeGreaterThanOrEqual(400);
    expectUnjoined();
    expect(fixture.row('SELECT used_at FROM member_invitations WHERE id=?', invitation.id).used_at).toBeNull();
    expect(fixture.rows('SELECT used_at FROM member_invitation_confirmations').every(row => row.used_at === null)).toBe(true);
    fixture.exec('DROP TRIGGER injected_invitation_failure');
    expect((await accept(confirmationToken)).status).toBe(200);
  });

  it('rolls back the entire join when the final session insertion fails', async () => {
    const { invitation, token } = await create();
    const confirmationToken = await confirm(token);
    fixture.exec("CREATE TRIGGER injected_session_failure BEFORE INSERT ON auth_refresh_tokens BEGIN SELECT RAISE(ABORT,'synthetic_session_insert_failure'); END");
    expect((await accept(confirmationToken)).status).toBeGreaterThanOrEqual(400);
    expectUnjoined();
    expect(fixture.row('SELECT used_at FROM member_invitations WHERE id=?', invitation.id).used_at).toBeNull();
    expect(fixture.rows('SELECT used_at FROM member_invitation_confirmations').every(row => row.used_at === null)).toBe(true);
    fixture.exec('DROP TRIGGER injected_session_failure');
    expect((await accept(confirmationToken)).status).toBe(200);
  });

  it('validates password byte limits without consuming the verified invitation', async () => {
    const { token } = await create();
    const confirmationToken = await confirm(token);
    for (const password of ['1234567', 'é'.repeat(37)]) {
      const reply = await accept(confirmationToken, { password });
      expect(reply.status).toBe(400);
      expect(errorCode(reply)).toBe('password_invalid');
      expectUnjoined();
    }
    expect((await accept(confirmationToken)).status).toBe(200);
  });

  it('guards the last seat against a manual create that already passed its quota preflight', async () => {
    fixture.exec("UPDATE workspaces SET member_limit=4 WHERE id='a'");
    const { invitation, token } = await create();
    const confirmationToken = await confirm(token);
    let winner: Reply;
    fixture.beforeNextStatement = { match: /INSERT INTO members/i, run: async () => { winner = await accept(confirmationToken); } };
    const loser = await manage({ action: 'create', name: 'Example Manual', email: 'manual@example.com', password: 'synthetic-valid-password' });
    expect(winner.status).toBe(200);
    expect(loser.status).toBe(403);
    expect(errorCode(loser)).toBe('member_limit');
    expect(JSON.stringify(loser.body).includes('invitation_member_limit')).toBe(false);
    expect(fixture.rows("SELECT id FROM members WHERE workspace_id='a' AND is_active=1")).toHaveLength(4);
    expect(fixture.count('auth_users')).toBe(5);
    expect(fixture.row("SELECT id FROM auth_users WHERE email='manual@example.com'")).toBeNull();
    expect(fixture.row("SELECT id FROM members WHERE email='manual@example.com'")).toBeNull();
    expect(fixture.row('SELECT used_at FROM member_invitations WHERE id=?', invitation.id).used_at !== null).toBe(true);
    expect(fixture.count('auth_refresh_tokens')).toBe(1);
  });

  it('keeps invitation proofs reusable when a manual create occupies the last seat first', async () => {
    fixture.exec("UPDATE workspaces SET member_limit=4 WHERE id='a'");
    const { invitation, token } = await create();
    const confirmationToken = await confirm(token);
    expect((await manage({ action: 'create', name: 'Example Manual', email: 'manual@example.com', password: 'synthetic-valid-password' })).status).toBe(200);
    const loser = await accept(confirmationToken);
    expect(loser.status).toBe(409);
    expect(errorCode(loser)).toBe('member_limit');
    expect(fixture.count('auth_users')).toBe(5);
    expect(fixture.count('auth_refresh_tokens')).toBe(0);
    expect(fixture.row("SELECT id FROM auth_users WHERE email='new@example.com'")).toBeNull();
    expect(fixture.row('SELECT used_at FROM member_invitations WHERE id=?', invitation.id).used_at).toBeNull();
    expect(fixture.rows('SELECT used_at FROM member_invitation_confirmations').every(row => row.used_at === null)).toBe(true);
    expect((await call({ action: 'confirmation_preview', confirmationToken })).status).toBe(200);
  });

  it('preserves an existing unlinked login adopted by another member before atomic manual creation', async () => {
    fixture.exec("INSERT INTO auth_users(id,email,password_hash,banned) VALUES('login-existing-manual','manual@example.com','preserve-existing-hash',0)");
    fixture.beforeNextStatement = { match: /INSERT INTO members/i, run: async () => {
      fixture.exec(`INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id,is_active)
        SELECT 'b','external-adopted','Example Adopted','','manual@example.com','member',id,1
        FROM auth_users WHERE email='manual@example.com'`);
    } };
    const reply = await manage({ action: 'create', name: 'Example Manual', email: 'manual@example.com', password: 'synthetic-valid-password' });
    expect(reply.status).toBe(409);
    expect(errorCode(reply)).toBe('email_taken');
    const preserved = fixture.row("SELECT id,password_hash,banned FROM auth_users WHERE email='manual@example.com'");
    expect(Boolean(preserved)).toBe(true);
    expect(preserved.banned).toBe(0);
    expect(preserved.password_hash).toBe('preserve-existing-hash');
    expect(fixture.row("SELECT auth_id FROM members WHERE workspace_id='b' AND id='external-adopted'").auth_id).toBe(preserved.id);
    expect(fixture.rows("SELECT id FROM members WHERE workspace_id='a' AND email='manual@example.com'")).toHaveLength(0);
    expect(fixture.count('auth_users')).toBe(5);
    expect(fixture.count('auth_refresh_tokens')).toBe(0);
  });

  it('guards the last seat against Jira import after the import quota preflight', async () => {
    await fixture.enableJiraImport();
    fixture.exec("UPDATE workspaces SET member_limit=4 WHERE id='a'");
    const { token } = await create();
    const confirmationToken = await confirm(token);
    let winner: Reply;
    fixture.beforeNextStatement = { match: /INSERT INTO members/i, run: async () => { winner = await accept(confirmationToken); } };
    const loser = await importExamplePerson();
    expect(winner.status).toBe(200);
    expect(loser.status).toBe(403);
    expect(errorCode(loser)).toBe('member_limit');
    expect(loser.body.error).toBe('import_failed');
    expect(loser.body.partial).toEqual({ tasksInserted: 0, commentsInserted: 0, specsInserted: 0 });
    expect(loser.body.message?.includes('已清除')).toBe(true);
    expect(JSON.stringify(loser.body).includes('invitation_member_limit')).toBe(false);
    expect(fixture.rows("SELECT id FROM members WHERE workspace_id='a' AND is_active=1")).toHaveLength(4);
    expect(fixture.row("SELECT id FROM members WHERE name='Example Imported'")).toBeNull();
    expect(fixture.count('auth_users')).toBe(5);
    expect(fixture.count('auth_refresh_tokens')).toBe(1);
    expect(fixture.count('tasks')).toBe(0);
  });

  it('rejects an invitation when a Jira name-only member takes the last seat first', async () => {
    await fixture.enableJiraImport();
    fixture.exec("UPDATE workspaces SET member_limit=4 WHERE id='a'");
    const { invitation, token } = await create();
    const confirmationToken = await confirm(token);
    expect((await importExamplePerson()).status).toBe(200);
    const loser = await accept(confirmationToken);
    expect(loser.status).toBe(409);
    expect(errorCode(loser)).toBe('member_limit');
    expect(fixture.row("SELECT auth_id FROM members WHERE name='Example Imported'").auth_id).toBeNull();
    expect(fixture.count('auth_users')).toBe(4);
    expect(fixture.count('auth_refresh_tokens')).toBe(0);
    expect(fixture.count('tasks')).toBe(1);
    expect(fixture.row('SELECT used_at FROM member_invitations WHERE id=?', invitation.id).used_at).toBeNull();
    expect(fixture.rows('SELECT used_at FROM member_invitation_confirmations').every(row => row.used_at === null)).toBe(true);
  });

  it('rolls back a Jira login creation at capacity without falling back to another active member', async () => {
    await fixture.enableJiraImport();
    fixture.exec("UPDATE workspaces SET member_limit=4 WHERE id='a'");
    const { token } = await create();
    const confirmationToken = await confirm(token);
    let winner: Reply;
    fixture.beforeNextStatement = { match: /INSERT INTO members/i, run: async () => { winner = await accept(confirmationToken); } };
    const loser = await importExamplePerson([{ name: 'Example Imported', email: 'imported@example.com' }]);
    expect(winner.status).toBe(200);
    expect(loser.status).toBe(403);
    expect(errorCode(loser)).toBe('member_limit');
    expect(loser.body.error).toBe('import_failed');
    expect(loser.body.partial).toEqual({ tasksInserted: 0, commentsInserted: 0, specsInserted: 0 });
    expect(loser.body.message?.includes('已清除')).toBe(true);
    expect(JSON.stringify(loser.body).includes('invitation_member_limit')).toBe(false);
    expect(fixture.rows("SELECT id FROM members WHERE workspace_id='a' AND is_active=1")).toHaveLength(4);
    expect(fixture.row("SELECT id FROM members WHERE name='Example Imported'")).toBeNull();
    expect(fixture.row("SELECT id FROM auth_users WHERE email='imported@example.com'")).toBeNull();
    expect(fixture.count('auth_users')).toBe(5);
    expect(fixture.count('auth_refresh_tokens')).toBe(1);
    expect(fixture.count('tasks')).toBe(0);
    expect(mail).toHaveLength(1);
  });

  it('blocks concurrent reactivation after an invitation consumes the last seat and keeps login banned', async () => {
    prepareInactive();
    fixture.exec("UPDATE workspaces SET member_limit=4 WHERE id='a'");
    const { token } = await create();
    const confirmationToken = await confirm(token);
    let winner: Reply;
    fixture.beforeNextStatement = { match: /UPDATE members SET is_active/i, run: async () => { winner = await accept(confirmationToken); } };
    const loser = await manage({ action: 'toggle_active', memberId: 'inactive', isActive: true });
    expect(winner.status).toBe(200);
    expect(loser.status).toBe(403);
    expect(errorCode(loser)).toBe('member_limit');
    expect(JSON.stringify(loser.body).includes('invitation_member_limit')).toBe(false);
    expect(fixture.row("SELECT is_active,auth_id FROM members WHERE id='inactive'")).toMatchObject({ is_active: 0, auth_id: 'login-inactive' });
    expect(fixture.row("SELECT banned,password_hash FROM auth_users WHERE id='login-inactive'")).toMatchObject({ banned: 1, password_hash: 'preserve-inactive-hash' });
    expect(fixture.rows("SELECT id FROM members WHERE workspace_id='a' AND is_active=1")).toHaveLength(4);
    expect(fixture.count('auth_users')).toBe(6);
    expect(fixture.count('auth_refresh_tokens')).toBe(1);
  });

  it('rejects invitation accept after reactivation occupies the last seat first', async () => {
    prepareInactive();
    fixture.exec("UPDATE workspaces SET member_limit=4 WHERE id='a'");
    const { invitation, token } = await create();
    const confirmationToken = await confirm(token);
    expect((await manage({ action: 'toggle_active', memberId: 'inactive', isActive: true })).status).toBe(200);
    expect(fixture.row("SELECT banned FROM auth_users WHERE id='login-inactive'").banned).toBe(0);
    expect((await accept(confirmationToken)).status).toBe(409);
    expect(fixture.count('auth_users')).toBe(5);
    expect(fixture.count('auth_refresh_tokens')).toBe(0);
    expect(fixture.row('SELECT used_at FROM member_invitations WHERE id=?', invitation.id).used_at).toBeNull();
    expect(fixture.rows('SELECT used_at FROM member_invitation_confirmations').every(row => row.used_at === null)).toBe(true);
  });

  it('maps generic member reactivation beyond capacity to a readable member_limit error', async () => {
    prepareInactive();
    fixture.exec("UPDATE workspaces SET member_limit=3 WHERE id='a'");
    const reply = await fixture.query({ table: 'members', op: 'update', values: { is_active: true }, filters: [{ col: 'id', op: 'eq', val: 'inactive' }] });
    expect(reply.data).toBeNull();
    expect(reply.error?.message?.includes('invitation_member_limit')).toBe(false);
    expect(reply.error?.code).toBe('member_limit');
    expect(fixture.row("SELECT is_active FROM members WHERE id='inactive'").is_active).toBe(0);
    expect(fixture.row("SELECT banned FROM auth_users WHERE id='login-inactive'").banned).toBe(1);
    expect(fixture.count('auth_users')).toBe(5);
    expect(fixture.count('members')).toBe(5);
    expect(fixture.count('auth_refresh_tokens')).toBe(0);
  });

  it('allows idempotent seed inserts and upserts when the workspace is full', async () => {
    fixture.exec("UPDATE workspaces SET member_limit=3 WHERE id='a'");
    const before = JSON.stringify(fixture.rows('SELECT * FROM members ORDER BY id'));
    fixture.exec(`INSERT OR IGNORE INTO members(workspace_id,id,name,avatar,email,role,auth_id,is_active)
      VALUES('a','owner','Example Owner','','owner@example.com','super_admin','login-owner',1);
      INSERT INTO members(workspace_id,id,name,avatar,email,role,auth_id,is_active)
      VALUES('a','owner','Example Owner','','owner@example.com','super_admin','login-owner',1)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,is_active=excluded.is_active;`);
    expect(JSON.stringify(fixture.rows('SELECT * FROM members ORDER BY id'))).toBe(before);
    expectUnjoined();
  });

  it('keeps existing over-limit membership intact when schema is reapplied', async () => {
    fixture.exec("UPDATE workspaces SET member_limit=2 WHERE id='a'");
    const before = JSON.stringify(fixture.rows('SELECT * FROM members ORDER BY id'));
    fixture.reapplySchema();
    fixture.exec("UPDATE members SET is_active=1 WHERE workspace_id='a' AND id='owner'");
    fixture.exec("INSERT OR IGNORE INTO members(workspace_id,id,name,avatar,email,role,is_active) VALUES('a','owner','Ignored','','owner@example.com','member',1)");
    expect(JSON.stringify(fixture.rows('SELECT * FROM members ORDER BY id'))).toBe(before);
    expect(() => fixture.exec("INSERT INTO members(workspace_id,id,name,avatar,email,role,is_active) VALUES('a','extra','Example Extra','','extra@example.com','member',1)")).toThrow('invitation_member_limit');
    expect(JSON.stringify(fixture.rows('SELECT * FROM members ORDER BY id'))).toBe(before);
  });

  it('permits inactive additions at capacity while guarding inactive-to-active upserts', async () => {
    fixture.exec("UPDATE workspaces SET member_limit=3 WHERE id='a'");
    fixture.exec("INSERT INTO members(workspace_id,id,name,avatar,email,role,is_active) VALUES('a','inactive-extra','Example Inactive','','inactive-extra@example.com','member',0)");
    expect(() => fixture.exec("INSERT INTO members(workspace_id,id,name,avatar,email,role,is_active) VALUES('a','inactive-extra','Example Inactive','','inactive-extra@example.com','member',1) ON CONFLICT(id) DO UPDATE SET is_active=excluded.is_active")).toThrow('invitation_member_limit');
    expect(fixture.row("SELECT is_active FROM members WHERE id='inactive-extra'").is_active).toBe(0);
    expect(fixture.rows("SELECT id FROM members WHERE workspace_id='a' AND is_active=1")).toHaveLength(3);
  });

  it('leaves the legacy default workspace unlimited without a workspaces quota row', async () => {
    for (let i = 0; i < 12; i++) fixture.exec(`INSERT INTO members(workspace_id,id,name,avatar,email,role,is_active)
      VALUES('default','default-example-${i}','Example Legacy','','default-example-${i}@example.com','member',1)`);
    expect(fixture.rows("SELECT id FROM members WHERE workspace_id='default' AND is_active=1")).toHaveLength(12);
  });
});
