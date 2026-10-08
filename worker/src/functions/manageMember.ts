// Port of the manage-member Edge Function (supabase/functions/manage-member).
// Route: POST /api/functions/manage-member (requireMember already ran).
// Actions: create / toggle_active / delete / reset_password / create_login —
// operate directly on D1 (auth_users replaces GoTrue). Response shapes and
// status codes mirror the original function exactly.

import type { Context } from 'hono';
import type { AppContext } from '../env';
import { DEFAULT_WORKSPACE } from '../env';
import type { ChangeEvent } from '../protocol';
import { TABLES } from '../tables';
import { rowToWire, valueToDb, nowIso, type TableMeta } from '../meta';
import { notifyChanges } from '../notify';
import { hashPassword, clearMemberCache } from '../auth';
import { API_KEY_FORBIDDEN, deliverLogin, isApiKeyCaller, LoginError, prepareLogin, resolveLoginChannel } from '../memberLogin';
import { isPlaceholderEmail, isValidEmail, normalizeEmail } from './jiraCsv';
import { isMemberLimitError, memberLimitFailure } from '../memberQuota';

const ADMIN_ROLES = ['admin', 'super_admin'];

/** Caller's tenancy scope — every lookup/insert below is bound to it. */
const callerWs = (c: Context<AppContext>): string =>
  c.get('auth')?.member?.workspaceId || DEFAULT_WORKSPACE;

const FALLBACK_META: TableMeta = { pk: 'id', clientAccess: 'full' };
const membersMeta = (): TableMeta => TABLES['members'] ?? FALLBACK_META;

interface ManageMemberBody {
  action?: string;
  // create
  email?: string;
  name?: string;
  role?: string;
  qaAdmin?: boolean;
  jobTitle?: string;
  avatar?: string;
  color?: string;
  password?: string;
  // toggle_active / delete / reset_password / create_login
  memberId?: string;
  isActive?: boolean;
  newPassword?: string;
}

export const handleManageMember = async (c: Context<AppContext>): Promise<Response> => {
  let auth = c.get('auth');
  const live = await c.env.DB.prepare('SELECT role,is_active FROM members WHERE workspace_id=? AND id=?')
    .bind(callerWs(c),auth.member.id).first<{role:string;is_active:number}>();
  if (!live?.is_active) return c.json({ error: 'Permission denied: active administrator required' }, 403);
  auth = { ...auth, member: { ...auth.member, role: live.role } };
  c.set('auth',auth);
  if (!ADMIN_ROLES.includes(auth.member.role)) {
    return c.json({ error: 'Permission denied: admin role required' }, 403);
  }

  try {
    const body = (await c.req.json()) as ManageMemberBody;
    const action = body.action;
    // Deactivating or deleting a member removes their login too, so it is a
    // super_admin action, as in the app. An admin could otherwise lock out a
    // super_admin.
    if (auth.member.role !== 'super_admin' && (action === 'reset_password' || action === 'create_login' || action === 'toggle_active' || action === 'delete')) {
      return c.json({ error: 'Permission denied: only super_admin can manage another member login' }, 403);
    }
    if (action === 'create') {
      if (body.qaAdmin !== undefined && typeof body.qaAdmin !== 'boolean') return c.json({ error: 'invalid QA capability' },400);
      if (body.role && !['member','admin','super_admin'].includes(body.role)) return c.json({ error: 'invalid role' },400);
      if (body.jobTitle !== undefined && (typeof body.jobTitle !== 'string' || body.jobTitle.length > 200)) return c.json({ error: 'job_title must be at most 200 characters' },400);
      if (auth.member.role !== 'super_admin' && ((body.jobTitle || '').trim() || (body.role && body.role !== 'member') || body.qaAdmin === true)) {
        return c.json({ error: 'Permission denied: only super_admin can assign positions or administrative roles' },403);
      }
    }

    // An API key may manage members but never set a password or open a login:
    // a leaked key must not become an account takeover. (create without a
    // password only gets an unusable random one.)
    if (
      isApiKeyCaller(auth) &&
      (action === 'reset_password' || action === 'create_login' || (action === 'create' && !!body.password))
    ) {
      return c.json(API_KEY_FORBIDDEN, 403);
    }

    if (action === 'create') return await createMember(c, body);
    if (action === 'toggle_active') return await toggleActive(c, body);
    if (action === 'delete') return await deleteMember(c, body);
    if (action === 'reset_password') return await resetPassword(c, body);
    if (action === 'create_login') return await createLogin(c, body);

    return c.json({ error: 'Unknown action' }, 400);
  } catch (err) {
    if (isMemberLimitError(err)) return c.json(await memberLimitFailure(c.env, callerWs(c)), 403);
    return c.json({ error: String(err) }, 500);
  }
};

// ── reset_password ────────────────────────────────────────────────────────
// Admin sets a member's login password (onboarding / forgot-password on a
// self-host install with no email service). Escalation rule: only a
// super_admin may reset an admin's or super_admin's password.

async function resetPassword(c: Context<AppContext>, body: ManageMemberBody): Promise<Response> {
  const env = c.env;
  const auth = c.get('auth');
  const memberId = String(body.memberId ?? '');
  const newPassword = String(body.newPassword ?? '');
  if (!memberId) return c.json({ error: 'memberId is required' }, 400);
  if (newPassword.length < 8) {
    return c.json({ error: 'password_too_short', message: '密碼至少需要 8 碼' }, 400);
  }

  const member = await env.DB
    .prepare('SELECT id, email, role, auth_id FROM members WHERE id = ?1 AND workspace_id = ?2')
    .bind(memberId, callerWs(c))
    .first<{ id: string; email: string | null; role: string | null; auth_id: string | null }>();
  if (!member) return c.json({ error: 'Member not found' }, 404);
  // Imported people carry a placeholder (uN@import.invalid): a password on
  // that address would be a login nobody can use — 「啟用帳號」 sets the email.
  if (isPlaceholderEmail(member.email)) {
    return c.json({ error: 'member_has_no_email', message: '此成員還沒有 Email，請先用「啟用帳號」設定' }, 400);
  }

  if (ADMIN_ROLES.includes(member.role || '') && auth.member.role !== 'super_admin') {
    return c.json({ error: 'Permission denied: only super_admin can reset an admin password' }, 403);
  }

  const passwordHash = await hashPassword(newPassword);
  // Resolve the login by email only. members.auth_id is admin-writable via
  // /api/query, so matching on it would let a workspace admin point a member
  // at another workspace's login and overwrite that password. members.email
  // is globally unique, so the email identifies exactly one person.
  const existingAuth = await env.DB
    .prepare('SELECT id FROM auth_users WHERE email = ?1 COLLATE NOCASE LIMIT 1')
    .bind(member.email)
    .first<{ id: string }>();

  if (existingAuth) {
    await env.DB
      .prepare('UPDATE auth_users SET password_hash = ?1 WHERE id = ?2')
      .bind(passwordHash, existingAuth.id)
      .run();
    // Revoke every session for that user — a reset must lock out whoever held
    // the old credentials.
    await env.DB
      .prepare('DELETE FROM auth_refresh_tokens WHERE user_id = ?1')
      .bind(existingAuth.id)
      .run();
    clearMemberCache(existingAuth.id);
  } else {
    // Member never had a login (e.g. imported from Jira) — resetting heals it.
    const authUserId = crypto.randomUUID();
    await env.DB
      .prepare('INSERT INTO auth_users (id, email, password_hash, banned, created_at) VALUES (?1, ?2, ?3, 0, ?4)')
      .bind(authUserId, (member.email || '').toLowerCase(), passwordHash, nowIso())
      .run();
    await env.DB
      .prepare('UPDATE members SET auth_id = ?1 WHERE id = ?2 AND workspace_id = ?3')
      .bind(authUserId, member.id, callerWs(c))
      .run();
  }

  return c.json({ success: true });
}

// ── create_login (「啟用帳號」) ───────────────────────────────────────────
// Gives a member that only has a name (Jira import) a real email and a login.
// The member row keeps its id, so its tasks, comments and reviews stay as
// they are. The person gets a set-password invitation when email sending is
// configured, otherwise a one-time temporary password shown to the admin.

async function createLogin(c: Context<AppContext>, body: ManageMemberBody): Promise<Response> {
  const env = c.env;
  const ws = callerWs(c);
  const auth = c.get('auth');
  const memberId = String(body.memberId ?? '');
  const email = normalizeEmail(body.email);
  if (!memberId) return c.json({ error: 'memberId is required' }, 400);
  if (!isValidEmail(email)) return c.json({ error: 'invalid_email', message: 'Email 格式不正確' }, 400);

  const member = await env.DB
    .prepare('SELECT id, name, email, role, is_active FROM members WHERE id = ?1 AND workspace_id = ?2')
    .bind(memberId, ws)
    .first<{ id: string; name: string; email: string | null; role: string | null; is_active: number | null }>();
  if (!member) return c.json({ error: 'Member not found' }, 404);
  if (!member.is_active) {
    return c.json({ error: 'member_inactive', message: '此成員已停用，請先啟用成員再建立登入帳號' }, 400);
  }
  if (!isPlaceholderEmail(member.email)) {
    return c.json({ error: 'already_has_login', message: '此成員已有 Email，請改用「重設密碼」' }, 409);
  }
  // Same escalation rule as reset_password: whoever creates the login learns
  // (or chooses) its password.
  if (ADMIN_ROLES.includes(member.role || '') && auth.member.role !== 'super_admin') {
    return c.json({ error: 'requires_super_admin', message: '只有超級管理員可以為管理員建立登入帳號' }, 403);
  }

  // members.email is unique across workspaces (requireMember heals logins by
  // email), so this lookup is deliberately global; another workspace's member
  // is reported without any detail.
  const owner = await env.DB
    .prepare('SELECT id, name, workspace_id FROM members WHERE email = ?1 COLLATE NOCASE LIMIT 1')
    .bind(email)
    .first<{ id: string; name: string; workspace_id: string | null }>();
  if (owner) {
    const sameWs = (owner.workspace_id || DEFAULT_WORKSPACE) === ws;
    return c.json(
      sameWs
        ? { error: 'email_taken', message: `此 Email 已是成員「${owner.name}」的帳號`, memberName: owner.name }
        : { error: 'email_in_other_workspace', message: '此 Email 已在其他 LIVO 團隊使用，請改用其他 Email' },
      409
    );
  }

  const channel = await resolveLoginChannel(env, ws);
  let login;
  try {
    login = await prepareLogin(env, email, channel.method);
  } catch (err) {
    if (err instanceof LoginError) return c.json({ error: err.code, message: err.message }, 409);
    throw err;
  }

  const meta = membersMeta();
  let updated: Record<string, unknown> | null = null;
  try {
    const results = await env.DB.batch([
      ...login.statements,
      env.DB
        .prepare('UPDATE members SET email = ?1, auth_id = ?2 WHERE id = ?3 AND workspace_id = ?4 RETURNING *')
        .bind(email, login.authUserId, member.id, ws),
    ]);
    const last = results[results.length - 1];
    updated = ((last && (last.results as Record<string, unknown>[])[0]) || null);
  } catch (err) {
    // UNIQUE(email) lost a race with another request: same answer as above.
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE/i.test(msg)) return c.json({ error: 'email_taken', message: '此 Email 已被使用' }, 409);
    throw err;
  }
  clearMemberCache(login.authUserId);

  const delivery = await deliverLogin(env, channel, login, {
    name: member.name,
    email,
    invitedBy: auth.member.name,
  });

  if (updated) {
    const event: ChangeEvent = {
      table: 'members',
      eventType: 'UPDATE',
      new: rowToWire(updated, meta),
      old: { id: member.id },
    };
    notifyChanges(env, c.executionCtx, [event], ws);
  }

  return c.json({
    success: true,
    memberId: member.id,
    email,
    method: delivery.method,
    ...(delivery.tempPassword ? { tempPassword: delivery.tempPassword } : {}),
    ...(delivery.inviteFailed ? { inviteFailed: true } : {}),
  });
}

// ── create ────────────────────────────────────────────────────────────────

async function createMember(c: Context<AppContext>, body: ManageMemberBody): Promise<Response> {
  const env = c.env;
  const ws = callerWs(c);
  const email = String(body.email ?? '').trim();
  const name = String(body.name ?? '');
  if (!email) return c.json({ error: 'email is required' }, 400);

  // Duplicate member check first (avoids orphaning a fresh auth user).
  // members.email is GLOBALLY unique: one email belongs to exactly one
  // workspace (protects the requireMember email-heal) — cross-workspace
  // duplicates get a distinct message.
  const existingMember = await env.DB
    .prepare('SELECT id, workspace_id FROM members WHERE email = ?1 COLLATE NOCASE')
    .bind(email)
    .first<{ id: string; workspace_id: string | null }>();
  if (existingMember) {
    const sameWs = (existingMember.workspace_id || DEFAULT_WORKSPACE) === ws;
    return c.json(
      { error: sameWs ? '此 Email 的成員已存在' : '此 Email 已在其他 LIVO 團隊使用，請改用其他 Email', ...(sameWs ? { code: 'member_exists' } : {}) },
      400
    );
  }

  // Member cap (cloud beta): 'default' has no workspaces row → unlimited.
  if (ws !== DEFAULT_WORKSPACE) {
    const quota = await env.DB
      .prepare(
        `SELECT w.member_limit AS lim,
                (SELECT COUNT(*) FROM members m WHERE m.workspace_id = w.id AND m.is_active = 1) AS used
         FROM workspaces w WHERE w.id = ?1`
      )
      .bind(ws)
      .first<{ lim: number; used: number }>();
    if (quota && quota.used >= quota.lim) {
      return c.json(await memberLimitFailure(env, ws), 403);
    }
  }

  // Find-or-create the auth user (email column is COLLATE NOCASE).
  let authUserId: string;
  const statements: D1PreparedStatement[] = [];
  const existingAuth = await env.DB
    .prepare('SELECT id FROM auth_users WHERE email = ?1')
    .bind(email)
    .first<{ id: string }>();

  if (existingAuth) {
    authUserId = existingAuth.id;
  } else {
    authUserId = crypto.randomUUID();
    // Random long password when none supplied (original: login was OAuth-only).
    const password = body.password || crypto.randomUUID() + crypto.randomUUID() + 'Aa1!';
    const passwordHash = await hashPassword(password);
    statements.push(env.DB
      .prepare(
        'INSERT INTO auth_users (id, email, password_hash, banned, created_at) VALUES (?1, ?2, ?3, 0, ?4)'
      )
      .bind(authUserId, email.toLowerCase(), passwordHash, nowIso()));
  }

  // Member row (same id scheme as the original edge function).
  const memberId = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const meta = membersMeta();
  const row: Record<string, unknown> = {
    workspace_id: ws,
    id: memberId,
    email,
    name,
    role: body.role || 'member',
    is_qa_admin: (!body.role || body.role === 'member') && body.qaAdmin === true,
    job_title: body.jobTitle || '',
    avatar: body.avatar || name.slice(0, 1).toUpperCase(),
    color: body.color || '#6B778C',
    is_active: true,
    auth_id: authUserId,
  };
  for (const col of meta.autoNowCols || []) {
    if (!(col in row)) row[col] = nowIso();
  }

  const cols = Object.keys(row);
  // Both rows commit together: no other request can adopt a provisional auth
  // that would be removed after a quota or email-uniqueness failure. Resolve an
  // existing auth inside the insert too, since members.auth_id has no FK.
  const sql = `INSERT INTO members (${cols.join(', ')}) SELECT ${cols
    .map((_, i) => `?${i + 1}`)
    .join(', ')} WHERE EXISTS(SELECT 1 FROM auth_users WHERE id=?${cols.length + 1}
      AND email=?${cols.length + 2} COLLATE NOCASE) RETURNING *`;

  let inserted: Record<string, unknown> | null = null;
  try {
    statements.push(env.DB.prepare(sql)
      .bind(...cols.map((col) => valueToDb(col, row[col], meta)), authUserId, email));
    const results = await env.DB.batch(statements);
    inserted = (results[results.length - 1]?.results as Record<string, unknown>[] | undefined)?.[0] ?? null;
  } catch (err) {
    if (isMemberLimitError(err)) return c.json(await memberLimitFailure(env, ws), 403);
    if (/UNIQUE.*(?:auth_users|members)\.email/i.test(err instanceof Error ? err.message : String(err))) {
      return c.json({ error: 'email_taken', message: '此 Email 已被使用' }, 409);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
  if (!inserted) {
    return c.json({ error: 'auth_changed', message: '登入帳號已變更，請重新新增成員' }, 409);
  }

  const event: ChangeEvent = {
    table: 'members',
    eventType: 'INSERT',
    new: rowToWire(inserted ?? row, meta),
    old: null,
  };
  notifyChanges(env, c.executionCtx, [event], ws);

  return c.json({ success: true, memberId });
}

// ── toggle_active ─────────────────────────────────────────────────────────

async function toggleActive(c: Context<AppContext>, body: ManageMemberBody): Promise<Response> {
  const env = c.env;
  const ws = callerWs(c);
  const memberId = String(body.memberId ?? '');
  const isActive = body.isActive === true;

  const member = await env.DB
    .prepare('SELECT email FROM members WHERE id = ?1 AND workspace_id = ?2')
    .bind(memberId, ws)
    .first<{ email: string }>();
  if (!member) {
    return c.json({ error: 'Member not found' }, 404);
  }

  const meta = membersMeta();
  const updated = await env.DB
    .prepare('UPDATE members SET is_active = ?1 WHERE id = ?2 AND workspace_id = ?3 RETURNING *')
    .bind(valueToDb('is_active', isActive, meta), memberId, ws)
    .first<Record<string, unknown>>();

  // Ban/unban the auth user (login rejects banned=1).
  if (member.email) {
    await env.DB
      .prepare('UPDATE auth_users SET banned = ?1 WHERE email = ?2')
      .bind(isActive ? 0 : 1, member.email)
      .run();
  }
  // Drop this isolate's requireMember cache so deactivation applies immediately.
  clearMemberCache();

  if (updated) {
    const event: ChangeEvent = {
      table: 'members',
      eventType: 'UPDATE',
      new: rowToWire(updated, meta),
      old: { id: memberId },
    };
    notifyChanges(env, c.executionCtx, [event], ws);
  }

  return c.json({ success: true });
}

// ── delete ────────────────────────────────────────────────────────────────

async function deleteMember(c: Context<AppContext>, body: ManageMemberBody): Promise<Response> {
  const env = c.env;
  const ws = callerWs(c);
  const memberId = String(body.memberId ?? '');

  const member = await env.DB
    .prepare('SELECT * FROM members WHERE id = ?1 AND workspace_id = ?2')
    .bind(memberId, ws)
    .first<Record<string, unknown>>();
  if (!member) {
    return c.json({ error: 'Member not found' }, 404);
  }

  const email = typeof member.email === 'string' ? member.email : '';
  const authUser = email
    ? await env.DB
        .prepare('SELECT id FROM auth_users WHERE email = ?1')
        .bind(email)
        .first<{ id: string }>()
    : null;

  const stmts = [env.DB.prepare('DELETE FROM members WHERE id = ?1').bind(memberId)];
  if (authUser) {
    stmts.push(
      env.DB.prepare('DELETE FROM auth_refresh_tokens WHERE user_id = ?1').bind(authUser.id),
      env.DB.prepare('DELETE FROM auth_users WHERE id = ?1').bind(authUser.id)
    );
  }
  try {
    await env.DB.batch(stmts);
  } catch (err) {
    // Tasks, comments and records keep pointing at the member: deactivating keeps
    // that history and removes the login, deleting cannot.
    if (/FOREIGN KEY/i.test(String(err))) return c.json({ error: 'member_has_history', message: 'This member has tasks, comments or records. Deactivate the member instead.' }, 409);
    throw err;
  }

  const meta = membersMeta();
  const event: ChangeEvent = {
    table: 'members',
    eventType: 'DELETE',
    new: null,
    old: rowToWire(member, meta),
  };
  notifyChanges(env, c.executionCtx, [event], ws);

  return c.json({ success: true });
}
