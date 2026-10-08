import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.98.0';
import { INVITATION_ERROR_CODES } from './core.ts';
import { InvitationFailure, type InvitationBackend, type InvitationRow, type ConfirmationRow } from './handler.ts';

export interface InvitationEnvironment { url: string; serviceKey: string; anonKey: string; appBaseUrl: string }
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvitationFailure('server_error', 500);
  return raw as Record<string, unknown>;
}
function row(raw: unknown): InvitationRow {
  const value = record(raw);
  if (typeof value.id !== 'string' || !['member', 'admin', 'super_admin'].includes(String(value.role))
    || typeof value.job_title !== 'string' || typeof value.is_qa_admin !== 'boolean'
    || (value.status !== undefined && !['pending', 'used', 'revoked', 'expired', 'unavailable'].includes(String(value.status)))
    || typeof value.created_at !== 'string' || typeof value.expires_at !== 'string') throw new InvitationFailure('server_error', 500);
  return { id: value.id, role: value.role as InvitationRow['role'], job_title: value.job_title, is_qa_admin: value.is_qa_admin,
    created_by: typeof value.created_by === 'string' ? value.created_by : '', created_at: value.created_at, expires_at: value.expires_at,
    used_at: typeof value.used_at === 'string' ? value.used_at : null, revoked_at: typeof value.revoked_at === 'string' ? value.revoked_at : null,
    ...(value.status === undefined ? {} : { status: value.status as InvitationRow['status'] }) };
}
function confirmation(raw: unknown): ConfirmationRow {
  const value = record(raw);
  if (typeof value.name !== 'string' || typeof value.email !== 'string') throw new InvitationFailure('server_error', 500);
  return { ...row(value), name: value.name, email: value.email };
}
function failure(error: { message: string; code?: string }): InvitationFailure {
  const code = INVITATION_ERROR_CODES.find(item => item === error.message);
  if (code) return new InvitationFailure(code, code === 'rate_limited' ? 429 : code === 'forbidden' ? 403 : code === 'invalid_request' ? 400 : 409);
  console.error('[member-invitations] database operation failed');
  return new InvitationFailure('server_error', 500);
}
function apiKeyToken(token: string): boolean {
  try {
    const part = token.split('.')[1];
    const encoded = part.replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    return !!claims && typeof claims === 'object' && 'livo_pat' in claims;
  } catch { return false; }
}
function canonicalAppUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid base');
    return url.href.replace(/\/+$/, '');
  } catch { throw new InvitationFailure('email_not_configured', 503); }
}
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char);

export function createInvitationBackend(admin: SupabaseClient, env: InvitationEnvironment, fetcher: typeof fetch = fetch): InvitationBackend {
  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await admin.rpc(name, args);
    if (error) throw failure(error);
    return data as unknown;
  }
  return {
    async prune() { await rpc('livo_member_invitation_prune', {}); },
    async caller(request) {
      const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      if (!token) throw new InvitationFailure('forbidden', 401);
      const { data: { user: callerAuth }, error } = await admin.auth.getUser(token);
      if (error || !callerAuth) throw new InvitationFailure('forbidden', 401);
      const { data, error: memberError } = await admin.from('members').select('id, role').eq('auth_id', callerAuth.id).eq('is_active', true).maybeSingle();
      if (memberError || !data) throw new InvitationFailure('forbidden', 403);
      const member = record(data as unknown);
      if (typeof member.id !== 'string' || typeof member.role !== 'string') throw new InvitationFailure('forbidden', 403);
      return { authId: callerAuth.id, memberId: member.id, role: member.role, apiKey: apiKeyToken(token) };
    },
    appUrl: () => canonicalAppUrl(env.appBaseUrl),
    async mail() {
      const appUrl = canonicalAppUrl(env.appBaseUrl);
      const { data, error } = await admin.from('email_config').select('api_key, from_address').eq('id', 'singleton').maybeSingle();
      if (error) throw new InvitationFailure('server_error', 500);
      if (!data) return null;
      const cfg = record(data as unknown);
      return typeof cfg.api_key === 'string' && cfg.api_key && typeof cfg.from_address === 'string' && cfg.from_address
        ? { appUrl, apiKey: cfg.api_key, fromAddress: cfg.from_address } : null;
    },
    async create(caller, id, hash, grant) {
      return row(await rpc('livo_member_invitation_create', { p_actor_auth_id: caller.authId, p_id: id, p_token_hash: hash,
        p_role: grant.role, p_job_title: grant.jobTitle, p_is_qa_admin: grant.isQaAdmin }));
    },
    async list(caller) {
      const data = await rpc('livo_member_invitation_list', { p_actor_auth_id: caller.authId });
      if (!Array.isArray(data)) throw new InvitationFailure('server_error', 500);
      return data.map(row);
    },
    async revoke(caller, id) { await rpc('livo_member_invitation_revoke', { p_actor_auth_id: caller.authId, p_id: id }); },
    async preview(id, hash) { return row(await rpc('livo_member_invitation_preview', { p_id: id, p_token_hash: hash })); },
    async reserve(inviteId, inviteHash, id, hash, name, email) {
      return confirmation(await rpc('livo_member_invitation_request_confirmation', { p_invitation_id: inviteId, p_invite_hash: inviteHash,
        p_id: id, p_token_hash: hash, p_name: name, p_email: email }));
    },
    async finishSend(id, hash, sent) { return await rpc('livo_member_invitation_finish_send', { p_id: id, p_token_hash: hash, p_sent: sent }) === true; },
    async confirmationPreview(id, hash) { return confirmation(await rpc('livo_member_invitation_confirmation_preview', { p_id: id, p_token_hash: hash })); },
    async send(mail, to, link) {
      const html = `<p>${escapeHtml(to.name)} 你好：</p><p>請確認這個 Email，再自行設定密碼加入 LIVO。連結一小時內有效，並受原邀請期限限制。</p><p><a href="${escapeHtml(link)}">確認 Email 並加入 LIVO</a></p><p>如果你沒有申請加入，請忽略這封信。</p>`;
      try {
        const response = await fetcher('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${mail.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: mail.fromAddress, to: [to.email], subject: 'LIVO：確認 Email 並加入團隊', html }) });
        if (!response.ok) console.warn('[member-invitations] mail provider rejected confirmation');
        return response.ok;
      } catch { console.warn('[member-invitations] mail transport unavailable'); return false; }
    },
    async createAuth(email, password, name, proof) {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name },
        app_metadata: { livo_member_invitation: { confirmation_id: proof.confirmationId, token_hash: proof.tokenHash } } });
      if (error || !data.user) {
        if (error?.code === 'email_exists' || error?.code === 'user_already_exists') throw new InvitationFailure('email_taken', 409);
        if (error?.code === 'weak_password') throw new InvitationFailure('password_invalid');
        throw new InvitationFailure('server_error', 503);
      }
      return data.user.id;
    },
    async accept(id, hash, authId, memberId) {
      await rpc('livo_member_invitation_accept', { p_confirmation_id: id, p_token_hash: hash, p_auth_id: authId, p_member_id: memberId });
    },
    async deleteCreatedAuth(id, proof) {
      try {
        return await rpc('livo_member_invitation_discard_auth', { p_confirmation_id: proof.confirmationId, p_token_hash: proof.tokenHash, p_auth_id: id }) === true;
      } catch { console.error('[member-invitations] login cleanup unavailable'); return false; }
    },
    async session(email, password) {
      const client = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) return null;
      return data.session;
    },
  };
}
