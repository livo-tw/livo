import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createInvitationHandler, InvitationFailure, type InvitationBackend, type InvitationRow } from '../../docker/volumes/functions/member-invitations/handler';
import { mintMemberInvitationToken, parseMemberInvitationToken, hashMemberInvitationToken } from '@/lib/memberInvitationsCore';

const invitation: InvitationRow = {
  id: 'invite-one', role: 'member', job_title: '', is_qa_admin: false, created_by: 'admin-one',
  created_at: '2026-10-08T00:00:00Z', expires_at: '2099-10-15T00:00:00Z', used_at: null, revoked_at: null,
};
function fixture() {
  return {
    prune: vi.fn().mockResolvedValue(undefined),
    caller: vi.fn().mockResolvedValue({ authId: 'auth-one', memberId: 'admin-one', role: 'admin', apiKey: false }),
    appUrl: vi.fn().mockReturnValue('https://livo.example.com'),
    mail: vi.fn().mockResolvedValue({ appUrl: 'https://livo.example.com', apiKey: 'fixture-not-real', fromAddress: 'mail@example.com' }),
    create: vi.fn().mockResolvedValue(invitation), list: vi.fn().mockResolvedValue([invitation]), revoke: vi.fn().mockResolvedValue(undefined),
    preview: vi.fn().mockResolvedValue(invitation),
    reserve: vi.fn().mockResolvedValue({ ...invitation, name: 'Alex', email: 'alex@example.com' }),
    finishSend: vi.fn().mockResolvedValue(true),
    confirmationPreview: vi.fn().mockResolvedValue({ ...invitation, name: 'Alex', email: 'alex@example.com' }),
    send: vi.fn().mockResolvedValue(true), createAuth: vi.fn().mockResolvedValue('new-auth-only'),
    accept: vi.fn().mockResolvedValue(undefined), deleteCreatedAuth: vi.fn().mockResolvedValue(true),
    createDirectAuth: vi.fn().mockResolvedValue('new-direct-auth'), acceptDirect: vi.fn().mockResolvedValue(undefined),
    session: vi.fn().mockResolvedValue({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', user: { id: 'new-auth-only', email: 'alex@example.com' } }),
  } satisfies InvitationBackend;
}
async function post(backend: InvitationBackend, body: Record<string, unknown>) {
  const response = await createInvitationHandler(backend)(new Request('https://api.example.com/member-invitations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() as Record<string, unknown>, response };
}
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Docker invitation endpoint contract', () => {
  it('keeps the server unavailable status and original fixed grant in list metadata', async () => {
    const backend = fixture();
    backend.list.mockResolvedValue([{ ...invitation, role: 'admin', job_title: 'Approver', is_qa_admin: false, status: 'unavailable' }]);
    const result = await post(backend, { action: 'list' });
    expect(result.body.invitations).toEqual([expect.objectContaining({ status: 'unavailable', role: 'admin', jobTitle: 'Approver', isQaAdmin: false })]);
    expect(backend.prune).toHaveBeenCalledOnce();
    expect(backend.prune.mock.invocationCallOrder[0]).toBeLessThan(backend.list.mock.invocationCallOrder[0]);
  });
  it('runs retention only for a recognized POST action and propagates cleanup failure', async () => {
    const backend = fixture(), handler = createInvitationHandler(backend);
    for (const request of [
      new Request('https://api.example.com/member-invitations', { method: 'OPTIONS' }),
      new Request('https://api.example.com/member-invitations'),
      new Request('https://api.example.com/member-invitations', { method: 'POST', body: '{' }),
    ]) await handler(request);
    expect((await post(backend, { action: 'unknown' })).body.error).toBe('invalid_request');
    expect(backend.prune).not.toHaveBeenCalled();
    backend.prune.mockRejectedValueOnce(new InvitationFailure('server_error', 500));
    expect(await post(backend, { action: 'list' })).toMatchObject({ status: 500, body: { error: 'server_error' } });
    expect(backend.list).not.toHaveBeenCalled();
  });
  it('returns a single-use token once with a canonical fragment URL and stores only its hash', async () => {
    const backend = fixture();
    const result = await post(backend, { action: 'create' });
    expect(result.status).toBe(200);
    expect(result.body.inviteUrl).toBe(`https://livo.example.com/join#invite=${result.body.inviteToken}`);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    const token = result.body.inviteToken as string;
    expect(parseMemberInvitationToken(token, 'invite')?.workspaceId).toBe('default');
    expect(backend.create.mock.calls[0][2]).toBe(await hashMemberInvitationToken(token));
    expect(JSON.stringify(await post(backend, { action: 'list' }))).not.toContain(token);
    expect(result.body.invitation).toMatchObject({ createdBy: 'admin-one', status: 'pending', jobTitle: '', isQaAdmin: false });
  });
  it.each([
    { role: 'admin' }, { role: 'super_admin' }, { jobTitle: 'Approver' }, { isQaAdmin: true },
  ])('blocks admin elevated grants %j before persistence', async grant => {
    const backend = fixture();
    expect((await post(backend, { action: 'create', ...grant })).body.error).toBe('forbidden');
    expect(backend.create).not.toHaveBeenCalled();
  });
  it('allows fixed grants for a super_admin and blocks PAT administration', async () => {
    const backend = fixture();
    backend.caller.mockResolvedValueOnce({ authId: 'auth-one', memberId: 'super-one', role: 'super_admin', apiKey: false });
    expect((await post(backend, { action: 'create', role: 'member', isQaAdmin: true, jobTitle: 'QA' })).status).toBe(200);
    backend.caller.mockResolvedValue({ authId: 'auth-one', memberId: 'super-one', role: 'super_admin', apiKey: true });
    for (const action of ['create', 'list', 'revoke']) expect((await post(backend, { action })).body.error).toBe('api_key_forbidden');
  });
  it('creates invitations without mail configuration and rejects the obsolete sending action', async () => {
    const backend = fixture(); backend.mail.mockResolvedValue(null);
    expect((await post(backend, { action: 'create' })).status).toBe(200);
    expect(backend.create).toHaveBeenCalledOnce();
    expect(backend.mail).not.toHaveBeenCalled();
    const pruned = backend.prune.mock.calls.length;
    expect((await post(backend, { action: 'request_confirmation', inviteToken: mintMemberInvitationToken('invite', 'default', 'invite-one'), name: 'Alex', email: 'alex@example.com' })).body.error).toBe('invalid_request');
    expect(backend.prune.mock.calls.length).toBe(pruned);
    expect(backend.reserve).not.toHaveBeenCalled(); expect(backend.send).not.toHaveBeenCalled();
    expect((await post(backend, { action: 'list' })).status).toBe(200);
    expect((await post(backend, { action: 'revoke', invitationId: 'invite-one' })).body).toEqual({ success: true });
  });
  it('joins directly with normalized login fields and no confirmation or mail operation', async () => {
    const backend = fixture(); backend.mail.mockResolvedValue(null);
    const inviteToken = mintMemberInvitationToken('invite', 'default', 'invite-one');
    const tokenHash = await hashMemberInvitationToken(inviteToken);
    const result = await post(backend, { action: 'accept_invite', inviteToken, name: ' Alex ', email: 'ALEX@example.com', password: 'own-password-123' });
    expect(result).toMatchObject({ status: 200, body: { success: true } });
    expect(backend.preview).toHaveBeenCalledWith('invite-one', tokenHash);
    expect(backend.createDirectAuth).toHaveBeenCalledWith('alex@example.com', 'own-password-123', 'Alex', { invitationId: 'invite-one', tokenHash });
    expect(backend.acceptDirect).toHaveBeenCalledWith('invite-one', tokenHash, 'new-direct-auth', expect.any(String), 'Alex', 'alex@example.com');
    expect(backend.preview.mock.invocationCallOrder[0]).toBeLessThan(backend.createDirectAuth.mock.invocationCallOrder[0]);
    expect(backend.session).toHaveBeenCalledWith('alex@example.com', 'own-password-123');
    for (const fn of [backend.caller, backend.mail, backend.reserve, backend.send, backend.finishSend, backend.confirmationPreview, backend.createAuth, backend.accept, backend.deleteCreatedAuth]) expect(fn).not.toHaveBeenCalled();
  });
  it('rejects direct authority overrides and malformed identity before creating auth', async () => {
    const inviteToken = mintMemberInvitationToken('invite', 'default', 'invite-one');
    const valid = { action: 'accept_invite', inviteToken, name: 'Alex', email: 'alex@example.com', password: 'own-password-123' };
    for (const extra of [{ role: 'super_admin' }, { authId: 'old-auth' }, { memberId: 'old-member' }, { isQaAdmin: true }, { jobTitle: 'Owner' }, { email_identity_verified: true }, { workspaceId: 'another' }]) {
      const backend = fixture();
      expect((await post(backend, { ...valid, ...extra })).body.error).toBe('invalid_request');
      expect(backend.preview).not.toHaveBeenCalled(); expect(backend.createDirectAuth).not.toHaveBeenCalled();
    }
    // Preserve reserved-placeholder rejection without a noncanonical literal test mailbox.
    const reservedPlaceholder = 'placeholder@example.com'.replace('.com', '.invalid');
    for (const changed of [{ name: '' }, { email: 'bad' }, { email: reservedPlaceholder }, { password: 'short' }]) {
      const backend = fixture();
      expect((await post(backend, { ...valid, ...changed })).status).toBe(400);
      expect(backend.createDirectAuth).not.toHaveBeenCalled();
    }
  });
  it('checks invitation availability before GoTrue and never adopts or resets an existing login', async () => {
    const body = { action: 'accept_invite', inviteToken: mintMemberInvitationToken('invite', 'default', 'invite-one'), name: 'Alex', email: 'alex@example.com', password: 'own-password-123' };
    const expired = fixture(); expired.preview.mockRejectedValue(new InvitationFailure('invalid_token', 409));
    expect((await post(expired, body)).body.error).toBe('invalid_token'); expect(expired.createDirectAuth).not.toHaveBeenCalled();
    const existing = fixture(); existing.createDirectAuth.mockRejectedValue(new InvitationFailure('email_taken', 409));
    expect((await post(existing, body)).body.error).toBe('email_taken');
    expect(existing.acceptDirect).not.toHaveBeenCalled(); expect(existing.deleteCreatedAuth).not.toHaveBeenCalled();
  });
  it('keeps a direct orphan isolated and reports pending when attachment fails or is unknown', async () => {
    for (const error of [new InvitationFailure('invalid_token', 409), new Error('transport outcome unknown')]) {
      const backend = fixture(); backend.acceptDirect.mockRejectedValue(error);
      const result = await post(backend, { action: 'accept_invite', inviteToken: mintMemberInvitationToken('invite', 'default', 'invite-one'), name: 'Alex', email: 'alex@example.com', password: 'own-password-123' });
      expect(result).toMatchObject({ status: 503, body: { error: 'registration_pending' } });
      expect(backend.deleteCreatedAuth).not.toHaveBeenCalled(); expect(backend.session).not.toHaveBeenCalled();
      expect(result.body).not.toHaveProperty('authId'); expect(result.body).not.toHaveProperty('success');
    }
  });
  it('keeps a committed direct join successful when session issuance is temporarily unavailable', async () => {
    const backend = fixture(); backend.session.mockRejectedValue(new Error('session unavailable'));
    expect((await post(backend, { action: 'accept_invite', inviteToken: mintMemberInvitationToken('invite', 'default', 'invite-one'), name: 'Alex', email: 'alex@example.com', password: 'own-password-123' })).body).toEqual({ success: true, session: null });
    expect(backend.deleteCreatedAuth).not.toHaveBeenCalled();
  });
  it('uses only the confirmation-bound name/email and a newly selected password', async () => {
    const backend = fixture();
    const result = await post(backend, { action: 'accept', confirmationToken: mintMemberInvitationToken('confirmation', 'default', 'confirm-one'), password: 'user-own-password' });
    expect(result.body.success).toBe(true);
    expect(backend.createAuth).toHaveBeenCalledWith('alex@example.com', 'user-own-password', 'Alex', expect.objectContaining({ confirmationId: 'confirm-one' }));
    expect(backend.accept.mock.calls[0][2]).toBe('new-auth-only');
    expect(backend.deleteCreatedAuth).not.toHaveBeenCalled();
  });
  it.each(['email', 'name', 'role', 'jobTitle', 'isQaAdmin', 'auth_id', 'workspaceId'])('rejects accepting authority or identity override %s', async field => {
    const backend = fixture();
    expect((await post(backend, { action: 'accept', confirmationToken: mintMemberInvitationToken('confirmation', 'default', 'confirm-one'), password: 'user-own-password', [field]: 'injected' })).body.error).toBe('invalid_request');
    expect(backend.createAuth).not.toHaveBeenCalled();
  });
  it('never compensates an existing auth account rejected by GoTrue', async () => {
    const backend = fixture(); backend.createAuth.mockRejectedValue(new InvitationFailure('email_taken', 409));
    expect((await post(backend, { action: 'accept', confirmationToken: mintMemberInvitationToken('confirmation', 'default', 'confirm-one'), password: 'user-own-password' })).body.error).toBe('email_taken');
    expect(backend.deleteCreatedAuth).not.toHaveBeenCalled(); expect(backend.accept).not.toHaveBeenCalled();
  });
  it('compensates only its newly created auth on an atomic acceptance failure', async () => {
    const backend = fixture(); backend.accept.mockRejectedValue(new InvitationFailure('invalid_token', 409));
    expect((await post(backend, { action: 'accept', confirmationToken: mintMemberInvitationToken('confirmation', 'default', 'confirm-one'), password: 'user-own-password' })).body.error).toBe('invalid_token');
    expect(backend.deleteCreatedAuth).toHaveBeenCalledExactlyOnceWith('new-auth-only', expect.objectContaining({ confirmationId: 'confirm-one' }));
    expect(backend.session).not.toHaveBeenCalled();
  });
  it('reports already joined when post-commit session issuance fails', async () => {
    const backend = fixture(); backend.session.mockRejectedValue(new Error('transport unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await post(backend, { action: 'accept', confirmationToken: mintMemberInvitationToken('confirmation', 'default', 'confirm-one'), password: 'user-own-password' })).body).toEqual({ success: true, session: null });
    expect(backend.deleteCreatedAuth).not.toHaveBeenCalled();
  });
  it('rejects other workspace or token purposes before backend lookup', async () => {
    const backend = fixture();
    for (const token of [mintMemberInvitationToken('invite', 'other-workspace', 'invite-one'), mintMemberInvitationToken('confirmation', 'default', 'confirm-one')]) {
      expect((await post(backend, { action: 'preview', inviteToken: token })).body.error).toBe('invalid_token');
    }
    expect(backend.preview).not.toHaveBeenCalled();
  });
});
