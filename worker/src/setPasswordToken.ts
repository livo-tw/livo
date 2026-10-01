// Set-password links (the invitation emailed to a member whose login was just
// created by the Jira import or 「啟用帳號」).
//
// token = v1.<auth user id>.<exp, unix seconds>.<sig>
// sig   = HMAC-SHA256(JWT_SECRET, "livo-set-password:v1:<id>:<exp>:<sha256(password_hash)>")
//
// Stateless, and single-use anyway: the signature covers the user's current
// password hash, so once a password is set (or an admin resets it) every
// earlier link stops verifying. The "livo-set-password:" prefix keeps these
// signatures apart from JWTs signed with the same secret.
//
// No imports: unit-tested on its own.

const VERSION = 'v1';

/** Links stay valid for 7 days. */
export const SET_PASSWORD_TTL_S = 7 * 24 * 3600;

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += (bytes[i] as number).toString(16).padStart(2, '0');
  return hex;
}

async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signature(secret: string, userId: string, exp: number, passwordHash: string | null): Promise<string> {
  const fingerprint = await sha256Hex(passwordHash || '');
  return hmacHex(secret, `livo-set-password:${VERSION}:${userId}:${exp}:${fingerprint}`);
}

export interface SetPasswordToken {
  userId: string;
  exp: number;
  sig: string;
}

export async function signSetPasswordToken(
  secret: string,
  userId: string,
  passwordHash: string | null,
  nowMs: number = Date.now()
): Promise<string> {
  if (!secret) throw new Error('JWT_SECRET is not set');
  const exp = Math.floor(nowMs / 1000) + SET_PASSWORD_TTL_S;
  return `${VERSION}.${userId}.${exp}.${await signature(secret, userId, exp, passwordHash)}`;
}

/** Splits a token without checking it; null when it is not even well-formed. */
export function readSetPasswordToken(token: unknown): SetPasswordToken | null {
  if (typeof token !== 'string' || token.length > 256) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const userId = parts[1] || '';
  const expStr = parts[2] || '';
  const sig = parts[3] || '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) return null;
  if (!/^\d{1,12}$/.test(expStr)) return null;
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  return { userId, exp: Number(expStr), sig };
}

/** True when the token is unexpired and was signed for this user's current password hash. */
export async function setPasswordTokenValid(
  secret: string,
  token: SetPasswordToken,
  passwordHash: string | null,
  nowMs: number = Date.now()
): Promise<boolean> {
  if (!secret || token.exp * 1000 <= nowMs) return false;
  return timingSafeEqual(await signature(secret, token.userId, token.exp, passwordHash), token.sig);
}
