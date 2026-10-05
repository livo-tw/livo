// Self-host personal API keys: the api-tokens edge function core, as shipped
// (docker/volumes/functions/api-tokens/core.ts), against an in-memory store.
// All data here is fictional.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXCHANGE_TTL_SECONDS,
  GATEWAY_BLOCK_CODE,
  PAT_JWT_MARKER,
  type ApiTokenRow,
  type ApiTokenStore,
  type AuthUserInfo,
  type Caller,
  type MemberRow,
  createToken,
  exchangeToken,
  isAdminMember,
  isExchangedJwt,
  listTokens,
  probeGateway,
  revokeToken,
  sha256Hex,
  verifyJwt,
} from '../../docker/volumes/functions/api-tokens/core.ts';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const NOW = new Date('2026-10-01T08:00:00.000Z');
const ROOT = path.resolve(__dirname, '../..');

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

class MemoryStore implements ApiTokenStore {
  rows: (ApiTokenRow & { token_hash: string })[] = [];
  members = new Map<string, MemberRow>();
  users = new Map<string, AuthUserInfo>();
  private seq = 0;

  async listTokens(): Promise<ApiTokenRow[]> {
    return [...this.rows].reverse().map((r) => ({
      id: r.id,
      name: r.name,
      member_id: r.member_id,
      created_by: r.created_by,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      revoked_at: r.revoked_at,
    }));
  }
  async insertToken(row: { name: string; token_hash: string; member_id: string; created_by: string }) {
    const id = uid(9000 + ++this.seq);
    this.rows.push({ id, created_at: NOW.toISOString(), last_used_at: null, revoked_at: null, ...row });
    return id;
  }
  async revokeToken(id: string, at: string) {
    const row = this.rows.find((r) => r.id === id && !r.revoked_at);
    if (!row) return false;
    row.revoked_at = at;
    return true;
  }
  async findActiveToken(tokenHash: string) {
    const row = this.rows.find((r) => r.token_hash === tokenHash && !r.revoked_at);
    return row ? { id: row.id, member_id: row.member_id } : null;
  }
  async touchToken(id: string, at: string) {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.last_used_at = at;
  }
  async getMember(id: string) {
    return this.members.get(id) ?? null;
  }
  async getAuthUser(id: string) {
    return this.users.get(id) ?? null;
  }
}

function member(id: string, role: string, authN: number | null, isActive = true): MemberRow {
  return { id, name: `測試 ${id}`, email: `${id}@example.com`, role, is_active: isActive, auth_id: authN === null ? null : uid(authN) };
}

let store: MemoryStore;
const as = (id: string): Caller => ({ kind: 'member', member: store.members.get(id)! });
const hardened = async () => true;
const exchange = (authorization: string | null, gatewayIsHardened = hardened) =>
  exchangeToken(store, authorization, { jwtSecret: SECRET, now: NOW, gatewayIsHardened });

beforeEach(() => {
  store = new MemoryStore();
  for (const m of [
    member('m-admin', 'admin', 1),
    member('m-super', 'super_admin', 2),
    member('m-member', 'member', 3),
    member('m-admin2', 'admin', 4),
    member('m-off', 'member', 5, false),
    member('m-nolink', 'member', null),
    member('m-ai', 'admin', 6),
  ]) {
    store.members.set(m.id, m);
    if (m.auth_id) store.users.set(m.auth_id, { id: m.auth_id, email: m.email, banned_until: null, deleted_at: null });
  }
});

async function newToken(caller = 'm-admin', memberId?: string): Promise<{ id: string; token: string }> {
  const r = await createToken(store, as(caller), { name: 'CI 腳本', memberId });
  expect(r.status).toBe(200);
  return { id: r.body.id as string, token: r.body.token as string };
}

describe('create / list / revoke', () => {
  it('creates a key shown once and stores only its sha256', async () => {
    const r = await createToken(store, as('m-admin'), { name: '  AI 助理  ' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, name: 'AI 助理', memberId: 'm-admin' });
    const token = r.body.token as string;
    expect(token).toMatch(/^livo_pat_[0-9a-f]{32}$/);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].token_hash).toBe(await sha256Hex(token));
    expect(JSON.stringify(store.rows)).not.toContain(token);
    expect(store.rows[0].created_by).toBe('m-admin');
  });

  it('lists in the Cloudflare camelCase shape, never the hash or the key', async () => {
    const { token } = await newToken();
    const r = await listTokens(store);
    expect(r.status).toBe(200);
    const tokens = r.body.tokens as Record<string, unknown>[];
    expect(tokens).toHaveLength(1);
    expect(Object.keys(tokens[0]).sort()).toEqual(
      ['createdAt', 'createdBy', 'id', 'lastUsedAt', 'memberId', 'name', 'revokedAt'].sort(),
    );
    expect(JSON.stringify(r.body)).not.toContain(token);
    expect(JSON.stringify(r.body)).not.toContain(store.rows[0].token_hash);
  });

  it('revokes once; unknown, malformed and missing ids fail', async () => {
    const { id } = await newToken();
    expect((await revokeToken(store, { id }, NOW)).status).toBe(200);
    expect(store.rows[0].revoked_at).toBe(NOW.toISOString());
    expect((await revokeToken(store, { id }, NOW)).status).toBe(404);
    expect((await revokeToken(store, { id: uid(1234) }, NOW)).status).toBe(404);
    expect((await revokeToken(store, { id: 'not-a-uuid' }, NOW)).status).toBe(404);
    expect((await revokeToken(store, {}, NOW)).status).toBe(400);
  });

  it('validates the name', async () => {
    expect((await createToken(store, as('m-admin'), { name: '   ' })).body.error).toBe('invalid_name');
    expect((await createToken(store, as('m-admin'), { name: 'x'.repeat(101) })).body.error).toBe('invalid_name');
    expect((await createToken(store, as('m-admin'), { name: 'x'.repeat(100) })).status).toBe(200);
  });

  it('only an active super_admin may manage keys, like every service integration', () => {
    expect(isAdminMember(store.members.get('m-member')!)).toBe(false);
    expect(isAdminMember(store.members.get('m-admin')!)).toBe(false);
    expect(isAdminMember(store.members.get('m-super')!)).toBe(true);
    expect(isAdminMember({ ...store.members.get('m-super')!, is_active: false })).toBe(false);
    expect(isAdminMember(null)).toBe(false);
  });

  it('an admin cannot bind a key to another admin or super_admin; a super_admin can', async () => {
    expect((await createToken(store, as('m-admin'), { name: 'x', memberId: 'm-super' })).status).toBe(403);
    expect((await createToken(store, as('m-admin'), { name: 'x', memberId: 'm-admin2' })).body.error).toBe('forbidden_member');
    expect((await createToken(store, as('m-admin'), { name: 'x', memberId: 'm-member' })).status).toBe(200);
    expect((await createToken(store, as('m-super'), { name: 'x', memberId: 'm-ai' })).status).toBe(200);
  });

  it('refuses inactive and login-less members, and needs memberId for the service role', async () => {
    expect((await createToken(store, as('m-super'), { name: 'x', memberId: 'm-off' })).body.error).toBe('invalid_member');
    expect((await createToken(store, as('m-super'), { name: 'x', memberId: 'm-nope' })).body.error).toBe('invalid_member');
    expect((await createToken(store, as('m-super'), { name: 'x', memberId: 'm-nolink' })).body.error).toBe('member_not_linked');
    expect((await createToken(store, { kind: 'service' }, { name: 'x' })).body.error).toBe('member_required');
    const r = await createToken(store, { kind: 'service' }, { name: 'x', memberId: 'm-ai' });
    expect(r.status).toBe(200);
    expect(store.rows[store.rows.length - 1].created_by).toBe('service_role');
  });
});

describe('exchange', () => {
  it('trades a key for a 15-minute login JWT of the bound member', async () => {
    const { id, token } = await newToken('m-super', 'm-ai');
    const r = await exchange(`Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      token_type: 'bearer',
      expires_in: EXCHANGE_TTL_SECONDS,
      expires_at: NOW.getTime() / 1000 + 900,
      member: { id: 'm-ai', name: '測試 m-ai', role: 'admin' },
    });
    const jwt = r.body.access_token as string;
    expect(jwt.startsWith(`${PAT_JWT_MARKER}`)).toBe(true);
    expect(isExchangedJwt(jwt)).toBe(true);
    const claims = await verifyJwt(jwt, SECRET, NOW.getTime());
    expect(claims).toMatchObject({
      livo_pat: id,
      sub: uid(6),
      role: 'authenticated',
      aud: 'authenticated',
      email: 'm-ai@example.com',
    });
    expect((claims!.exp as number) - (claims!.iat as number)).toBe(900);
    expect(Object.keys(claims!)[0]).toBe('livo_pat');
    expect(claims).not.toHaveProperty('session_id');
    // signed with JWT_SECRET only, and short-lived
    expect(await verifyJwt(jwt, 'some-other-secret', NOW.getTime())).toBeNull();
    expect(await verifyJwt(jwt, SECRET, NOW.getTime() + 901_000)).toBeNull();
    expect(store.rows[0].last_used_at).toBe(NOW.toISOString());
  });

  it('fails after the key is revoked', async () => {
    const { id, token } = await newToken();
    expect((await exchange(`Bearer ${token}`)).status).toBe(200);
    await revokeToken(store, { id }, NOW);
    const r = await exchange(`Bearer ${token}`);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('invalid_token');
    expect(r.body).not.toHaveProperty('access_token');
  });

  it('fails after the bound member is deactivated', async () => {
    const { token } = await newToken('m-admin', 'm-member');
    store.members.get('m-member')!.is_active = false;
    const r = await exchange(`Bearer ${token}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('member_inactive');
  });

  it('fails when the login account is banned, deleted or unlinked', async () => {
    const { token } = await newToken('m-admin', 'm-member');
    store.users.get(uid(3))!.banned_until = '2099-01-01T00:00:00Z';
    expect((await exchange(`Bearer ${token}`)).body.error).toBe('member_inactive');
    store.users.get(uid(3))!.banned_until = null;
    store.users.get(uid(3))!.deleted_at = '2026-09-30T00:00:00Z';
    expect((await exchange(`Bearer ${token}`)).body.error).toBe('member_not_linked');
    store.members.get('m-member')!.auth_id = null;
    expect((await exchange(`Bearer ${token}`)).body.error).toBe('member_not_linked');
  });

  it('rejects missing, malformed and unknown keys without probing the gateway', async () => {
    let probed = 0;
    const gateway = async () => {
      probed++;
      return true;
    };
    for (const header of [null, '', 'Bearer', 'Basic abc', 'Bearer livo_pat_xyz', `Bearer livo_pat_${'0'.repeat(32)}`]) {
      const r = await exchange(header, gateway);
      expect(r.status).toBe(401);
    }
    expect(probed).toBe(0);
  });

  it('refuses to mint when the gateway does not block account changes', async () => {
    const { token } = await newToken();
    const r = await exchange(`Bearer ${token}`, async () => false);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('gateway_not_hardened');
    expect(r.body).not.toHaveProperty('access_token');
  });
});

describe('gateway probe', () => {
  type Call = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };
  const answer = (status: number, body: unknown) => async (url: string, init: Call['init']) => {
    calls.push({ url, init });
    return { status, json: async () => body };
  };
  let calls: Call[];
  beforeEach(() => {
    calls = [];
  });
  const opts = { supabaseUrl: 'http://kong:8000/', anonKey: 'anon-key', jwtSecret: SECRET, now: NOW };

  it('passes only on the gateway refusal', async () => {
    expect(await probeGateway(answer(403, { code: GATEWAY_BLOCK_CODE, message: 'x' }), opts)).toBe(true);
    const { url, init } = calls[0];
    expect(url).toBe('http://kong:8000/auth/v1/user');
    expect(init.method).toBe('PUT');
    expect(init.headers.apikey).toBe('anon-key');
    const probe = init.headers.Authorization.replace(/^Bearer /, '');
    expect(probe.startsWith(PAT_JWT_MARKER)).toBe(true);
    const claims = await verifyJwt(probe, SECRET, NOW.getTime());
    expect(claims?.sub).toMatch(/^[0-9a-f-]{36}$/);
    expect((claims!.exp as number) - (claims!.iat as number)).toBe(60);
  });

  it('fails when GoTrue answers (old kong.yml) or the request errors', async () => {
    expect(await probeGateway(answer(403, { code: 403, error_code: 'user_not_found' }), opts)).toBe(false);
    expect(await probeGateway(answer(200, {}), opts)).toBe(false);
    expect(
      await probeGateway(async () => {
        throw new Error('ECONNREFUSED');
      }, opts),
    ).toBe(false);
  });
});

describe('files that must stay in step', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('kong.yml matches the JWT marker on both API-key routes and returns the block code', () => {
    const kong = read('docker/volumes/api/kong.yml');
    const regex = `'~*^bearer\\s+${PAT_JWT_MARKER.replace('.', '\\.')}'`;
    expect(kong.split(regex).length - 1).toBe(2);
    expect(kong).toContain(`"code":"${GATEWAY_BLOCK_CODE}"`);
    expect(kong).toContain("- '/auth/v1/user$'");
  });

  // supabase/functions/ (the dev source) is not part of the public export
  it.skipIf(!fs.existsSync(path.join(ROOT, 'supabase/functions')))('the shipped function is identical to its dev source', () => {
    for (const f of ['index.ts', 'core.ts']) {
      expect(read(`docker/volumes/functions/api-tokens/${f}`)).toBe(read(`supabase/functions/api-tokens/${f}`));
    }
  });

  it('api_tokens is server-only (RLS on, no policies, no client grants)', () => {
    const sql = read('supabase/migrations/20261001_api_tokens.sql');
    expect(sql).toMatch(/ALTER TABLE public\.api_tokens ENABLE ROW LEVEL SECURITY;/);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.api_tokens FROM anon, authenticated;/);
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });
});

describe('isExchangedJwt', () => {
  // A normal GoTrue login JWT: same HS256 header, but its payload does not
  // start with the livo_pat claim. api-tokens refuses only exchanged JWTs.
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });

  it('is false for a normal login JWT, the service key and a raw API key', () => {
    const login = `${header}.${b64({ aud: 'authenticated', sub: uid(1), role: 'authenticated' })}.sig`;
    const service = `${header}.${b64({ role: 'service_role', iss: 'supabase' })}.sig`;
    expect(isExchangedJwt(login)).toBe(false);
    expect(isExchangedJwt(service)).toBe(false);
    expect(isExchangedJwt('livo_pat_' + '0'.repeat(32))).toBe(false);
    expect(isExchangedJwt('')).toBe(false);
  });

  it('is true for any token that carries the exchange marker', () => {
    const forged = `${header}.${b64({ livo_pat: 'x', sub: uid(1) })}.sig`;
    expect(forged.startsWith(PAT_JWT_MARKER)).toBe(true);
    expect(isExchangedJwt(forged)).toBe(true);
  });
});
