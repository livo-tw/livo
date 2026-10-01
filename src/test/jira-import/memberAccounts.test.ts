// @vitest-environment node
// Docker memberAccounts.ts helpers: invitation link base and API-key tokens.
import { afterEach, describe, expect, it, vi } from 'vitest';

const env = new Map<string, string>();
vi.stubGlobal('Deno', { env: { get: (k: string) => env.get(k) } });
// A runtime path keeps this Deno file out of the app's type check (no Deno types there).
const MEMBER_ACCOUNTS = '../../../docker/volumes/functions/manage-member/memberAccounts.ts';
const { isApiKeyToken, isLocalHostname, resolveAppUrl } = await import(/* @vite-ignore */ MEMBER_ACCOUNTS);

const req = (origin?: string) => new Request('http://functions:9000/manage-member', { headers: origin ? { Origin: origin } : {} });
const b64u = (s: string) => Buffer.from(s).toString('base64url');
const jwt = (payload: object) => `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify(payload))}.sig`;

afterEach(() => env.clear());

describe('invitation link base', () => {
  it('prefers a real APP_BASE_URL', () => {
    env.set('APP_BASE_URL', 'https://pm.example.com/');
    expect(resolveAppUrl(req('https://other.example.com'))).toBe('https://pm.example.com/demo');
  });

  it('ignores the factory localhost value when the browser origin is known', () => {
    for (const local of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      env.set('APP_BASE_URL', local);
      expect(resolveAppUrl(req('https://pm.example.com'))).toBe('https://pm.example.com/demo');
    }
  });

  it('falls back to APP_BASE_URL, then to nothing', () => {
    env.set('APP_BASE_URL', 'http://localhost:3000');
    expect(resolveAppUrl(req())).toBe('http://localhost:3000/demo');
    env.clear();
    expect(resolveAppUrl(req('https://pm.example.com'))).toBe('https://pm.example.com/demo');
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
