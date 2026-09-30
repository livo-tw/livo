// HMAC signatures for the one-click approve link emailed to the operator by
// the hosted sign-up flow (cloudBeta.ts). Keyed on JWT_SECRET, so there is no
// extra secret to configure; the signed payloads carry their own prefix and
// never look like a JWT.

import type { Env } from './env';

async function hmacHex(secret: string, payload: string, hexChars: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
  let hex = '';
  for (let i = 0; i < hexChars / 2; i++) hex += mac[i]!.toString(16).padStart(2, '0');
  return hex;
}

function timingSafeEqStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Signs `payload` with JWT_SECRET, truncated to `hexChars` hex characters. */
export async function signLink(env: Env, payload: string, hexChars: number): Promise<string> {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET is not set');
  return hmacHex(env.JWT_SECRET, payload, hexChars);
}

/** True when `sig` was made by signLink for this payload. */
export async function verifyLink(env: Env, payload: string, sig: string, hexChars: number): Promise<boolean> {
  if (!sig || !env.JWT_SECRET) return false;
  return timingSafeEqStr(sig, await hmacHex(env.JWT_SECRET, payload, hexChars));
}
