// Port of the manage-member Edge Function (supabase/functions/manage-member).
// Route: POST /api/functions/manage-member (requireMember already ran).
// Actions: create / toggle_active / delete — operate directly on D1
// (auth_users replaces GoTrue). Response shapes and status codes mirror
// the original function exactly.

import type { Context } from 'hono';
import type { AppContext } from '../env';
import { DEFAULT_WORKSPACE } from '../env';
import type { ChangeEvent } from '../protocol';
import { TABLES } from '../tables';
import { rowToWire, valueToDb, nowIso, type TableMeta } from '../meta';
import { notifyChanges } from '../notify';
import { hashPassword, clearMemberCache } from '../auth';

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
  jobTitle?: string;
  avatar?: string;
  color?: string;
  password?: string;
  // toggle_active / delete / reset_password
  memberId?: string;
  isActive?: boolean;
  newPassword?: string;
}

export const handleManageMember = async (c: Context<AppContext>): Promise<Response> => {
  const auth = c.get('auth');
  if (!ADMIN_ROLES.includes(auth.member.role)) {
    return c.json({ error: 'Permission denied: admin role required' }, 403);
  }

  try {
    const body = (await c.req.json()) as ManageMemberBody;
    const action = body.action;

    if (action === 'create') return await createMember(c, body);
    if (action === 'toggle_active') return await toggleActive(c, body);
    if (action === 'delete') return await deleteMember(c, body);
    if (action === 'reset_password') return await resetPassword(c, body);

    return c.json({ error: 'Unknown action' }, 400);
  } catch (err) {
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
  if (!member.email) return c.json({ error: 'member_has_no_email', message: '此成員沒有 Email，無法設定登入密碼' }, 400);

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
      .bind(authUserId, member.email.toLowerCase(), passwordHash, nowIso())
      .run();
    await env.DB
      .prepare('UPDATE members SET auth_id = ?1 WHERE id = ?2')
      .bind(authUserId, member.id)
      .run();
  }

  return c.json({ success: true });
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
      { error: sameWs ? '此 Email 的成員已存在' : '此 Email 已在其他 LIVO 團隊使用，請改用其他 Email' },
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
      return c.json(
        { error: `成員數已達 Beta 上限（${quota.lim} 人）。需要更多名額請聯繫 service@livo-tw.com` },
        403
      );
    }
  }

  // Find-or-create the auth user (email column is COLLATE NOCASE).
  let authUserId: string;
  let createdAuthUser = false;
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
    await env.DB
      .prepare(
        'INSERT INTO auth_users (id, email, password_hash, banned, created_at) VALUES (?1, ?2, ?3, 0, ?4)'
      )
      .bind(authUserId, email.toLowerCase(), passwordHash, nowIso())
      .run();
    createdAuthUser = true;
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
  const sql = `INSERT INTO members (${cols.join(', ')}) VALUES (${cols
    .map((_, i) => `?${i + 1}`)
    .join(', ')}) RETURNING *`;

  let inserted: Record<string, unknown> | null = null;
  try {
    inserted = await env.DB
      .prepare(sql)
      .bind(...cols.map((col) => valueToDb(col, row[col], meta)))
      .first<Record<string, unknown>>();
  } catch (err) {
    // Roll back the auth user only if we created it here.
    if (createdAuthUser) {
      await env.DB.prepare('DELETE FROM auth_users WHERE id = ?1').bind(authUserId).run()
        .catch(() => { /* best-effort rollback */ });
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
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
  await env.DB.batch(stmts);

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
