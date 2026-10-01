// Logins for members that so far only have a name (Jira import, 「啟用帳號」)
// — self-hosted edition (GoTrue). Mirrors worker/src/memberLogin.ts.
//
// Copies (byte-identical, so each function stays self-contained):
//   docker/volumes/functions/manage-member/memberAccounts.ts   ← edit this one
//   docker/volumes/functions/import-jira/memberAccounts.ts
//   supabase/functions/manage-member/memberAccounts.ts
//   supabase/functions/import-jira/memberAccounts.ts
// After editing run `npm run sync:shared` (scripts/sync-shared-code.mjs).
//
// How the person gets in — never a shared default password:
//   - a Resend key is bound in 系統管理 → 通知 (email_config): a set-password
//     invitation. The link carries a GoTrue recovery token and opens the
//     app's /set-password page (no GoTrue redirect settings involved);
//   - otherwise, or when the email cannot be sent: a random temporary
//     password, returned once to the admin.

// deno-lint-ignore-file no-explicit-any

export type LoginMethod = 'invite' | 'temp_password';

export interface LoginChannel {
  method: LoginMethod;
  cfg: { apiKey: string; fromAddress: string } | null;
  /** App base for links, e.g. https://pm.example.com/demo (null: no invitation possible). */
  appUrl: string | null;
}

const httpUrl = (s: string): URL | null => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
};

/** localhost / loopback: fine for the server itself, useless in an emailed link. */
export function isLocalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
}

/**
 * Base of the links in invitation emails; the app is served at the host root.
 * APP_BASE_URL (host root) when it names a real host; the factory .env sets
 * it to http://localhost:3000, so a loopback value loses to the browser
 * origin of this request, and is used only when there is no origin at all.
 */
export function resolveAppUrl(req: Request): string | null {
  const explicitRaw = (Deno.env.get('APP_BASE_URL') || '').trim().replace(/\/+$/, '');
  const explicit = httpUrl(explicitRaw);
  const origin = httpUrl(req.headers.get('origin') || '');
  if (explicit && !isLocalHostname(explicit.hostname)) return explicitRaw;
  if (origin) return origin.origin;
  if (explicit) return explicitRaw;
  return null;
}

/** Refusal for API-key callers on anything that sets passwords or opens logins. */
export const API_KEY_FORBIDDEN = {
  error: 'api_key_forbidden',
  message: 'API 金鑰不能用來設定密碼或開通帳號，請用網頁登入操作',
};

/**
 * True for a login JWT minted from a personal API key (functions/api-tokens:
 * its payload carries a `livo_pat` claim, written first). Only meaningful
 * after GoTrue accepted the token (auth.getUser), which checks the signature.
 */
export function isApiKeyToken(jwt: string): boolean {
  const part = (jwt || '').split('.')[1];
  if (!part) return false;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    return !!claims && typeof claims === 'object' && 'livo_pat' in claims;
  } catch {
    return false;
  }
}

export async function resolveLoginChannel(admin: any, req: Request): Promise<LoginChannel> {
  let cfg: LoginChannel['cfg'] = null;
  try {
    const { data } = await admin
      .from('email_config')
      .select('api_key, from_address')
      .eq('id', 'singleton')
      .maybeSingle();
    if (data?.api_key && data?.from_address) cfg = { apiKey: data.api_key, fromAddress: data.from_address };
  } catch (e) {
    console.error('[member-login] email_config read failed:', e);
  }
  const appUrl = resolveAppUrl(req);
  return { method: cfg && appUrl ? 'invite' : 'temp_password', cfg, appUrl };
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

/** A password nobody knows: invited users cannot sign in until they use the link. */
function unusablePassword(): string {
  return crypto.randomUUID() + crypto.randomUUID();
}

export class LoginError extends Error {
  code: 'email_taken';
  constructor(code: 'email_taken', message: string) {
    super(message);
    this.code = code;
  }
}

export type AuthUserIndex = Map<string, { id: string; email: string }>;

/** Every GoTrue user by lowercase email (listUsers is paginated). */
export async function loadAuthUsersByEmail(admin: any): Promise<AuthUserIndex> {
  const index: AuthUserIndex = new Map();
  const perPage = 1000;
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data?.users || [];
    for (const u of users) {
      if (u.email) index.set(String(u.email).toLowerCase(), { id: u.id, email: u.email });
    }
    if (users.length < perPage) break;
  }
  return index;
}

export interface PreparedLogin {
  authUserId: string;
  /** True when this call created the GoTrue user (discardLogin may delete it). */
  created: boolean;
  tempPassword: string | null;
}

/**
 * Creates the GoTrue user for `email`, or adopts one no member is linked to
 * (its password is replaced). Throws LoginError('email_taken') when the
 * login already belongs to a member. The caller links members.auth_id.
 */
export async function prepareLogin(
  admin: any,
  method: LoginMethod,
  to: { email: string; name: string },
  authUsers: AuthUserIndex,
): Promise<PreparedLogin> {
  const email = to.email.trim().toLowerCase();
  const tempPassword = method === 'temp_password' ? generateTempPassword() : null;
  const existing = authUsers.get(email);
  if (existing) {
    const { data: linked } = await admin.from('members').select('id').eq('auth_id', existing.id).limit(1);
    if (linked && linked.length > 0) throw new LoginError('email_taken', '此 Email 已有登入帳號');
    const { error } = await admin.auth.admin.updateUserById(existing.id, {
      password: tempPassword || unusablePassword(),
      email_confirm: true,
      ban_duration: 'none',
    });
    if (error) throw error;
    return { authUserId: existing.id, created: false, tempPassword };
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: tempPassword || unusablePassword(),
    email_confirm: true,
    user_metadata: { full_name: to.name },
  });
  if (error) {
    if (/already|registered|exists/i.test(error.message || '')) throw new LoginError('email_taken', '此 Email 已有登入帳號');
    throw error;
  }
  authUsers.set(email, { id: data.user.id, email });
  return { authUserId: data.user.id, created: true, tempPassword };
}

/** Rolls back a GoTrue user created by prepareLogin when the member write failed. */
export async function discardLogin(admin: any, login: PreparedLogin, authUsers?: AuthUserIndex): Promise<void> {
  if (!login.created) return;
  try {
    await admin.auth.admin.deleteUser(login.authUserId);
    if (authUsers) {
      for (const [email, u] of authUsers) if (u.id === login.authUserId) authUsers.delete(email);
    }
  } catch (_e) {
    // best-effort rollback
  }
}

export interface LoginDelivery {
  /** How the person actually gets in. */
  method: LoginMethod;
  tempPassword?: string;
  /** The invitation could not be sent, so a temporary password was issued instead. */
  inviteFailed?: boolean;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inviteEmail(to: { name: string; email: string; invitedBy: string }, link: string): { subject: string; html: string } {
  const name = escapeHtml(to.name || to.email);
  const email = escapeHtml(to.email);
  const by = escapeHtml(to.invitedBy || 'LIVO');
  const href = escapeHtml(link);
  const button = (label: string) =>
    `<p style="margin:20px 0"><a href="${href}" style="display:inline-block;padding:10px 18px;background:#0D9488;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">${label}</a></p>`;
  const html = `<div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:520px;color:#172B4D;line-height:1.6">
  <p>${name} 你好：</p>
  <p>${by} 幫你在 LIVO 建好了帳號（${email}）。請在 24 小時內點下面的按鈕設定密碼，之後用這個 Email 登入就可以了。</p>
  ${button('設定密碼')}
  <p style="color:#6B778C;font-size:12px">連結過期的話，請管理員幫你重設密碼。</p>
  <hr style="border:none;border-top:1px solid #DFE1E6;margin:24px 0">
  <p>Hi ${name},</p>
  <p>${by} has set up a LIVO account for you (${email}). Use the button below within 24 hours to choose your password, then sign in with this email address.</p>
  ${button('Set your password')}
  <p style="color:#6B778C;font-size:12px">If the link has expired, ask your admin to reset your password.</p>
</div>`;
  return { subject: 'LIVO 帳號邀請：請設定密碼 / Set your LIVO password', html };
}

/** After the member row is linked: email the invitation, or hand back the temporary password. */
export async function deliverLogin(
  admin: any,
  channel: LoginChannel,
  login: PreparedLogin,
  to: { name: string; email: string; invitedBy: string },
): Promise<LoginDelivery> {
  if (channel.method !== 'invite' || !channel.cfg || !channel.appUrl) {
    return { method: 'temp_password', tempPassword: login.tempPassword || undefined };
  }
  try {
    // generateLink only mints the token; GoTrue sends nothing itself.
    const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email: to.email });
    const hashed = data?.properties?.hashed_token;
    if (error || !hashed) {
      console.error('[member-login] generateLink failed:', error);
    } else {
      const link = `${channel.appUrl}/set-password?token_hash=${encodeURIComponent(hashed)}&type=recovery`;
      const { subject, html } = inviteEmail(to, link);
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${channel.cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: channel.cfg.fromAddress, to: [to.email], subject, html }),
      });
      if (resp.ok) return { method: 'invite' };
      console.error('[member-login] Resend failed:', resp.status, await resp.text());
    }
  } catch (err) {
    console.error('[member-login] invitation failed:', err);
  }
  // Could not send: issue a temporary password so the person is not locked out.
  const tempPassword = generateTempPassword();
  const { error } = await admin.auth.admin.updateUserById(login.authUserId, { password: tempPassword });
  if (error) throw error;
  return { method: 'temp_password', tempPassword, inviteFailed: true };
}
