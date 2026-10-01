// Set-password page (invitation links from the Jira import / 「啟用帳號」),
// branching like changePassword.ts:
//  - Cloudflare backend: /set-password?token=… → /api/auth/set-password
//    (cfClient verifySetPasswordToken / setPasswordWithToken);
//  - self-hosted Supabase: /set-password?token_hash=…&type=recovery — a GoTrue
//    recovery token: verifyOtp signs the person in, then updateUser sets the
//    password;
//  - in-memory demo client: not available.
// Errors come back as codes the page translates: invalid_token |
// password_too_short | demo_blocked | unknown (with the backend message).

import { supabase } from '@/integrations/supabase/client';
import { USE_CF_BACKEND } from './apiBase';
import { IS_DEMO_PRO } from './demoMode';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '';

export type SetPasswordLink = { kind: 'cf'; token: string } | { kind: 'gotrue'; tokenHash: string };

export interface SetPasswordError {
  code: 'invalid_token' | 'password_too_short' | 'demo_blocked' | 'unknown';
  message?: string;
}

const demoBlocked = (): boolean => IS_DEMO_PRO || (!USE_CF_BACKEND && !SUPABASE_URL);

export function readSetPasswordLink(search: string): SetPasswordLink | null {
  const params = new URLSearchParams(search);
  const token = params.get('token');
  if (token) return { kind: 'cf', token };
  const tokenHash = params.get('token_hash');
  if (tokenHash && (params.get('type') || 'recovery') === 'recovery') return { kind: 'gotrue', tokenHash };
  return null;
}

interface CfAuthExtras {
  verifySetPasswordToken: (token: string) => Promise<{ email: string | null; error: { message: string; code?: string } | null }>;
  setPasswordWithToken: (token: string, password: string) => Promise<{ error: { message: string; code?: string } | null }>;
}

const cfAuth = (): CfAuthExtras => supabase.auth as unknown as CfAuthExtras;

function toError(err: { message?: string; code?: string } | null | undefined): SetPasswordError {
  const code = err?.code;
  if (code === 'invalid_token' || code === 'password_too_short') return { code };
  return { code: 'unknown', message: err?.message };
}

/**
 * Checks the link before the form is shown. Only the Cloudflare link can be
 * checked without using it up; a GoTrue token is single-use, so it is checked
 * when the password is submitted.
 */
export async function checkSetPasswordLink(link: SetPasswordLink): Promise<{ email?: string; error?: SetPasswordError }> {
  if (demoBlocked()) return { error: { code: 'demo_blocked' } };
  if (link.kind !== 'cf' || !USE_CF_BACKEND) return {};
  const { email, error } = await cfAuth().verifySetPasswordToken(link.token);
  if (error) return { error: toError(error) };
  return { email: email || undefined };
}

/**
 * Sets the password and leaves the person signed in. `state.verified` carries
 * a used GoTrue token across retries (e.g. the server rejected the password
 * after the token was already exchanged for a session).
 */
export async function setPasswordFromLink(
  link: SetPasswordLink,
  password: string,
  state: { verified: boolean }
): Promise<SetPasswordError | null> {
  if (demoBlocked()) return { code: 'demo_blocked' };
  if (password.length < 8) return { code: 'password_too_short' };

  if (link.kind === 'cf') {
    const { error } = await cfAuth().setPasswordWithToken(link.token, password);
    return error ? toError(error) : null;
  }

  if (!state.verified) {
    // A leftover session (another account on this browser) must not receive
    // the new password.
    const { data: { session } } = await supabase.auth.getSession();
    if (session) await supabase.auth.signOut();
    const { error } = await supabase.auth.verifyOtp({ token_hash: link.tokenHash, type: 'recovery' });
    if (error) return { code: 'invalid_token' };
    state.verified = true;
  }
  const { error } = await supabase.auth.updateUser({ password });
  return error ? { code: 'unknown', message: error.message } : null;
}
