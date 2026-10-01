// api-tokens core — personal API keys (PAT) for the self-host build.
//
// Pure logic shared by the edge function (index.ts) and the unit tests
// (src/test/apiTokensCore.test.ts). No Deno / supabase-js imports: data
// access comes in through ApiTokenStore, the network through fetch.
//
// Contract parity with the Cloudflare build (worker/src/functions/apiTokens.ts):
//   list   → { tokens: [{ id, name, memberId, createdBy, createdAt, lastUsedAt, revokedAt }] }
//   create → { ok:true, id, name, memberId, token }   (plain key shown ONCE)
//   revoke → { ok:true }
// Self-host only:
//   exchange → { access_token, token_type:'bearer', expires_in, expires_at, member }
//   PostgREST only understands JWTs, so a key is traded for a short-lived
//   login JWT of the bound member; RLS then applies exactly as for that
//   member's own browser session.
//
// The minted JWT must never manage the account itself (password, email,
// MFA, sign-out). Every such JWT starts with PAT_JWT_MARKER and
// docker/volumes/api/kong.yml lets it reach only GET /auth/v1/user (the
// other edge functions verify callers that way); the exchange refuses to
// mint unless the gateway proves that block is in place.
//
// docker/volumes/functions/api-tokens/ is a byte-identical copy (the files
// customers run); keep both in sync.

export const PAT_PREFIX = 'livo_pat_';
const PAT_RE = /^livo_pat_[0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_NAME_LEN = 100;
/** Lifetime of an exchanged JWT. Scripts exchange again when it expires. */
export const EXCHANGE_TTL_SECONDS = 15 * 60;
/** Body code of the gateway's refusal (request-termination in kong.yml). */
export const GATEWAY_BLOCK_CODE = 'livo_pat_readonly';

const ADMIN_ROLES = ['admin', 'super_admin'];
/** api_tokens.created_by for keys created with the service-role key. */
export const SERVICE_ROLE_CREATOR = 'service_role';

// Fixed JWT header + the first 12 bytes of the payload. 27 + 12 bytes encode
// to a fixed 36 + 16 base64url characters whatever follows, so the gateway
// can recognise these JWTs by prefix. Changing either string requires
// changing the regex in docker/volumes/api/kong.yml (a unit test checks).
const JWT_HEADER_JSON = '{"alg":"HS256","typ":"JWT"}';
const PAYLOAD_PREFIX_JSON = '{"livo_pat":';

// ─── encoding / crypto helpers ─────────────────────────────────────────────

const enc = new TextEncoder();

function b64urlBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlText(s: string): string {
  return b64urlBytes(enc.encode(s));
}

function b64urlDecodeText(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The first 53 characters of every JWT the exchange mints (header + '.' + payload start). */
export const PAT_JWT_MARKER = `${b64urlText(JWT_HEADER_JSON)}.${b64urlText(PAYLOAD_PREFIX_JSON)}`;

function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))));
}

/** A new plain key: livo_pat_ + 32 hex chars (128 random bits). */
export function generateToken(): string {
  return PAT_PREFIX + hex(crypto.getRandomValues(new Uint8Array(16)));
}

export function isPatFormat(token: string): boolean {
  return PAT_RE.test(token);
}

/** True for a login JWT the exchange minted from an API key (see PAT_JWT_MARKER). */
export function isExchangedJwt(token: string): boolean {
  return token.startsWith(PAT_JWT_MARKER);
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export interface PatJwtClaims {
  livo_pat: string;
  sub: string;
  role: string;
  aud: string;
  iat: number;
  exp: number;
  [claim: string]: unknown;
}

/** HS256-sign claims whose FIRST key is livo_pat (keeps the marker prefix). */
export async function signPatJwt(claims: PatJwtClaims, secret: string): Promise<string> {
  const { livo_pat, ...rest } = claims;
  const payload = JSON.stringify({ livo_pat, ...rest });
  if (!payload.startsWith(PAYLOAD_PREFIX_JSON)) throw new Error('livo_pat must be the first claim');
  const signingInput = `${b64urlText(JWT_HEADER_JSON)}.${b64urlText(payload)}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(signingInput));
  return `${signingInput}.${b64urlBytes(new Uint8Array(sig))}`;
}

/** Verify an HS256 JWT (signature + exp). Returns its claims, or null. */
export async function verifyJwt(
  token: string,
  secret: string,
  nowMs = Date.now(),
): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const sigB64 = parts[2].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[2].length / 4) * 4, '=');
    const sigBin = atob(sigB64);
    const sig = new Uint8Array(sigBin.length);
    for (let i = 0; i < sigBin.length; i++) sig[i] = sigBin.charCodeAt(i);
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, 'verify'),
      sig,
      enc.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;
    const claims = JSON.parse(b64urlDecodeText(parts[1])) as Record<string, unknown>;
    if (typeof claims.exp === 'number' && nowMs / 1000 >= claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}

// ─── data access ───────────────────────────────────────────────────────────

export interface ApiTokenRow {
  id: string;
  name: string;
  member_id: string;
  /** members.id of the creator, or SERVICE_ROLE_CREATOR */
  created_by: string;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface MemberRow {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
  is_active: boolean | null;
  auth_id: string | null;
}

export interface AuthUserInfo {
  id: string;
  email: string | null;
  banned_until: string | null;
  deleted_at: string | null;
}

export interface ApiTokenStore {
  listTokens(): Promise<ApiTokenRow[]>;
  /** Returns the new row id. */
  insertToken(row: { name: string; token_hash: string; member_id: string; created_by: string }): Promise<string>;
  /** Sets revoked_at on a not-yet-revoked token; false when there is none. */
  revokeToken(id: string, at: string): Promise<boolean>;
  /** A token that is NOT revoked, by sha256 of the plain key. */
  findActiveToken(tokenHash: string): Promise<{ id: string; member_id: string } | null>;
  touchToken(id: string, at: string): Promise<void>;
  getMember(id: string): Promise<MemberRow | null>;
  getAuthUser(id: string): Promise<AuthUserInfo | null>;
}

/** Thrown by a store when the api_tokens table is missing (DB not upgraded yet). */
export class NotInstalledError extends Error {
  constructor() {
    super('api_tokens table missing');
    this.name = 'NotInstalledError';
  }
}

export const NOT_INSTALLED_RESULT: Result = {
  status: 503,
  body: {
    ok: false,
    error: 'not_installed',
    message: '資料庫還沒有 API 金鑰資料表。請在伺服器上重新執行安裝程式（install.sh / install.bat）套用資料庫更新。',
  },
};

// ─── handlers ──────────────────────────────────────────────────────────────

export interface Result {
  status: number;
  body: Record<string, unknown>;
}

export type Caller = { kind: 'service' } | { kind: 'member'; member: MemberRow };

/** Active admin / super_admin — the only members allowed to manage keys. */
export function isAdminMember(member: MemberRow | null): boolean {
  return !!member && member.is_active === true && ADMIN_ROLES.includes(member.role || '');
}

const fail = (status: number, error: string, message?: string): Result => ({
  status,
  body: message ? { ok: false, error, message } : { ok: false, error },
});

export async function listTokens(store: ApiTokenStore): Promise<Result> {
  const rows = await store.listTokens();
  return {
    status: 200,
    body: {
      tokens: rows.map((t) => ({
        id: t.id,
        name: t.name,
        memberId: t.member_id,
        createdBy: t.created_by,
        createdAt: t.created_at,
        lastUsedAt: t.last_used_at,
        revokedAt: t.revoked_at,
      })),
    },
  };
}

export async function createToken(
  store: ApiTokenStore,
  caller: Caller,
  body: { name?: unknown; memberId?: unknown },
): Promise<Result> {
  const name = (body.name ?? '').toString().trim();
  if (!name || name.length > MAX_NAME_LEN) {
    return fail(400, 'invalid_name', '請為金鑰取一個名稱（100 字內）');
  }
  const self = caller.kind === 'member' ? caller.member : null;
  const memberId = (body.memberId ?? '').toString().trim() || self?.id || '';
  if (!memberId) {
    return fail(400, 'member_required', '用 service role 金鑰建立時必須指定 memberId');
  }

  const target = await store.getMember(memberId);
  if (!target || target.is_active !== true) {
    return fail(400, 'invalid_member', '綁定的成員不存在或已停用');
  }
  // Same escalation rule as manage-member reset_password: only a super_admin
  // may act as ANOTHER admin / super_admin (a key bound to a member carries
  // that member's full permissions).
  if (self && target.id !== self.id && ADMIN_ROLES.includes(target.role || '') && self.role !== 'super_admin') {
    return fail(403, 'forbidden_member', '只有超級管理員可以把金鑰綁定到其他管理員');
  }
  if (!target.auth_id) {
    return fail(
      400,
      'member_not_linked',
      '這位成員還沒有登入帳號，無法綁定金鑰。請在成員管理為他設定密碼，或讓他先登入一次。',
    );
  }

  const token = generateToken();
  const id = await store.insertToken({
    name,
    token_hash: await sha256Hex(token),
    member_id: target.id,
    created_by: self?.id ?? SERVICE_ROLE_CREATOR,
  });
  // The ONLY time the plain key is ever returned.
  return { status: 200, body: { ok: true, id, name, memberId: target.id, token } };
}

export async function revokeToken(store: ApiTokenStore, body: { id?: unknown }, now: Date): Promise<Result> {
  const id = (body.id ?? '').toString().trim();
  if (!id) return fail(400, 'id_required');
  if (!UUID_RE.test(id) || !(await store.revokeToken(id, now.toISOString()))) {
    return fail(404, 'not_found');
  }
  return { status: 200, body: { ok: true } };
}

/** Bearer value of an Authorization header ('' when absent). */
export function bearerOf(authorization: string | null): string {
  const m = /^\s*bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  return m ? m[1] : '';
}

export interface ExchangeDeps {
  jwtSecret: string;
  now: Date;
  /** Resolves true only when the gateway refuses minted JWTs on the account endpoints. */
  gatewayIsHardened: () => Promise<boolean>;
}

export async function exchangeToken(
  store: ApiTokenStore,
  authorization: string | null,
  deps: ExchangeDeps,
): Promise<Result> {
  const key = bearerOf(authorization);
  if (!isPatFormat(key)) {
    return fail(401, 'invalid_token', '請在 Authorization 標頭帶上 API 金鑰：Bearer livo_pat_…');
  }
  const token = await store.findActiveToken(await sha256Hex(key));
  if (!token) return fail(401, 'invalid_token', 'API 金鑰無效或已撤銷');

  const member = await store.getMember(token.member_id);
  if (!member) return fail(401, 'invalid_token', 'API 金鑰無效或已撤銷');
  if (member.is_active !== true) return fail(403, 'member_inactive', '金鑰綁定的成員已停用');
  const user = member.auth_id ? await store.getAuthUser(member.auth_id) : null;
  if (!user || user.deleted_at) {
    return fail(403, 'member_not_linked', '金鑰綁定的成員沒有可用的登入帳號');
  }
  const nowMs = deps.now.getTime();
  if (user.banned_until && Date.parse(user.banned_until) > nowMs) {
    return fail(403, 'member_inactive', '金鑰綁定的登入帳號已被停用');
  }

  if (!(await deps.gatewayIsHardened())) {
    return fail(
      503,
      'gateway_not_hardened',
      'API 閘道設定過舊，無法安全地發出權杖。請更新 docker/volumes/api/kong.yml 並重新執行安裝程式（或重新啟動 kong 服務）。',
    );
  }

  const iat = Math.floor(nowMs / 1000);
  const exp = iat + EXCHANGE_TTL_SECONDS;
  const accessToken = await signPatJwt(
    {
      livo_pat: token.id,
      iss: 'livo-api-tokens',
      sub: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email ?? '',
      aal: 'aal1',
      is_anonymous: false,
      iat,
      exp,
    },
    deps.jwtSecret,
  );
  try {
    await store.touchToken(token.id, deps.now.toISOString());
  } catch {
    // last_used_at is bookkeeping only
  }
  return {
    status: 200,
    body: {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: EXCHANGE_TTL_SECONDS,
      expires_at: exp,
      member: { id: member.id, name: member.name ?? '', role: member.role ?? 'member' },
    },
  };
}

// ─── gateway self-check ────────────────────────────────────────────────────

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Proves the gateway keeps minted JWTs away from the account endpoints:
 * sends a password change for a random (non-existent) user with a minted
 * probe JWT. A hardened gateway answers 403 + GATEWAY_BLOCK_CODE; an old
 * kong.yml forwards it to GoTrue, which answers user_not_found — nothing
 * is changed either way.
 */
export async function probeGateway(
  fetchFn: FetchLike,
  opts: { supabaseUrl: string; anonKey: string; jwtSecret: string; now: Date },
): Promise<boolean> {
  const iat = Math.floor(opts.now.getTime() / 1000);
  const probe = await signPatJwt(
    { livo_pat: 'gateway-probe', sub: crypto.randomUUID(), role: 'authenticated', aud: 'authenticated', iat, exp: iat + 60 },
    opts.jwtSecret,
  );
  try {
    const res = await fetchFn(`${opts.supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, {
      method: 'PUT',
      headers: { apikey: opts.anonKey, Authorization: `Bearer ${probe}`, 'Content-Type': 'application/json' },
      body: '{"password":"livo-gateway-probe"}',
    });
    const body = (await res.json().catch((): null => null)) as { code?: unknown } | null;
    return res.status === 403 && body?.code === GATEWAY_BLOCK_CODE;
  } catch {
    return false;
  }
}
