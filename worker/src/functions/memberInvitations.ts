/** A shared invitation grants membership. Direct joining does not prove
 * ownership of the supplied email; legacy emailed proofs remain consumable. */
import type { Context } from 'hono';
import type { AppContext, Env } from '../env';
import { appBaseUrl, DEFAULT_WORKSPACE, isDemoMember, isDemoWorkspace } from '../env';
import { clearMemberCache, hashPassword, prepareAuthSession, requireMember } from '../auth';
import { liveMember, liveMemberSql } from '../liveMember';
import { isApiKeyCaller } from '../memberLogin';
import { notifyChanges } from '../notify';
import { rowToWire } from '../meta';
import { TABLES } from '../tables';
import {
  INVITATION_TTL_MS, canIssueInvitation, hasOnlyKeys,
  hashMemberInvitationToken, invitationStatus, mintMemberInvitationToken,
  parseMemberInvitationToken, validateInvitationGrant, validateInviteEmail,
  validateInviteName, validateInvitePassword,
  type InvitationErrorCode, type InvitationGrant, type InvitationMetadata,
} from '../memberInvitationsCore';

type Row = {
  workspace_id: string; id: string; role: InvitationGrant['role']; job_title: string;
  is_qa_admin: number; created_by: string; created_by_auth_id: string;
  created_at: string; expires_at: string; revoked_at: string | null; used_at: string | null;
  workspace_name?: string | null;
  issuer_available?: number;
};
type Confirmation = Row & {
  confirmation_id: string; confirmation_expires_at: string; name: string; email: string;
};

class InvitationError extends Error {
  constructor(public code: InvitationErrorCode, public status: 400 | 401 | 403 | 409 | 429 | 503 = 400) { super(code); }
}

const availableInvitation = `(i.workspace_id='default' OR EXISTS(SELECT 1 FROM workspaces w WHERE w.id=i.workspace_id AND w.status='active'))
  AND EXISTS(SELECT 1 FROM members m JOIN auth_users a ON a.id=m.auth_id AND a.banned=0
    WHERE m.workspace_id=i.workspace_id AND m.id=i.created_by AND m.auth_id=i.created_by_auth_id AND m.is_active=1
      AND (m.role='super_admin' OR (m.role='admin' AND i.role='member' AND i.job_title='' AND i.is_qa_admin=0))
      AND (SELECT count(*) FROM members x WHERE x.workspace_id=m.workspace_id AND x.auth_id=m.auth_id AND x.is_active=1)=1)`;
const openInvitation = `i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>? AND ${availableInvitation}`;

/** Access-triggered retention: keep the full rolling-day throttle window and
 * expired proofs for one further day. Invitations and joined accounts persist. */
async function pruneInvitationData(env: Env, workspaceId: string): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM member_invitation_confirmations WHERE workspace_id=?1 AND id IN (
      SELECT id FROM member_invitation_confirmations WHERE workspace_id=?1 AND expires_at<=?2
        ORDER BY expires_at,id LIMIT 200)`)
      .bind(workspaceId, cutoff),
    env.DB.prepare(`DELETE FROM member_invitation_send_attempts WHERE workspace_id=?1 AND id IN (
      SELECT id FROM member_invitation_send_attempts WHERE workspace_id=?1 AND created_at<=?2
        ORDER BY created_at,id LIMIT 200)`)
      .bind(workspaceId, cutoff),
  ]);
}

function grant(row: Row): InvitationGrant {
  return { role: row.role, jobTitle: row.job_title, isQaAdmin: row.is_qa_admin === 1 };
}
function metadata(row: Row): Omit<InvitationMetadata, 'status'> & { status: InvitationMetadata['status'] | 'unavailable' } {
  const status = invitationStatus(row);
  return { id: row.id, ...grant(row), createdBy: row.created_by, createdAt: row.created_at,
    expiresAt: row.expires_at, status: status === 'pending' && row.issuer_available === 0 ? 'unavailable' : status };
}
function preview(row: Row) {
  return { workspaceName: row.workspace_name || 'LIVO', ...grant(row), expiresAt: row.expires_at };
}

async function findInvitation(env: Env, token: unknown): Promise<Row> {
  const scope = parseMemberInvitationToken(token, 'invite');
  if (!scope || typeof token !== 'string') throw new InvitationError('invalid_token');
  if (isDemoWorkspace(env, scope.workspaceId)) throw new InvitationError('demo_blocked', 403);
  const row = await env.DB.prepare(`SELECT i.*,w.name AS workspace_name FROM member_invitations i
    LEFT JOIN workspaces w ON w.id=i.workspace_id
    WHERE i.workspace_id=? AND i.id=? AND i.token_hash=? AND ${openInvitation}`)
    .bind(scope.workspaceId, scope.id, await hashMemberInvitationToken(token), new Date().toISOString()).first<Row>();
  if (!row) throw new InvitationError('invalid_token');
  await pruneInvitationData(env, row.workspace_id);
  return row;
}

async function findConfirmation(env: Env, token: unknown): Promise<Confirmation> {
  const scope = parseMemberInvitationToken(token, 'confirmation');
  if (!scope || typeof token !== 'string') throw new InvitationError('invalid_token');
  if (isDemoWorkspace(env, scope.workspaceId)) throw new InvitationError('demo_blocked', 403);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(`SELECT i.*,w.name AS workspace_name,c.id AS confirmation_id,
      c.expires_at AS confirmation_expires_at,c.name,c.email
    FROM member_invitation_confirmations c JOIN member_invitations i
      ON i.workspace_id=c.workspace_id AND i.id=c.invitation_id
    LEFT JOIN workspaces w ON w.id=i.workspace_id
    WHERE c.workspace_id=? AND c.id=? AND c.token_hash=? AND c.send_state='sent'
      AND c.used_at IS NULL AND c.expires_at>? AND ${openInvitation}`)
    .bind(scope.workspaceId, scope.id, await hashMemberInvitationToken(token), now, now).first<Confirmation>();
  if (!row) throw new InvitationError('invalid_token');
  await pruneInvitationData(env, row.workspace_id);
  return row;
}

/** Logins are global, but member reads stay in this workspace. A conflicting
 * auth-less member elsewhere is caught by the global email UNIQUE constraint
 * during acceptance and rolls back the entire claim, without reading it here. */
async function rejectExistingEmail(env: Env, email: string, ws: string): Promise<void> {
  const existing = await env.DB.prepare(`SELECT 1 AS hit FROM auth_users WHERE email=?1 COLLATE NOCASE
    UNION ALL SELECT 1 FROM members WHERE workspace_id=?2 AND email=?1 COLLATE NOCASE LIMIT 1`).bind(email, ws).first();
  if (existing) throw new InvitationError('email_taken', 409);
}

async function create(c: Context<AppContext>, body: Record<string, unknown>): Promise<Response> {
  if (!hasOnlyKeys(body, ['action', 'role', 'jobTitle', 'isQaAdmin'])) throw new InvitationError('invalid_request');
  const requested = validateInvitationGrant(body);
  if (!requested) throw new InvitationError('invalid_request');
  const actor = await liveMember(c.env, c.get('auth'), { strict: true });
  if (!actor || !canIssueInvitation(actor.role, requested)) throw new InvitationError('forbidden', 403);
  const ws = c.get('auth').member.workspaceId || DEFAULT_WORKSPACE;
  const id = crypto.randomUUID();
  const token = mintMemberInvitationToken('invite', ws, id);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
  const row = await c.env.DB.prepare(`INSERT INTO member_invitations
    (workspace_id,id,token_hash,role,job_title,is_qa_admin,created_by,created_by_auth_id,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`)
    .bind(ws, id, await hashMemberInvitationToken(token), requested.role, requested.jobTitle,
      requested.isQaAdmin ? 1 : 0, actor.id, c.get('auth').userId, now, expires).first<Row>();
  if (!row) throw new InvitationError('forbidden', 403);
  return c.json({ invitation: metadata(row), inviteToken: token,
    inviteUrl: `${appBaseUrl(c.env).replace(/\/$/, '')}/demo/join#invite=${encodeURIComponent(token)}` });
}

async function list(c: Context<AppContext>, body: Record<string, unknown>): Promise<Response> {
  if (!hasOnlyKeys(body, ['action'])) throw new InvitationError('invalid_request');
  const ws = c.get('auth').member.workspaceId || DEFAULT_WORKSPACE;
  const live = liveMemberSql(c.get('auth'), 'm', { strict: true });
  const rows = await c.env.DB.prepare(`SELECT i.*,CASE WHEN ${availableInvitation} THEN 1 ELSE 0 END AS issuer_available
    FROM member_invitations i
    WHERE i.workspace_id=? AND EXISTS(SELECT 1 FROM members m WHERE ${live.sql}
      AND (m.role='super_admin' OR (m.role='admin' AND i.created_by=m.id)))
    ORDER BY i.created_at DESC,i.id DESC LIMIT 100`).bind(ws, ...live.params).all<Row>();
  return c.json({ invitations: rows.results.map(metadata) });
}

async function revoke(c: Context<AppContext>, body: Record<string, unknown>): Promise<Response> {
  if (!hasOnlyKeys(body, ['action', 'invitationId']) || typeof body.invitationId !== 'string') throw new InvitationError('invalid_request');
  const auth = c.get('auth');
  const ws = auth.member.workspaceId || DEFAULT_WORKSPACE;
  const live = liveMemberSql(auth, 'm', { strict: true });
  const updated = await c.env.DB.prepare(`UPDATE member_invitations AS i SET revoked_at=coalesce(i.revoked_at,?)
    WHERE i.workspace_id=? AND i.id=? AND i.used_at IS NULL
      AND EXISTS(SELECT 1 FROM members m WHERE ${live.sql}
        AND (m.role='super_admin' OR (m.role='admin' AND i.created_by=m.id))) RETURNING *`)
    .bind(new Date().toISOString(), ws, body.invitationId, ...live.params).first<Row>();
  if (!updated) throw new InvitationError('forbidden', 403);
  return c.json({ success: true, invitation: metadata(updated) });
}

async function accept(c: Context<AppContext>, body: Record<string, unknown>): Promise<Response> {
  if (!hasOnlyKeys(body, ['action', 'confirmationToken', 'password'])) throw new InvitationError('invalid_request');
  if (!validateInvitePassword(body.password)) throw new InvitationError('password_invalid');
  const confirmation = await findConfirmation(c.env, body.confirmationToken);
  await rejectExistingEmail(c.env, confirmation.email, confirmation.workspace_id);
  const ws = confirmation.workspace_id, id = confirmation.id, authId = crypto.randomUUID(), memberId = crypto.randomUUID();
  const now = new Date().toISOString();
  const prepared = await prepareAuthSession(c.env, authId, confirmation.email);
  const passwordHash = await hashPassword(body.password);
  const proofHash = await hashMemberInvitationToken(body.confirmationToken as string);
  const ownedClaim = `i.workspace_id=?1 AND i.id=?2 AND i.used_auth_id=?3 AND i.used_member_id=?4`;
  // UPDATE with zero rows is not a D1 error. Every later write therefore
  // selects ONLY the claim made with this request's unpredictable new ids.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE member_invitations AS i SET used_at=?1,used_auth_id=?2,used_member_id=?3
      WHERE i.workspace_id=?4 AND i.id=?5 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?1
        AND EXISTS(SELECT 1 FROM member_invitation_confirmations p WHERE p.workspace_id=i.workspace_id AND p.invitation_id=i.id
          AND p.id=?6 AND p.token_hash=?7 AND p.send_state='sent' AND p.used_at IS NULL AND p.expires_at>?1) RETURNING id`)
      .bind(now, authId, memberId, ws, id, confirmation.confirmation_id, proofHash),
    c.env.DB.prepare(`INSERT INTO auth_users(id,email,password_hash,banned,created_at)
      SELECT ?3,p.email,?6,0,?7 FROM member_invitations i JOIN member_invitation_confirmations p
        ON p.workspace_id=i.workspace_id AND p.invitation_id=i.id AND p.id=?5 WHERE ${ownedClaim}`)
      .bind(ws, id, authId, memberId, confirmation.confirmation_id, passwordHash, now),
    c.env.DB.prepare(`INSERT INTO members(workspace_id,id,name,avatar,role,job_title,is_qa_admin,color,email,email_identity_verified,is_active,sort_order,auth_id,theme)
      SELECT i.workspace_id,?4,p.name,?6,i.role,i.job_title,i.is_qa_admin,'#6B778C',p.email,1,1,0,?3,'dark'
      FROM member_invitations i JOIN member_invitation_confirmations p
        ON p.workspace_id=i.workspace_id AND p.invitation_id=i.id AND p.id=?5 WHERE ${ownedClaim} RETURNING *`)
      .bind(ws, id, authId, memberId, confirmation.confirmation_id, confirmation.name.slice(0, 1).toUpperCase()),
    c.env.DB.prepare(`UPDATE member_invitation_confirmations SET used_at=?5
      WHERE workspace_id=?1 AND id=?6 AND invitation_id=?2 AND used_at IS NULL
        AND EXISTS(SELECT 1 FROM member_invitations i WHERE ${ownedClaim})`)
      .bind(ws, id, authId, memberId, now, confirmation.confirmation_id),
    c.env.DB.prepare(`INSERT INTO auth_refresh_tokens(token_hash,user_id,expires_at,created_at)
      SELECT ?5,?3,?6,?7 FROM member_invitations i WHERE ${ownedClaim}`)
      .bind(ws, id, authId, memberId, prepared.tokenHash, prepared.refreshExpiresAt, prepared.createdAt),
  ]);
  const inserted = results[2]?.results[0] as Record<string, unknown> | undefined;
  if (!results[0]?.meta.changes || !inserted) throw new InvitationError('invalid_token');
  clearMemberCache(authId);
  notifyChanges(c.env, c.executionCtx, [{ table: 'members', eventType: 'INSERT',
    new: rowToWire(inserted, TABLES.members), old: null }], ws);
  return c.json({ success: true, session: { ...prepared.session, token_type: 'bearer',
    expires_in: Math.max(0, prepared.session.expires_at - Math.floor(Date.now() / 1000)) } });
}

/** Token possession grants only the stored invitation, never an email identity. */
async function acceptInvite(c: Context<AppContext>, body: Record<string, unknown>): Promise<Response> {
  if (!hasOnlyKeys(body, ['action', 'inviteToken', 'name', 'email', 'password'])) throw new InvitationError('invalid_request');
  const name = validateInviteName(body.name), email = validateInviteEmail(body.email);
  if (!name || !email) throw new InvitationError('invalid_request');
  if (!validateInvitePassword(body.password)) throw new InvitationError('password_invalid');
  const invitation = await findInvitation(c.env, body.inviteToken);
  await rejectExistingEmail(c.env, email, invitation.workspace_id);
  const ws = invitation.workspace_id, id = invitation.id, authId = crypto.randomUUID(), memberId = crypto.randomUUID();
  const now = new Date().toISOString();
  const prepared = await prepareAuthSession(c.env, authId, email);
  const passwordHash = await hashPassword(body.password);
  const tokenHash = await hashMemberInvitationToken(body.inviteToken as string);
  const ownedClaim = `i.workspace_id=?1 AND i.id=?2 AND i.used_auth_id=?3 AND i.used_member_id=?4`;
  // A zero-row CAS must not create a login/member/session. Every later write
  // selects the claim owned by this request's new unpredictable identities.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE member_invitations AS i SET used_at=?1,used_auth_id=?2,used_member_id=?3
      WHERE i.workspace_id=?4 AND i.id=?5 AND i.token_hash=?6 AND i.used_at IS NULL
        AND i.revoked_at IS NULL AND i.expires_at>?1 AND ${availableInvitation} RETURNING id`)
      .bind(now, authId, memberId, ws, id, tokenHash),
    c.env.DB.prepare(`INSERT INTO auth_users(id,email,password_hash,banned,created_at)
      SELECT ?3,?5,?6,0,?7 FROM member_invitations i WHERE ${ownedClaim}`)
      .bind(ws, id, authId, memberId, email, passwordHash, now),
    c.env.DB.prepare(`INSERT INTO members(workspace_id,id,name,avatar,role,job_title,is_qa_admin,color,email,email_identity_verified,is_active,sort_order,auth_id,theme)
      SELECT i.workspace_id,?4,?5,?6,i.role,i.job_title,i.is_qa_admin,'#6B778C',?7,0,1,0,?3,'dark'
      FROM member_invitations i WHERE ${ownedClaim} RETURNING *`)
      .bind(ws, id, authId, memberId, name, name.slice(0, 1).toUpperCase(), email),
    c.env.DB.prepare(`INSERT INTO auth_refresh_tokens(token_hash,user_id,expires_at,created_at)
      SELECT ?5,?3,?6,?7 FROM member_invitations i WHERE ${ownedClaim}`)
      .bind(ws, id, authId, memberId, prepared.tokenHash, prepared.refreshExpiresAt, prepared.createdAt),
  ]);
  const inserted = results[2]?.results[0] as Record<string, unknown> | undefined;
  if (!results[0]?.meta.changes || !inserted) throw new InvitationError('invalid_token');
  clearMemberCache(authId);
  notifyChanges(c.env, c.executionCtx, [{ table: 'members', eventType: 'INSERT',
    new: rowToWire(inserted, TABLES.members), old: null }], ws);
  return c.json({ success: true, session: { ...prepared.session, token_type: 'bearer',
    expires_in: Math.max(0, prepared.session.expires_at - Math.floor(Date.now() / 1000)) } });
}

/** Mixed public/manager endpoint. Caller-controlled action only selects the
 * protocol; it never supplies an authenticated identity or accepted grant. */
export async function handleMemberInvitations(c: Context<AppContext>): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  try {
    const raw = await c.req.text();
    if (raw.length > 8192) throw new InvitationError('invalid_request');
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new InvitationError('invalid_request'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvitationError('invalid_request');
    const body = value as Record<string, unknown>;
    if (['create', 'list', 'revoke'].includes(String(body.action))) {
      const denied = await requireMember(c, async () => {});
      if (denied) return c.json({ error: 'forbidden', message: 'forbidden' }, denied.status === 403 ? 403 : 401);
      const auth = c.get('auth');
      if (isApiKeyCaller(auth)) throw new InvitationError('api_key_forbidden', 403);
      if (isDemoMember(c.env, auth)) throw new InvitationError('demo_blocked', 403);
      const actor = await liveMember(c.env, auth, { strict: true });
      if (!actor || !['admin', 'super_admin'].includes(actor.role)) throw new InvitationError('forbidden', 403);
      await pruneInvitationData(c.env, auth.member.workspaceId || DEFAULT_WORKSPACE);
      if (body.action === 'create') return await create(c, body);
      if (body.action === 'list') return await list(c, body);
      return await revoke(c, body);
    }
    if (body.action === 'preview') {
      if (!hasOnlyKeys(body, ['action', 'inviteToken'])) throw new InvitationError('invalid_request');
      return c.json(preview(await findInvitation(c.env, body.inviteToken)));
    }
    // Retired: shared links no longer send confirmation messages. Already
    // emailed legacy proofs can still be previewed and accepted below.
    if (body.action === 'request_confirmation') throw new InvitationError('invalid_request');
    if (body.action === 'accept_invite') return await acceptInvite(c, body);
    if (body.action === 'confirmation_preview') {
      if (!hasOnlyKeys(body, ['action', 'confirmationToken'])) throw new InvitationError('invalid_request');
      const row = await findConfirmation(c.env, body.confirmationToken);
      return c.json({ ...preview(row), name: row.name, email: row.email, expiresAt: row.confirmation_expires_at });
    }
    if (body.action === 'accept') return await accept(c, body);
    throw new InvitationError('invalid_request');
  } catch (error) {
    if (error instanceof InvitationError) return c.json({ error: error.code, message: error.code }, error.status);
    // Never echo a database/provider error or the request: they may contain
    // credentials, addresses or another workspace's member information.
    const message = error instanceof Error ? error.message : '';
    const code: InvitationErrorCode = message.includes('invitation_rate_limited') ? 'rate_limited'
      : message.includes('invitation_member_limit') ? 'member_limit'
        : message.includes('invitation_forbidden') ? 'forbidden'
          : message.includes('invitation_invalid') ? 'invalid_token'
            : /UNIQUE constraint failed: (auth_users\.email|members\.email)/i.test(message) ? 'email_taken' : 'server_error';
    const status = code === 'rate_limited' ? 429 : code === 'member_limit' || code === 'email_taken' ? 409
      : code === 'forbidden' ? 403 : code === 'invalid_token' ? 400 : 503;
    return c.json({ error: code, message: code }, status);
  }
}
