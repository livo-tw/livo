import {
  canIssueInvitation, hasOnlyKeys, hashMemberInvitationToken, invitationStatus,
  mintMemberInvitationToken, parseMemberInvitationToken, validateInvitationGrant,
  validateInviteEmail, validateInviteName, validateInvitePassword,
  type InvitationErrorCode, type InvitationGrant, type InvitationMetadata,
} from './core.ts';

export interface InvitationRow {
  id: string; role: InvitationGrant['role']; job_title: string; is_qa_admin: boolean;
  created_by: string; created_at: string; expires_at: string; used_at: string | null; revoked_at: string | null;
  status?: InvitationMetadata['status'] | 'unavailable';
}
type InvitationListMetadata = Omit<InvitationMetadata, 'status'> & { status: InvitationMetadata['status'] | 'unavailable' };
export interface ConfirmationRow extends InvitationRow { name: string; email: string }
export interface InvitationCaller { authId: string; memberId: string; role: string; apiKey: boolean }
export interface InvitationMail { appUrl: string; apiKey: string; fromAddress: string }
export class InvitationFailure extends Error {
  constructor(public code: InvitationErrorCode, public status = 400) { super(code); }
}

export interface InvitationBackend {
  prune(): Promise<void>;
  caller(request: Request): Promise<InvitationCaller>;
  appUrl(): string;
  mail(): Promise<InvitationMail | null>;
  create(caller: InvitationCaller, id: string, hash: string, grant: InvitationGrant): Promise<InvitationRow>;
  list(caller: InvitationCaller): Promise<InvitationRow[]>;
  revoke(caller: InvitationCaller, id: string): Promise<void>;
  preview(id: string, hash: string): Promise<InvitationRow>;
  reserve(inviteId: string, inviteHash: string, id: string, hash: string, name: string, email: string): Promise<ConfirmationRow>;
  finishSend(id: string, hash: string, sent: boolean): Promise<boolean>;
  confirmationPreview(id: string, hash: string): Promise<ConfirmationRow>;
  send(mail: InvitationMail, to: { name: string; email: string }, link: string): Promise<boolean>;
  createAuth(email: string, password: string, name: string, proof: { confirmationId: string; tokenHash: string }): Promise<string>;
  accept(id: string, hash: string, authId: string, memberId: string): Promise<void>;
  deleteCreatedAuth(id: string, proof: { confirmationId: string; tokenHash: string }): Promise<boolean>;
  createDirectAuth(email: string, password: string, name: string, proof: { invitationId: string; tokenHash: string }): Promise<string>;
  acceptDirect(id: string, hash: string, authId: string, memberId: string, name: string, email: string): Promise<void>;
  session(email: string, password: string): Promise<unknown | null>;
}

function metadata(row: InvitationRow): InvitationListMetadata {
  return { id: row.id, role: row.role, jobTitle: row.job_title, isQaAdmin: row.is_qa_admin,
    createdBy: row.created_by, createdAt: row.created_at, expiresAt: row.expires_at, status: row.status ?? invitationStatus(row) };
}
function preview(row: InvitationRow) {
  return { workspaceName: 'LIVO', role: row.role, jobTitle: row.job_title, isQaAdmin: row.is_qa_admin, expiresAt: row.expires_at };
}
const HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

export function createInvitationHandler(backend: InvitationBackend) {
  return async (request: Request): Promise<Response> => {
    const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
    if (request.method !== 'POST') return respond({ error: 'invalid_request' }, 405);
    try {
      const raw = await request.text();
      if (raw.length > 8192) throw new InvitationFailure('invalid_request');
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new InvitationFailure('invalid_request'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new InvitationFailure('invalid_request');
      const body = parsed as Record<string, unknown>;
      const action = body.action;
      if (typeof action !== 'string' || !['create', 'list', 'revoke', 'preview', 'accept_invite', 'confirmation_preview', 'accept'].includes(action))
        throw new InvitationFailure('invalid_request');
      await backend.prune();
      if (action === 'create' || action === 'list' || action === 'revoke') {
        const caller = await backend.caller(request);
        if (caller.apiKey) throw new InvitationFailure('api_key_forbidden', 403);
        if (caller.role !== 'admin' && caller.role !== 'super_admin') throw new InvitationFailure('forbidden', 403);
        if (action === 'create') {
          if (!hasOnlyKeys(body, ['action', 'role', 'jobTitle', 'isQaAdmin'])) throw new InvitationFailure('invalid_request');
          const grant = validateInvitationGrant(body);
          if (!grant) throw new InvitationFailure('invalid_request');
          if (!canIssueInvitation(caller.role, grant)) throw new InvitationFailure('forbidden', 403);
          // Validate the canonical base before minting a link. Never trust a caller Origin.
          const appUrl = backend.appUrl();
          const id = crypto.randomUUID();
          const token = mintMemberInvitationToken('invite', 'default', id);
          const invitation = await backend.create(caller, id, await hashMemberInvitationToken(token), grant);
          return respond({ invitation: metadata(invitation), inviteToken: token, inviteUrl: `${appUrl}/join#invite=${encodeURIComponent(token)}` });
        }
        if (action === 'list') {
          if (!hasOnlyKeys(body, ['action'])) throw new InvitationFailure('invalid_request');
          return respond({ invitations: (await backend.list(caller)).map(metadata) });
        }
        if (!hasOnlyKeys(body, ['action', 'invitationId']) || typeof body.invitationId !== 'string' || body.invitationId.length > 200)
          throw new InvitationFailure('invalid_request');
        await backend.revoke(caller, body.invitationId);
        return respond({ success: true });
      }
      if (action === 'preview' || action === 'accept_invite') {
        const allowed = action === 'preview' ? ['action', 'inviteToken'] : ['action', 'inviteToken', 'name', 'email', 'password'];
        if (!hasOnlyKeys(body, allowed)) throw new InvitationFailure('invalid_request');
        const scope = parseMemberInvitationToken(body.inviteToken, 'invite');
        if (!scope || scope.workspaceId !== 'default') throw new InvitationFailure('invalid_token', 409);
        const hash = await hashMemberInvitationToken(body.inviteToken as string);
        if (action === 'preview') return respond(preview(await backend.preview(scope.id, hash)));
        const name = validateInviteName(body.name), email = validateInviteEmail(body.email);
        if (!name || !email) throw new InvitationFailure('invalid_request');
        if (!validateInvitePassword(body.password)) throw new InvitationFailure('password_invalid');
        // Read-only eligibility first; the acceptance RPC rechecks after taking its lock.
        await backend.preview(scope.id, hash);
        const password = body.password as string;
        const proof = { invitationId: scope.id, tokenHash: hash };
        const authId = await backend.createDirectAuth(email, password, name, proof);
        try {
          await backend.acceptDirect(scope.id, hash, authId, crypto.randomUUID(), name, email);
        } catch {
          // No direct-flow auth deletion: an uncertain attachment stays isolated
          // behind the active-member gate until a super_admin inspects it.
          console.warn('[member-invitations] direct member attachment requires manual inspection');
          throw new InvitationFailure('registration_pending', 503);
        }
        // A self-entered Email is a login identifier, not proof of its ownership.
        let session: unknown | null = null;
        try { session = await backend.session(email, password); }
        catch { console.warn('[member-invitations] joined directly; session unavailable'); }
        return respond({ success: true, session });
      }
      if (action === 'confirmation_preview' || action === 'accept') {
        if (!hasOnlyKeys(body, action === 'accept' ? ['action', 'confirmationToken', 'password'] : ['action', 'confirmationToken']))
          throw new InvitationFailure('invalid_request');
        const scope = parseMemberInvitationToken(body.confirmationToken, 'confirmation');
        if (!scope || scope.workspaceId !== 'default') throw new InvitationFailure('invalid_token', 409);
        const hash = await hashMemberInvitationToken(body.confirmationToken as string);
        if (action === 'accept' && !validateInvitePassword(body.password)) throw new InvitationFailure('password_invalid');
        const confirmation = await backend.confirmationPreview(scope.id, hash);
        if (action === 'confirmation_preview') return respond({ ...preview(confirmation), name: confirmation.name, email: confirmation.email });
        const password = body.password as string;
        // GoTrue's atomic new-email create must succeed; never reset/adopt an existing login.
        const proof = { confirmationId: scope.id, tokenHash: hash };
        const authId = await backend.createAuth(confirmation.email, password, confirmation.name, proof);
        try {
          await backend.accept(scope.id, hash, authId, crypto.randomUUID());
        } catch (error) {
          if (!await backend.deleteCreatedAuth(authId, proof)) console.error('[member-invitations] newly created login cleanup failed; manual recovery required');
          throw error;
        }
        // Joining is committed. A transport failure here must not replay a consumed invitation.
        let session: unknown | null = null;
        try { session = await backend.session(confirmation.email, password); }
        catch { console.warn('[member-invitations] joined; session unavailable'); }
        return respond({ success: true, session });
      }
      throw new InvitationFailure('invalid_request');
    } catch (error) {
      if (error instanceof InvitationFailure) return respond({ error: error.code }, error.status);
      console.error('[member-invitations] unexpected request failure');
      return respond({ error: 'server_error' }, 500);
    }
  };
}
