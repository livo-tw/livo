// Auth module — Worker-issued HS256 JWTs replacing Supabase GoTrue.
//
// Exports (consumed by index.ts and functions/manageMember.ts):
//   registerAuthRoutes(app)  — /api/auth/login | refresh | logout | user |
//                              set-password (invitation links, setPasswordToken.ts)
//   requireMember            — middleware resolving JWT → active member (RLS parity)
//   verifyAccessToken(env, token)
//   hashPassword(pw)         — pbkdf2 format used for all newly stored passwords
//
// D1 tables (schema.sql):
//   auth_users(id TEXT PK, email TEXT UNIQUE COLLATE NOCASE, password_hash TEXT,
//              banned INTEGER DEFAULT 0, created_at TEXT)
//   auth_refresh_tokens(token_hash TEXT PK, user_id TEXT, expires_at TEXT, created_at TEXT)
//
// password_hash formats:
//   pbkdf2$<iterations>$<saltB64>$<hashB64>   (new; WebCrypto PBKDF2-SHA256)
//   bcrypt$<bcrypt hash>                      (imported from Supabase; verified via
//                                              bcryptjs, transparently re-hashed to
//                                              pbkdf2 on successful login)

import type { Context, Hono, MiddlewareHandler } from 'hono';
import { sign, verify } from 'hono/jwt';
import { compare as bcryptCompare } from 'bcryptjs';
import type { AppContext, Env } from './env';
import { DEFAULT_WORKSPACE, isCloudSignupEnabled, isDemoMember } from './env';
import type { AuthResponse, AuthSession } from './protocol';
import { verifyInviteToken, markWaitlistJoined } from './functions/cloudBeta';
import { workspaceProvisionStatements } from './provision';
import { readSetPasswordToken, setPasswordTokenValid } from './setPasswordToken';

// ─── Constants ────────────────────────────────────────────────────────────

const ACCESS_TOKEN_TTL_S = 3600; // 1 h
const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600; // 30 d
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BYTES = 32; // SHA-256 output size

const INVALID_CREDENTIALS = 'Invalid login credentials'; // EXACT — UI matches this substring
const INVALID_REFRESH = 'Invalid Refresh Token';

// Refresh-token reuse grace: a just-rotated token replayed within this window
// (e.g. a second tab racing the first) is re-issued instead of rejected.
const REFRESH_GRACE_MS = 30_000;

// Decoy hash for the not-found / banned / hashless login paths. A real,
// well-formed pbkdf2 string so verifyPassword reaches the KDF derivation and
// spends comparable work — closes the login timing / user-enumeration oracle.
const DECOY_PASSWORD_HASH = 'pbkdf2$100000$yg0WHFn1Hn8Dnmd3ToMzEQ==$jkyD1jWSCGoeX8P+4fGK2mS90Y4ll+fb5/b1Es1kJNA=';

// ─── Small binary helpers ─────────────────────────────────────────────────

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** SHA-256 hex digest. Exported — apiTokens.ts hashes PATs with the same fn. */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/** Constant-time byte comparison (length leak is fine — lengths are public format info). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ─── Password hashing / verification ─────────────────────────────────────

async function pbkdf2Derive(password: string, salt: Uint8Array, iterations: number, byteLen: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    byteLen * 8
  );
  return new Uint8Array(bits);
}

/** New-format password hash: `pbkdf2$<iter>$<saltB64>$<hashB64>`. Exported — manage-member uses it. */
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const hash = await pbkdf2Derive(pw, salt, PBKDF2_ITERATIONS, PBKDF2_HASH_BYTES);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

/**
 * Verify a password against either supported hash format.
 * `needsRehash` is true when the stored hash is bcrypt and verification succeeded
 * (caller should transparently upgrade the row to pbkdf2).
 */
async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
  const fail = { ok: false, needsRehash: false };
  if (stored.startsWith('pbkdf2$')) {
    const parts = stored.split('$');
    if (parts.length !== 4) return fail;
    const iterations = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(iterations) || iterations < 1 || iterations > 10_000_000) return fail;
    let salt: Uint8Array;
    let expected: Uint8Array;
    try {
      salt = fromB64(parts[2]);
      expected = fromB64(parts[3]);
    } catch {
      return fail;
    }
    if (expected.length === 0) return fail;
    const derived = await pbkdf2Derive(password, salt, iterations, expected.length);
    return { ok: timingSafeEqual(derived, expected), needsRehash: false };
  }
  if (stored.startsWith('bcrypt$')) {
    const hash = stored.slice('bcrypt$'.length);
    try {
      const ok = await bcryptCompare(password, hash);
      return { ok, needsRehash: ok };
    } catch {
      return fail;
    }
  }
  return fail;
}

// ─── JWT ──────────────────────────────────────────────────────────────────

async function signAccessToken(env: Env, userId: string, email: string): Promise<{ token: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ACCESS_TOKEN_TTL_S;
  const token = await sign({ sub: userId, email, iat: now, exp }, env.JWT_SECRET, 'HS256');
  return { token, exp };
}

export async function verifyAccessToken(env: Env, token: string): Promise<{ sub: string; email: string } | null> {
  if (!token) return null;
  try {
    const payload = await verify(token, env.JWT_SECRET, 'HS256');
    const sub = (payload as Record<string, unknown>).sub;
    const email = (payload as Record<string, unknown>).email;
    if (typeof sub !== 'string' || sub === '' || typeof email !== 'string') return null;
    return { sub, email };
  } catch {
    return null; // invalid signature / malformed / expired
  }
}

function bearerToken(c: Context<AppContext>): string {
  const h = c.req.header('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : '';
}

// ─── Sessions ─────────────────────────────────────────────────────────────

async function createSession(env: Env, userId: string, email: string): Promise<AuthSession> {
  const { token: access_token, exp } = await signAccessToken(env, userId, email);
  const refreshBytes = crypto.getRandomValues(new Uint8Array(32));
  const refresh_token = toB64Url(refreshBytes);
  const tokenHash = await sha256Hex(refresh_token);
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + REFRESH_TOKEN_TTL_S * 1000).toISOString();
  await env.DB
    .prepare('INSERT INTO auth_refresh_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, userId, expiresIso, nowIso)
    .run();
  return {
    user: { id: userId, email },
    access_token,
    refresh_token,
    expires_at: exp,
  };
}

function authFailure(message: string): AuthResponse {
  return { user: null, session: null, error: { message } };
}

// ─── Row types ────────────────────────────────────────────────────────────

interface AuthUserRow {
  id: string;
  email: string;
  password_hash: string | null;
  banned: number | null;
}

interface RefreshTokenRow {
  token_hash: string;
  user_id: string;
  expires_at: string | null;
  consumed_at: string | null;
}

interface MemberRow {
  id: string;
  role: string | null;
  email: string | null;
  name: string | null;
  is_active: number | null;
  workspace_id: string | null; // null on a mid-migration DB → DEFAULT_WORKSPACE
}

// ─── Routes ───────────────────────────────────────────────────────────────

export function registerAuthRoutes(app: Hono<AppContext>): void {
  // POST /api/auth/login {email, password}
  app.post('/api/auth/login', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!email || !password) return c.json<AuthResponse>(authFailure(INVALID_CREDENTIALS));

    const user = await c.env.DB
      .prepare('SELECT id, email, password_hash, banned FROM auth_users WHERE email = ? COLLATE NOCASE')
      .bind(email)
      .first<AuthUserRow>();

    // Always spend comparable KDF work so response timing never reveals whether
    // the email exists / is banned / has a password — closes the enumeration
    // oracle. Not-found/banned/hashless paths verify against a decoy and discard.
    const usable = user && user.banned !== 1 && user.password_hash ? user : null;
    const { ok, needsRehash } = await verifyPassword(password, usable ? usable.password_hash! : DECOY_PASSWORD_HASH);

    // Same message for every failure kind — no user enumeration.
    if (!usable || !ok) return c.json<AuthResponse>(authFailure(INVALID_CREDENTIALS));

    // Transparent bcrypt → pbkdf2 upgrade; never let it break login.
    if (needsRehash) {
      try {
        const newHash = await hashPassword(password);
        await c.env.DB
          .prepare('UPDATE auth_users SET password_hash = ? WHERE id = ?')
          .bind(newHash, usable.id)
          .run();
      } catch {
        /* best-effort */
      }
    }

    const session = await createSession(c.env, usable.id, usable.email);
    return c.json<AuthResponse>({ user: session.user, session, error: null });
  });

  // POST /api/auth/refresh {refresh_token} — validate, rotate, re-issue.
  app.post('/api/auth/refresh', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { refresh_token?: unknown } | null;
    const refreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token : '';
    if (!refreshToken) return c.json<AuthResponse>(authFailure(INVALID_REFRESH));

    // Opportunistic cleanup: purge fully-expired rows. Off the hot path —
    // ~5% of refreshes, deferred via waitUntil so it never adds latency.
    if (Math.random() < 0.05) {
      c.executionCtx.waitUntil(
        c.env.DB
          .prepare('DELETE FROM auth_refresh_tokens WHERE expires_at <= ?')
          .bind(new Date().toISOString())
          .run()
          .then(() => undefined)
          .catch(() => undefined)
      );
    }

    const tokenHash = await sha256Hex(refreshToken);
    const row = await c.env.DB
      .prepare('SELECT token_hash, user_id, expires_at, consumed_at FROM auth_refresh_tokens WHERE token_hash = ?')
      .bind(tokenHash)
      .first<RefreshTokenRow>();
    if (!row) return c.json<AuthResponse>(authFailure(INVALID_REFRESH));

    const expiresMs = row.expires_at ? Date.parse(row.expires_at) : NaN;
    if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
      await c.env.DB.prepare('DELETE FROM auth_refresh_tokens WHERE token_hash = ?').bind(tokenHash).run();
      return c.json<AuthResponse>(authFailure(INVALID_REFRESH));
    }

    // Reuse-grace: a consumed token replayed within the grace window (a second
    // tab racing the first) is re-issued rather than rejected; a consumed token
    // presented after the window is genuine reuse → reject.
    if (row.consumed_at) {
      const consumedMs = Date.parse(row.consumed_at);
      if (!Number.isFinite(consumedMs) || Date.now() - consumedMs > REFRESH_GRACE_MS) {
        return c.json<AuthResponse>(authFailure(INVALID_REFRESH));
      }
    }

    const user = await c.env.DB
      .prepare('SELECT id, email, password_hash, banned FROM auth_users WHERE id = ?')
      .bind(row.user_id)
      .first<AuthUserRow>();
    if (!user || user.banned === 1) {
      await c.env.DB.prepare('DELETE FROM auth_refresh_tokens WHERE token_hash = ?').bind(tokenHash).run();
      return c.json<AuthResponse>(authFailure(INVALID_REFRESH));
    }

    // Rotate. On a first (unconsumed) refresh mark the row consumed but keep it,
    // so a racing tab can still replay within the grace window. On a within-grace
    // replay the row is already consumed — just issue a fresh session again.
    if (!row.consumed_at) {
      await c.env.DB
        .prepare('UPDATE auth_refresh_tokens SET consumed_at = ? WHERE token_hash = ?')
        .bind(new Date().toISOString(), tokenHash)
        .run();
    }

    const session = await createSession(c.env, user.id, user.email);
    return c.json<AuthResponse>({ user: session.user, session, error: null });
  });

  // POST /api/auth/logout {refresh_token?} — best-effort revoke, always succeeds.
  app.post('/api/auth/logout', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { refresh_token?: unknown } | null;
    const refreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token : '';
    if (refreshToken) {
      try {
        const tokenHash = await sha256Hex(refreshToken);
        await c.env.DB.prepare('DELETE FROM auth_refresh_tokens WHERE token_hash = ?').bind(tokenHash).run();
      } catch {
        /* best-effort */
      }
    }
    return c.json({ error: null });
  });

  // GET /api/auth/user — Bearer access token → {user} or 401.
  app.get('/api/auth/user', async (c) => {
    const claims = await verifyAccessToken(c.env, bearerToken(c));
    if (!claims) return c.json({ user: null, error: { message: 'Unauthorized' } }, 401);
    return c.json({ user: { id: claims.sub, email: claims.email }, error: null });
  });

  // POST /api/auth/change-password {current_password, new_password}
  // Self-service. Verifies the current password, rotates the hash, revokes
  // EVERY refresh token for the user (whoever held the old credentials is
  // logged out), then issues a fresh session for this device.
  app.post('/api/auth/change-password', requireMember, async (c) => {
    const auth = c.get('auth');
    if (isDemoMember(c.env, auth)) {
      return c.json({ error: 'demo_blocked', message: '展示帳號無法變更密碼' }, 403);
    }

    const body = (await c.req.json().catch(() => null)) as
      | { current_password?: unknown; new_password?: unknown }
      | null;
    const currentPassword = typeof body?.current_password === 'string' ? body.current_password : '';
    const newPassword = typeof body?.new_password === 'string' ? body.new_password : '';
    if (!currentPassword) {
      return c.json({ error: 'current_password_required', message: '請輸入目前的密碼' }, 400);
    }
    if (newPassword.length < 8) {
      return c.json({ error: 'password_too_short', message: '新密碼至少需要 8 碼' }, 400);
    }

    const user = await c.env.DB
      .prepare('SELECT id, email, password_hash, banned FROM auth_users WHERE id = ?')
      .bind(auth.userId)
      .first<AuthUserRow>();
    if (!user || user.banned === 1 || !user.password_hash) {
      return c.json({ error: 'unauthorized', message: 'Unauthorized' }, 401);
    }

    const { ok } = await verifyPassword(currentPassword, user.password_hash);
    if (!ok) {
      return c.json({ error: 'invalid_current_password', message: '目前的密碼不正確' }, 403);
    }

    const newHash = await hashPassword(newPassword);
    await c.env.DB
      .prepare('UPDATE auth_users SET password_hash = ? WHERE id = ?')
      .bind(newHash, user.id)
      .run();
    await c.env.DB
      .prepare('DELETE FROM auth_refresh_tokens WHERE user_id = ?')
      .bind(user.id)
      .run();

    const session = await createSession(c.env, user.id, user.email);
    return c.json({ error: null, session });
  });

  // Set-password invitation links (memberLogin.ts mints them for logins
  // created by the Jira import / 「啟用帳號」). PUBLIC: the signed token is
  // the credential, and it dies as soon as the password changes.
  const setPasswordUser = async (env: Env, rawToken: unknown): Promise<AuthUserRow | null> => {
    const token = readSetPasswordToken(rawToken);
    if (!token) return null;
    const user = await env.DB
      .prepare('SELECT id, email, password_hash, banned FROM auth_users WHERE id = ?')
      .bind(token.userId)
      .first<AuthUserRow>();
    if (!user || user.banned === 1) return null;
    return (await setPasswordTokenValid(env.JWT_SECRET, token, user.password_hash)) ? user : null;
  };
  const INVALID_SET_PASSWORD_LINK = { error: 'invalid_token', message: '連結無效或已過期，請管理員重新寄送。' };

  // POST /api/auth/set-password/verify {token} → {email} (the page shows whose password it sets)
  app.post('/api/auth/set-password/verify', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const user = await setPasswordUser(c.env, body?.token);
    if (!user) return c.json(INVALID_SET_PASSWORD_LINK, 400);
    return c.json({ email: user.email, error: null });
  });

  // POST /api/auth/set-password {token, password} → sets the password, revokes
  // every refresh token of the user, signs this device in.
  app.post('/api/auth/set-password', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { token?: unknown; password?: unknown } | null;
    const password = typeof body?.password === 'string' ? body.password : '';
    if (password.length < 8) {
      return c.json({ error: 'password_too_short', message: '密碼至少需要 8 碼' }, 400);
    }
    const user = await setPasswordUser(c.env, body?.token);
    if (!user) return c.json(INVALID_SET_PASSWORD_LINK, 400);

    // Compare-and-set on the hash the token was checked against: of two
    // requests racing with the same link, only the first one changes it.
    const updated = await c.env.DB
      .prepare('UPDATE auth_users SET password_hash = ?1 WHERE id = ?2 AND password_hash IS ?3')
      .bind(await hashPassword(password), user.id, user.password_hash)
      .run();
    if (!updated.meta.changes) return c.json(INVALID_SET_PASSWORD_LINK, 400);
    await c.env.DB.prepare('DELETE FROM auth_refresh_tokens WHERE user_id = ?').bind(user.id).run();
    clearMemberCache(user.id);

    const session = await createSession(c.env, user.id, user.email);
    return c.json<AuthResponse>({ user: session.user, session, error: null });
  });

  // POST /api/auth/signup — cloud-beta self-serve workspace creation.
  // PUBLIC but gated by an invite token minted via cloud-waitlist-approve
  // (CLOUD-BETA-DESIGN.md). Body: {invite, password, workspace_name,
  // display_name}. Creates auth user + workspace + super_admin member +
  // structural defaults in ONE atomic D1 batch, then returns a session.
  app.post('/api/auth/signup', async (c) => {
    const env = c.env;
    // Hosted sign-up is opt-in (CLOUD_SIGNUP=1); a normal install has no
    // public way to create workspaces.
    if (!isCloudSignupEnabled(env)) {
      return c.json({ error: { message: 'No route: POST /api/auth/signup' } }, 404);
    }
    const body = (await c.req.json().catch(() => null)) as {
      invite?: unknown; password?: unknown; workspace_name?: unknown; display_name?: unknown;
    } | null;

    const email = await verifyInviteToken(env, body?.invite);
    if (!email) {
      return c.json({ error: 'invalid_invite', message: '邀請連結無效或已過期，請聯繫管理員重寄。' }, 400);
    }
    const password = typeof body?.password === 'string' ? body.password : '';
    if (password.length < 8) {
      return c.json({ error: 'password_too_short', message: '密碼至少需要 8 碼' }, 400);
    }
    const wsName = (typeof body?.workspace_name === 'string' ? body.workspace_name : '').trim().slice(0, 80);
    if (!wsName) {
      return c.json({ error: 'workspace_name_required', message: '請輸入團隊名稱' }, 400);
    }
    const displayName =
      (typeof body?.display_name === 'string' ? body.display_name : '').trim().slice(0, 40) ||
      email.split('@')[0] || '成員';

    // One email = one workspace (members.email is globally unique).
    const existingMember = await env.DB
      .prepare('SELECT id FROM members WHERE email = ? COLLATE NOCASE LIMIT 1')
      .bind(email)
      .first<{ id: string }>();
    if (existingMember) {
      return c.json({ error: 'already_member', message: '這個 Email 已經有帳號，請直接登入。' }, 409);
    }

    // Find-or-create the auth user. Setting the password on an existing
    // orphan auth user is safe: the invite email proved mailbox ownership.
    const passwordHash = await hashPassword(password);
    const existingAuth = await env.DB
      .prepare('SELECT id FROM auth_users WHERE email = ?')
      .bind(email)
      .first<{ id: string }>();
    const authUserId = existingAuth?.id ?? crypto.randomUUID();

    const wsId = crypto.randomUUID();
    const memberId = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const now = new Date().toISOString();

    const stmts: D1PreparedStatement[] = [];
    if (existingAuth) {
      stmts.push(
        env.DB.prepare('UPDATE auth_users SET password_hash = ?, banned = 0 WHERE id = ?')
          .bind(passwordHash, authUserId),
        env.DB.prepare('DELETE FROM auth_refresh_tokens WHERE user_id = ?').bind(authUserId)
      );
    } else {
      stmts.push(
        env.DB.prepare(
          'INSERT INTO auth_users (id, email, password_hash, banned, created_at) VALUES (?, ?, ?, 0, ?)'
        ).bind(authUserId, email, passwordHash, now)
      );
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO members (workspace_id, id, name, avatar, role, job_title, color, email, is_active, sort_order, auth_id, theme)
         VALUES (?, ?, ?, ?, 'super_admin', '', '#0D9488', ?, 1, 0, ?, 'dark')`
      ).bind(wsId, memberId, displayName, displayName.slice(0, 1).toUpperCase(), email, authUserId)
    );
    stmts.push(...(await workspaceProvisionStatements(env, wsId, wsName, email)));

    try {
      await env.DB.batch(stmts);
    } catch (e) {
      console.error('[signup] provisioning batch failed:', e);
      return c.json({ error: 'signup_failed', message: '建立失敗，請稍後再試或聯繫管理員。' }, 500);
    }

    clearMemberCache(authUserId);
    c.executionCtx.waitUntil(markWaitlistJoined(env, email, wsId));

    const session = await createSession(env, authUserId, email);
    return c.json<AuthResponse>({ user: session.user, session, error: null });
  });
}

// ─── requireMember micro-cache ────────────────────────────────────────────
// Per-isolate cache of the primary `members WHERE auth_id = ?` lookup, keyed
// by JWT sub. Caches the IN-FLIGHT promise so the frontend's initial-load
// burst (~10+ parallel /api/query) collapses to one D1 query per isolate.
// Only the happy path is kept (member found via auth_id, active, email
// matches); 403s, stale links, and email-fallback heals are never cached so
// the healing logic below always hits D1 and actually heals.
// Deactivation latency ≤ TTL per isolate — acceptable next to the 1 h access
// token TTL. Expired entries are evicted lazily on each lookup.

const MEMBER_CACHE_TTL_MS = 45_000;
const memberCache = new Map<string, { p: Promise<MemberRow | null>; exp: number }>();

/** Drop cached member lookups (one sub, or all). Safe to call from anywhere
 *  (e.g. manageMember toggle_active/delete) — other isolates expire via TTL. */
export function clearMemberCache(sub?: string): void {
  if (sub === undefined) memberCache.clear();
  else memberCache.delete(sub);
}

function getMemberByAuthId(env: Env, sub: string, email: string): Promise<MemberRow | null> {
  const now = Date.now();
  // Lazy eviction of expired entries (map stays at ~member count — trivial).
  for (const [k, v] of memberCache) {
    if (v.exp <= now) memberCache.delete(k);
  }
  const hit = memberCache.get(sub);
  if (hit) return hit.p;

  const p = env.DB
    .prepare('SELECT id, role, email, name, is_active, workspace_id FROM members WHERE auth_id = ?')
    .bind(sub)
    .first<MemberRow>()
    .then((member) => {
      const happy =
        member != null &&
        !!member.is_active &&
        (member.email || '').toLowerCase() === email.toLowerCase();
      if (!happy) memberCache.delete(sub); // never cache 403/healing paths
      return member;
    });
  p.catch(() => memberCache.delete(sub)); // never cache failures
  memberCache.set(sub, { p, exp: now + MEMBER_CACHE_TTL_MS });
  return p;
}

// ─── Personal access tokens (PAT) ─────────────────────────────────────────
// Bearer `livo_pat_…` → api_tokens lookup (sha256, not revoked) → the bound
// member's identity, inheriting the same server-side permission floor as a
// JWT session for that member. auth.userId is 'pat:<token id>' — NOT an
// auth_users id, so auth_users-coupled flows (e.g. /api/auth/change-password)
// simply find no user and fail closed with 401.

const PAT_PREFIX = 'livo_pat_';
const PAT_LAST_USED_THROTTLE_MS = 5 * 60_000;

interface PatRow {
  token_id: string;
  last_used_at: string | null;
  member_id: string;
  role: string | null;
  email: string | null;
  name: string | null;
  is_active: number | null;
  workspace_id: string | null;
}

async function authenticatePat(
  c: Parameters<MiddlewareHandler<AppContext>>[0],
  next: Parameters<MiddlewareHandler<AppContext>>[1],
  token: string
): Promise<Response | void> {
  const tokenHash = await sha256Hex(token);
  let row: PatRow | null = null;
  try {
    row = await c.env.DB.prepare(
      `SELECT t.id AS token_id, t.last_used_at,
              m.id AS member_id, m.role, m.email, m.name, m.is_active, m.workspace_id
       FROM api_tokens t JOIN members m ON m.id = t.member_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL`
    )
      .bind(tokenHash)
      .first<PatRow>();
  } catch {
    row = null; // api_tokens table may not exist on a pre-migration DB
  }
  if (!row) return c.json({ error: { message: 'Unauthorized' } }, 401);
  if (!row.is_active) return c.json({ error: { message: 'Account disabled' } }, 403);

  // last_used_at bookkeeping, throttled to one write per 5 min, off the hot path.
  const lastUsedMs = row.last_used_at ? Date.parse(row.last_used_at) : NaN;
  if (!Number.isFinite(lastUsedMs) || Date.now() - lastUsedMs > PAT_LAST_USED_THROTTLE_MS) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), row.token_id)
        .run()
        .then(() => undefined)
        .catch(() => undefined)
    );
  }

  c.set('auth', {
    userId: `pat:${row.token_id}`,
    email: row.email || '',
    member: {
      id: row.member_id,
      role: row.role || 'member',
      email: row.email || '',
      name: row.name || '',
      workspaceId: row.workspace_id || DEFAULT_WORKSPACE,
    },
  });
  await next();
}

// ─── requireMember middleware ─────────────────────────────────────────────
// JWT → auth user → members row (RLS-parity authorization). Mirrors the
// frontend useAuthState linking flow: lookup by auth_id, heal stale links
// (email mismatch → clear auth_id, retry by email → relink).
// A `livo_pat_…` bearer takes the PAT path above instead.

/**
 * Core JWT-claims → active-member resolution (auth_id lookup, stale-link
 * heal, email fallback + relink). Shared by requireMember and the
 * /api/realtime route (which needs the member's workspace to pick a hub).
 */
export async function resolveActiveMember(
  env: Env,
  sub: string,
  email: string
): Promise<{ ok: true; member: MemberRow } | { ok: false; status: 401 | 403; message: string }> {
  const db = env.DB;
  let member = await getMemberByAuthId(env, sub, email);

  // Stale link: member row points at this auth user but emails no longer match.
  if (member && (member.email || '').toLowerCase() !== email.toLowerCase()) {
    clearMemberCache(sub);
    await db.prepare('UPDATE members SET auth_id = NULL WHERE id = ?').bind(member.id).run();
    member = null;
  }

  if (!member) {
    // Healing path — make sure no cached entry survives for this sub.
    clearMemberCache(sub);
    // Fallback: match by email (case-insensitive) and heal the auth_id link.
    // members.email is globally UNIQUE (one email = one workspace), so this
    // can never cross a tenant boundary.
    member = await db
      .prepare('SELECT id, role, email, name, is_active, workspace_id FROM members WHERE email = ? COLLATE NOCASE LIMIT 1')
      .bind(email)
      .first<MemberRow>();
    if (member) {
      if (!member.is_active) return { ok: false, status: 403, message: 'Account disabled' };
      await db.prepare('UPDATE members SET auth_id = ? WHERE id = ?').bind(sub, member.id).run();
    }
  }

  if (!member) return { ok: false, status: 403, message: 'Not a member' };
  if (!member.is_active) return { ok: false, status: 403, message: 'Account disabled' };
  return { ok: true, member };
}

export const requireMember: MiddlewareHandler<AppContext> = async (c, next) => {
  const bearer = bearerToken(c);
  if (bearer.startsWith(PAT_PREFIX)) return authenticatePat(c, next, bearer);

  const claims = await verifyAccessToken(c.env, bearer);
  if (!claims) return c.json({ error: { message: 'Unauthorized' } }, 401);

  const resolved = await resolveActiveMember(c.env, claims.sub, claims.email);
  if (!resolved.ok) return c.json({ error: { message: resolved.message } }, resolved.status);
  const member = resolved.member;

  c.set('auth', {
    userId: claims.sub,
    email: claims.email,
    member: {
      id: member.id,
      role: member.role || 'member',
      email: member.email || '',
      name: member.name || '',
      workspaceId: member.workspace_id || DEFAULT_WORKSPACE,
    },
  });
  await next();
};
