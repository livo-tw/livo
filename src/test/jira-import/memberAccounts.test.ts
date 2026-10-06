// @vitest-environment node
// Docker memberAccounts.ts helpers: invitation link base and API-key tokens.
import { afterEach, describe, expect, it, vi } from 'vitest';

const env = new Map<string, string>();
vi.stubGlobal('Deno', { env: { get: (k: string) => env.get(k) } });
// A runtime path keeps this Deno file out of the app's type check (no Deno types there).
const MEMBER_ACCOUNTS = '../../../docker/volumes/functions/manage-member/memberAccounts.ts';
const { isApiKeyToken, isLocalHostname, resolveAppUrl, unusablePassword, configuredInitialPassword, prepareLogin, deliverLogin, adminSetPassword, PASSWORD_CHANGE_FLAG } = await import(/* @vite-ignore */ MEMBER_ACCOUNTS);

const req = (origin?: string) => new Request('http://functions:9000/manage-member', { headers: origin ? { Origin: origin } : {} });
const b64u = (s: string) => Buffer.from(s).toString('base64url');
const jwt = (payload: object) => `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify(payload))}.sig`;

afterEach(() => env.clear());

describe('invitation link base', () => {
  it('prefers a real APP_BASE_URL', () => {
    env.set('APP_BASE_URL', 'https://pm.example.com/');
    expect(resolveAppUrl(req('https://other.example.com'))).toBe('https://pm.example.com');
  });

  it('ignores the factory localhost value when the browser origin is known', () => {
    for (const local of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      env.set('APP_BASE_URL', local);
      expect(resolveAppUrl(req('https://pm.example.com'))).toBe('https://pm.example.com');
    }
  });

  it('falls back to APP_BASE_URL, then to nothing', () => {
    env.set('APP_BASE_URL', 'http://localhost:3000');
    expect(resolveAppUrl(req())).toBe('http://localhost:3000');
    env.clear();
    expect(resolveAppUrl(req('https://pm.example.com'))).toBe('https://pm.example.com');
    expect(resolveAppUrl(req())).toBeNull();
    expect(resolveAppUrl(req('null'))).toBeNull();
  });

  it('knows loopback names', () => {
    expect(['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '0.0.0.0'].every(isLocalHostname)).toBe(true);
    expect(['pm.example.com', '192.168.1.20', 'localhost.example.com'].some(isLocalHostname)).toBe(false);
  });
});

describe('API-key tokens', () => {
  it('spots the livo_pat claim', () => {
    expect(isApiKeyToken(jwt({ livo_pat: 'tok-1', sub: 'u', role: 'authenticated' }))).toBe(true);
    expect(isApiKeyToken(jwt({ sub: 'u', role: 'authenticated', session_id: 's' }))).toBe(false);
    expect(isApiKeyToken('not-a-jwt')).toBe(false);
    expect(isApiKeyToken('')).toBe(false);
  });
});

describe('unusablePassword', () => {
  // GoTrue hashes with bcrypt and refuses (or crashes on) passwords over 72 bytes:
  // a 76-character throwaway made "add member" without a password fail.
  it('stays within 72 bytes and covers every character class', () => {
    for (let i = 0; i < 20; i++) {
      const password = unusablePassword();
      expect(new TextEncoder().encode(password).length).toBeLessThanOrEqual(72);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[^A-Za-z0-9]/);
    }
    expect(unusablePassword()).not.toBe(unusablePassword());
  });
});


describe('self-host account initial password', () => {
  const interactive = jwt({ sub: 'user-example', role: 'authenticated', session_id: 'session-example' });
  it('keeps the normal default when no deployment setting is present', () => {
    expect(configuredInitialPassword('super_admin', interactive)).toBeNull();
  });
  it('limits the configured value to an interactive super_admin', () => {
    env.set('MEMBER_DEFAULT_PASSWORD', 'ExampleInitial42');
    expect(configuredInitialPassword('super_admin', interactive)).toBe('ExampleInitial42');
    expect(configuredInitialPassword('admin', interactive)).toBeNull();
    expect(configuredInitialPassword('member', interactive)).toBeNull();
    expect(configuredInitialPassword('super_admin', jwt({ livo_pat: 'example-token' }))).toBeNull();
  });
  it('rejects invalid configured values before provisioning', () => {
    for (const invalid of ['short', 'x'.repeat(73), '密'.repeat(25)]) {
      env.set('MEMBER_DEFAULT_PASSWORD', invalid);
      expect(() => configuredInitialPassword('super_admin', interactive)).toThrow('member_default_password_invalid');
    }
  });
  it('provisions and returns the configured initial credential', async () => {
    const createUser = vi.fn().mockResolvedValue({ data: { user: { id: 'user-example' } }, error: null });
    const admin = { auth: { admin: { createUser } } };
    const result = await prepareLogin(admin, 'temp_password', { email: 'member@example.com', name: 'Example Member' }, new Map(), 'ExampleInitial42');
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ password: 'ExampleInitial42', email: 'member@example.com' }));
    expect(result.tempPassword).toBe('ExampleInitial42');
  });
  it('still generates an independent temporary password without an override', async () => {
    const createUser = vi.fn().mockResolvedValue({ data: { user: { id: 'user-example' } }, error: null });
    const result = await prepareLogin({ auth: { admin: { createUser } } }, 'temp_password', { email: 'member@example.com', name: 'Example Member' }, new Map());
    expect(result.tempPassword).toHaveLength(12);
  });
  it('rejects an invalid override without writing an auth user', async () => {
    const createUser = vi.fn();
    await expect(prepareLogin({ auth: { admin: { createUser } } }, 'temp_password', { email: 'member@example.com', name: 'Example Member' }, new Map(), 'short')).rejects.toThrow('member_default_password_invalid');
    expect(createUser).not.toHaveBeenCalled();
  });
});

describe('passwords an admin knows are temporary', () => {
  const person = { email: 'member@example.com', name: 'Example Member' };
  it('marks a temporary or configured password on a new login, not an invitation', async () => {
    const createUser = vi.fn().mockResolvedValue({ data: { user: { id: 'user-example' } }, error: null });
    await prepareLogin({ auth: { admin: { createUser } } }, 'temp_password', person, new Map());
    expect(createUser.mock.calls[0][0].user_metadata).toEqual({ full_name: 'Example Member', [PASSWORD_CHANGE_FLAG]: true });
    await prepareLogin({ auth: { admin: { createUser } } }, 'temp_password', { ...person, email: 'other@example.com' }, new Map(), 'ExampleInitial42');
    expect(createUser.mock.calls[1][0]).toMatchObject({ password: 'ExampleInitial42', user_metadata: { [PASSWORD_CHANGE_FLAG]: true } });
    await prepareLogin({ auth: { admin: { createUser } } }, 'invite', { ...person, email: 'invited@example.com' }, new Map());
    expect(createUser.mock.calls[2][0].user_metadata).toEqual({ full_name: 'Example Member' });
  });

  it('marks an adopted login the same way', async () => {
    const updateUserById = vi.fn().mockResolvedValue({ error: null });
    const members = { select: () => ({ eq: () => ({ limit: async () => ({ data: [] as unknown[] }) }) }) };
    const admin = { from: () => members, auth: { admin: { updateUserById } } };
    const index = () => new Map([['member@example.com', { id: 'user-example', email: 'member@example.com' }]]);
    await prepareLogin(admin, 'temp_password', person, index());
    expect(updateUserById.mock.calls[0][1].user_metadata).toEqual({ [PASSWORD_CHANGE_FLAG]: true });
    await prepareLogin(admin, 'invite', person, index());
    expect(updateUserById.mock.calls[1][1]).not.toHaveProperty('user_metadata');
  });

  it('marks the temporary password issued when an invitation cannot be sent', async () => {
    const updateUserById = vi.fn().mockResolvedValue({ error: null });
    const admin = { auth: { admin: { updateUserById, generateLink: vi.fn().mockRejectedValue(new Error('offline')) } } };
    const channel = { method: 'invite', cfg: { apiKey: 'example-key', fromAddress: 'team@example.com' }, appUrl: 'https://pm.example.com' };
    const result = await deliverLogin(admin, channel, { authUserId: 'user-example', created: true, tempPassword: null }, { ...person, invitedBy: 'Example Owner' });
    expect(result).toMatchObject({ method: 'temp_password', inviteFailed: true });
    expect(updateUserById).toHaveBeenCalledWith('user-example', adminSetPassword(result.tempPassword));
    expect(adminSetPassword('ExampleTemp42')).toEqual({ password: 'ExampleTemp42', user_metadata: { [PASSWORD_CHANGE_FLAG]: true } });
  });
});
