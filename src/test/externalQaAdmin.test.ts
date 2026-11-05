// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createExternalQaAdminHandler } from '../../docker/volumes/functions/external-qa-admin/handler';
import { PAT_JWT_MARKER } from '../../docker/volumes/functions/api-tokens/core';

const registrationId = '11111111-1111-4111-8111-111111111111';
const accountId = 'eqa-example-account';
const account = {
  id: accountId, email: 'external@example.com', name: 'Example QA', isActive: true,
  revision: 1, projectIds: ['project-a'], registrationId, credentialRecoveryAvailable: true,
};
const create = {
  action: 'create', requestId: registrationId, name: account.name,
  email: account.email, isActive: true, projectIds: account.projectIds,
};
const token = (claims: object = {}) =>
  'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
const request = (body: unknown, bearer = token()) => new Request('https://example.test/functions/v1/external-qa-admin', {
  method: 'POST', headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function fixture() {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>): Promise<{ data: any; error: any }> => {
    if (name === 'livo_external_qa_registration_list') return { data: [account], error: null };
    if (args.p_action === 'reserve') return {
      data: { registrationId, nonce: 'server-only-nonce', id: accountId, email: account.email, authRequired: true }, error: null,
    };
    return { data: { account, registrationId, authRequired: false }, error: null };
  });
  const createUser = vi.fn(async (_input: Record<string, unknown>) => ({ data: { user: { id: 'new-auth' } }, error: null }));
  const client = { rpc, auth: {
    getUser: vi.fn(async () => ({ data: { user: { id: 'admin-auth' } }, error: null })),
    admin: { createUser },
  } };
  return { rpc, createUser, client, handle: createExternalQaAdminHandler(client) };
}

describe('external QA interactive identity administration', () => {
  it('reserves a server-owned identity before creating its GoTrue login', async () => {
    const f = fixture();
    const result = await f.handle(request({ ...create, initialPassword: 'Example-password-8' }));
    expect(result.status).toBe(201);
    const data = await result.json();
    expect(data).toMatchObject({ account, temporaryPassword: 'Example-password-8' });
    expect(f.rpc.mock.invocationCallOrder[0]).toBeLessThan(f.createUser.mock.invocationCallOrder[0]);
    expect(f.createUser.mock.calls[0][0]).toMatchObject({
      email: account.email, password: 'Example-password-8', email_confirm: true,
      app_metadata: {
        livo_external_qa: true, livo_external_qa_registration: registrationId,
        livo_external_qa_nonce: 'server-only-nonce', livo_external_qa_password_change_required: true,
      },
      user_metadata: { livo_password_change_required: true },
    });
    expect(data).not.toHaveProperty('nonce');
  });

  it.each(['create', 'update', 'recover'])('rejects a verified PAT before %s writes', async action => {
    const f = fixture();
    const result = await f.handle(request({ ...create, action }, PAT_JWT_MARKER + 'fixture.signature'));
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: 'api_key_forbidden' });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.createUser).not.toHaveBeenCalled();
  });

  it.each(['short', '😀'.repeat(7), 'a'.repeat(73), '界'.repeat(25)])('refuses invalid initial password length', async password => {
    const f = fixture();
    expect((await f.handle(request({ ...create, initialPassword: password }))).status).toBe(400);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.createUser).not.toHaveBeenCalled();
  });

  it('accepts eight Unicode characters within bcrypt byte limits', async () => {
    const f = fixture();
    expect((await f.handle(request({ ...create, initialPassword: '😀'.repeat(8) }))).status).toBe(201);
  });

  it('generates a credential when no explicit password is supplied', async () => {
    const f = fixture();
    const result = await f.handle(request(create));
    const data = await result.json();
    expect(result.status).toBe(201);
    expect(data.temporaryPassword).toMatch(/^[a-f0-9]{32}!Aa1$/);
  });

  it('does not create another login or return a guessed password on a repeated command', async () => {
    const f = fixture();
    f.rpc.mockImplementation(async (_name, args) => args.p_action === 'reserve'
      ? { data: { registrationId, authRequired: false }, error: null }
      : { data: { account, registrationId, authRequired: false }, error: null });
    const result = await f.handle(request(create));
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: 'external_qa_registration_pending', registrationId });
    expect(f.createUser).not.toHaveBeenCalled();
  });

  it('reconciles an uncertain GoTrue response without handing out a credential', async () => {
    const f = fixture();
    f.createUser.mockResolvedValue({ data: { user: null }, error: { status: 500 } } as any);
    const result = await f.handle(request(create));
    expect(result.status).toBe(409);
    expect(await result.json()).not.toHaveProperty('temporaryPassword');
    expect(f.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_action: 'reconcile', p_registration_id: registrationId });
  });

  it('retains the pending reservation when auth transport fails', async () => {
    const f = fixture();
    f.createUser.mockRejectedValue(new Error('transport unavailable'));
    const result = await f.handle(request(create));
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: 'external_qa_registration_pending', registrationId });
  });

  it('keeps the caller revision through recovery even if a read sees a concurrent edit', async () => {
    const f = fixture();
    f.rpc.mockImplementation(async (_name, args) => ({
      data: { account: { ...account, revision: args.p_action === 'prepare_recovery' ? 4 : 9 }, registrationId, authRequired: false },
      error: null,
    }));
    const result = await f.handle(request({ action: 'recover', id: accountId, revision: 4, registrationId }));
    expect(result.status).toBe(200);
    expect(f.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_action: 'recover', p_revision: 4, p_account_id: accountId });
    expect(f.createUser).not.toHaveBeenCalled();
  });

  it('allows only the reserved pending account transition from revision zero to one', async () => {
    const f = fixture();
    f.rpc.mockImplementation(async (_name, args) => args.p_action === 'prepare_recovery'
      ? { data: { registrationId, nonce: 'server-only-nonce', email: account.email, authRequired: true }, error: null }
      : { data: { account, registrationId, authRequired: false }, error: null });
    expect((await f.handle(request({ action: 'recover', id: accountId, revision: 0, registrationId }))).status).toBe(200);
    expect(f.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_action: 'recover', p_revision: 1 });
  });

  it('withholds recovery credentials after a concurrent completed first sign-in', async () => {
    const f = fixture();
    f.rpc.mockImplementation(async (_name, args) => args.p_action === 'recover'
      ? { data: null, error: { code: 'PT409', message: 'external_qa_already_onboarded' } } as any
      : { data: { account, registrationId, authRequired: false }, error: null });
    const result = await f.handle(request({ action: 'recover', id: accountId, revision: 1, registrationId }));
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: 'external_qa_already_onboarded' });
  });
});
