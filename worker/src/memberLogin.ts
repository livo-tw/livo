// Logins for members that so far only have a name (Jira import, 「啟用帳號」).
// The member row keeps its id, so every task already assigned to it stays put.
//
// How the person gets in — never a shared default password:
//   - email sending is configured (email_config row or RESEND_API_KEY): a
//     set-password invitation (setPasswordToken.ts), valid 7 days;
//   - otherwise, or when that email fails to send: a random temporary
//     password, returned once to the admin and stored only as a hash.

import type { Env } from './env';
import { appBaseUrl } from './env';
import { hashPassword } from './auth';
import { escapeHtml, resolveEmailConfig, sendResendEmail, type EmailConfig } from './functions/emailNotify';
import { SET_PASSWORD_TTL_S, signSetPasswordToken } from './setPasswordToken';

export type LoginMethod = 'invite' | 'temp_password';

/** Refusal for API-key callers on anything that sets passwords or opens logins. */
export const API_KEY_FORBIDDEN = {
  error: 'api_key_forbidden',
  message: 'API 金鑰不能用來設定密碼或開通帳號，請用網頁登入操作',
};

/** A request authenticated with a personal API key (auth.ts sets userId 'pat:<token id>'). */
export function isApiKeyCaller(auth: { userId: string }): boolean {
  return auth.userId.startsWith('pat:');
}

export interface LoginChannel {
  method: LoginMethod;
  cfg: EmailConfig | null;
}

export async function resolveLoginChannel(env: Env, ws: string): Promise<LoginChannel> {
  const cfg = await resolveEmailConfig(env, ws);
  return { method: cfg ? 'invite' : 'temp_password', cfg };
}

// No 0/O, 1/l/I: the password is read off a screen or a printed list.
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** 12 random characters (~70 bits), uniform via rejection sampling. */
export function generateTempPassword(length = 12): string {
  const n = TEMP_PASSWORD_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out += TEMP_PASSWORD_ALPHABET[b % n];
    }
  }
  return out;
}

export class LoginError extends Error {
  constructor(public code: 'email_taken', message: string) {
    super(message);
  }
}

export interface PreparedLogin {
  authUserId: string;
  /** auth_users writes; run them in the same batch as the member insert/update. */
  statements: D1PreparedStatement[];
  passwordHash: string | null;
  tempPassword: string | null;
}

/**
 * Statements that give `email` a login. An auth user nobody is linked to is
 * reused (its password is replaced and its sessions revoked); a login that
 * already belongs to a member throws LoginError('email_taken').
 * Callers check members.email first (it is unique across workspaces).
 */
export async function prepareLogin(env: Env, email: string, method: LoginMethod): Promise<PreparedLogin> {
  const normalized = email.trim().toLowerCase();
  const existing = await env.DB
    .prepare('SELECT id FROM auth_users WHERE email = ?1 COLLATE NOCASE LIMIT 1')
    .bind(normalized)
    .first<{ id: string }>();
  if (existing) {
    // auth_users is shared by every workspace, so this check has to be global:
    // a member anywhere pointing at this login means it is somebody's account.
    // Only existence is read; nothing about that member leaves this function.
    const linked = await env.DB
      .prepare('SELECT 1 AS hit FROM members WHERE auth_id = ?1 LIMIT 1')
      .bind(existing.id)
      .first<{ hit: number }>();
    if (linked) throw new LoginError('email_taken', '此 Email 已有登入帳號');
  }

  const tempPassword = method === 'temp_password' ? generateTempPassword() : null;
  // Invitations leave the hash empty: nobody can sign in until the link is used.
  const passwordHash = tempPassword ? await hashPassword(tempPassword) : null;

  if (existing) {
    return {
      authUserId: existing.id,
      passwordHash,
      tempPassword,
      statements: [
        env.DB.prepare('UPDATE auth_users SET password_hash = ?1, banned = 0 WHERE id = ?2').bind(passwordHash, existing.id),
        env.DB.prepare('DELETE FROM auth_refresh_tokens WHERE user_id = ?1').bind(existing.id),
      ],
    };
  }
  const authUserId = crypto.randomUUID();
  return {
    authUserId,
    passwordHash,
    tempPassword,
    statements: [
      env.DB
        .prepare('INSERT INTO auth_users (id, email, password_hash, banned, created_at) VALUES (?1, ?2, ?3, 0, ?4)')
        .bind(authUserId, normalized, passwordHash, new Date().toISOString()),
    ],
  };
}

export interface LoginDelivery {
  /** How the person actually gets in. */
  method: LoginMethod;
  tempPassword?: string;
  /** The invitation could not be sent, so a temporary password was issued instead. */
  inviteFailed?: boolean;
}

export function setPasswordLink(env: Env, token: string): string {
  return `${appBaseUrl(env)}/demo/set-password?token=${encodeURIComponent(token)}`;
}

function inviteEmail(to: { name: string; email: string; invitedBy: string }, link: string): { subject: string; html: string } {
  const days = Math.round(SET_PASSWORD_TTL_S / 86400);
  const name = escapeHtml(to.name || to.email);
  const email = escapeHtml(to.email);
  const by = escapeHtml(to.invitedBy || 'LIVO');
  const href = escapeHtml(link);
  const button = (label: string) =>
    `<p style="margin:20px 0"><a href="${href}" style="display:inline-block;padding:10px 18px;background:#0D9488;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">${label}</a></p>`;
  const html = `<div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:520px;color:#172B4D;line-height:1.6">
  <p>${name} 你好：</p>
  <p>${by} 幫你在 LIVO 建好了帳號（${email}）。請在 ${days} 天內點下面的按鈕設定密碼，之後用這個 Email 登入就可以了。</p>
  ${button('設定密碼')}
  <p style="color:#6B778C;font-size:12px">連結過期的話，請管理員幫你重設密碼。</p>
  <hr style="border:none;border-top:1px solid #DFE1E6;margin:24px 0">
  <p>Hi ${name},</p>
  <p>${by} has set up a LIVO account for you (${email}). Use the button below within ${days} days to choose your password, then sign in with this email address.</p>
  ${button('Set your password')}
  <p style="color:#6B778C;font-size:12px">If the link has expired, ask your admin to reset your password.</p>
</div>`;
  return { subject: 'LIVO 帳號邀請：請設定密碼 / Set your LIVO password', html };
}

/** After the login rows are committed: email the invitation, or hand back the temporary password. */
export async function deliverLogin(
  env: Env,
  channel: LoginChannel,
  login: PreparedLogin,
  to: { name: string; email: string; invitedBy: string }
): Promise<LoginDelivery> {
  if (channel.method !== 'invite' || !channel.cfg) {
    return { method: 'temp_password', tempPassword: login.tempPassword || undefined };
  }
  try {
    const token = await signSetPasswordToken(env.JWT_SECRET, login.authUserId, login.passwordHash);
    const { subject, html } = inviteEmail(to, setPasswordLink(env, token));
    if (await sendResendEmail(channel.cfg, to.email, subject, html)) return { method: 'invite' };
  } catch (err) {
    console.error('[member-login] invitation failed:', err);
  }
  // Could not send: issue a temporary password so the person is not locked out.
  const tempPassword = generateTempPassword();
  await env.DB
    .prepare('UPDATE auth_users SET password_hash = ?1 WHERE id = ?2')
    .bind(await hashPassword(tempPassword), login.authUserId)
    .run();
  return { method: 'temp_password', tempPassword, inviteFailed: true };
}
