// api-tokens — personal API keys (PAT) for the self-host build.
//
// SELF-HOST version of worker/src/functions/apiTokens.ts. The keys live in
// the server-only api_tokens table (20261001_api_tokens.sql: RLS with zero
// policies); the logic is in ./core.ts (unit-tested), this file wires it to
// supabase-js and Deno.serve. No ../_shared import, like the other functions.
//
// Routes (via Kong: /functions/v1/api-tokens…):
//   GET  /api-tokens            admin    → list (never the hash)
//   POST /api-tokens            admin    {action:'create', name, memberId?} → key shown ONCE
//                                        {action:'revoke', id}
//   POST /api-tokens/exchange   API key  Authorization: Bearer livo_pat_…
//        → { access_token, token_type, expires_in, expires_at, member }
//        access_token is a 15-minute login JWT of the bound member for
//        PostgREST / Storage / the other functions (send it with the anon
//        apikey header). It cannot change the account: kong.yml only lets
//        it read GET /auth/v1/user.
//
// Admin = an active admin / super_admin member signed in with a normal login
// JWT, or the service-role key. A JWT obtained by exchange is refused: an API
// key must not mint or revoke keys, or a leaked key could outlive its own
// revocation.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";
import {
  type ApiTokenStore,
  type Caller,
  type MemberRow,
  type Result,
  NOT_INSTALLED_RESULT,
  NotInstalledError,
  PAT_PREFIX,
  bearerOf,
  createToken,
  exchangeToken,
  isAdminMember,
  isExchangedJwt,
  listTokens,
  probeGateway,
  revokeToken,
} from "./core.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const MEMBER_COLUMNS = 'id, name, email, role, is_active, auth_id';
const TOKEN_COLUMNS = 'id, name, member_id, created_by, created_at, last_used_at, revoked_at';

// PostgREST answers PGRST205 (schema cache) / 42P01 when the table is missing,
// i.e. the database has not been upgraded yet.
function check<T>(res: { data: T; error: { code?: string; message?: string } | null }): T {
  if (res.error) {
    const msg = res.error.message || '';
    if (res.error.code === 'PGRST205' || res.error.code === '42P01' || (/api_tokens/.test(msg) && /schema cache|does not exist/.test(msg))) {
      throw new NotInstalledError();
    }
    throw new Error(msg || 'database error');
  }
  return res.data;
}

function makeStore(db: SupabaseClient): ApiTokenStore {
  return {
    async listTokens() {
      return check(await db.from('api_tokens').select(TOKEN_COLUMNS).order('created_at', { ascending: false })) ?? [];
    },
    async insertToken(row) {
      const data = check(await db.from('api_tokens').insert(row).select('id').single());
      return (data as { id: string }).id;
    },
    async revokeToken(id, at) {
      const data = check(
        await db.from('api_tokens').update({ revoked_at: at }).eq('id', id).is('revoked_at', null).select('id'),
      );
      return Array.isArray(data) && data.length > 0;
    },
    async findActiveToken(tokenHash) {
      return check(
        await db.from('api_tokens').select('id, member_id').eq('token_hash', tokenHash).is('revoked_at', null).maybeSingle(),
      );
    },
    async touchToken(id, at) {
      check(await db.from('api_tokens').update({ last_used_at: at }).eq('id', id));
    },
    async getMember(id) {
      return check(await db.from('members').select(MEMBER_COLUMNS).eq('id', id).maybeSingle()) as MemberRow | null;
    },
    async getAuthUser(id) {
      const { data, error } = await db.auth.admin.getUserById(id);
      if (error || !data?.user) return null;
      const u = data.user as { id: string; email?: string; banned_until?: string; deleted_at?: string };
      return { id: u.id, email: u.email ?? null, banned_until: u.banned_until ?? null, deleted_at: u.deleted_at ?? null };
    },
  };
}

// The gateway self-check is cached per worker instance; a failed check is
// retried on the next exchange.
const GATEWAY_OK_TTL_MS = 10 * 60_000;
let gatewayOkAt = 0;

async function gatewayIsHardened(): Promise<boolean> {
  if (Date.now() - gatewayOkAt < GATEWAY_OK_TTL_MS) return true;
  const ok = await probeGateway((url, init) => fetch(url, init), {
    supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
    anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    jwtSecret: Deno.env.get('JWT_SECRET') ?? '',
    now: new Date(),
  });
  if (ok) gatewayOkAt = Date.now();
  return ok;
}

/** Admin caller for list/create/revoke, or an error Result. */
async function resolveAdmin(db: SupabaseClient, authorization: string | null): Promise<Caller | Result> {
  const bearer = bearerOf(authorization);
  if (!bearer) return { status: 401, body: { error: 'Unauthorized' } };
  if (bearer.startsWith(PAT_PREFIX)) {
    return {
      status: 401,
      body: {
        error: 'use_exchange',
        message: 'API 金鑰要先換成權杖：POST /functions/v1/api-tokens/exchange',
      },
    };
  }
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (serviceKey && bearer === serviceKey) return { kind: 'service' };
  if (isExchangedJwt(bearer)) {
    return {
      status: 403,
      body: {
        error: 'api_key_not_allowed',
        message: 'API 金鑰不能用來管理金鑰，請登入網頁操作',
      },
    };
  }

  const { data: { user }, error } = await db.auth.getUser(bearer);
  if (error || !user) return { status: 401, body: { error: 'Invalid token' } };
  let member = check(await db.from('members').select(MEMBER_COLUMNS).eq('auth_id', user.id).maybeSingle()) as MemberRow | null;
  if (!member && user.email) {
    member = check(await db.from('members').select(MEMBER_COLUMNS).eq('email', user.email).maybeSingle()) as MemberRow | null;
  }
  if (!isAdminMember(member)) {
    return { status: 403, body: { error: 'Permission denied: admin role required' } };
  }
  return { kind: 'member', member: member as MemberRow };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const db = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const store = makeStore(db);
    const authorization = req.headers.get('Authorization');
    const isExchange = /\/exchange\/?$/.test(new URL(req.url).pathname);

    // ── exchange: API key → short-lived login JWT ──────────────────────────
    if (isExchange) {
      if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      const r = await exchangeToken(store, authorization, {
        jwtSecret: Deno.env.get('JWT_SECRET') ?? '',
        now: new Date(),
        gatewayIsHardened,
      });
      return json(r.body, r.status);
    }

    // ── admin: list / create / revoke ──────────────────────────────────────
    const caller = await resolveAdmin(db, authorization);
    if ('status' in caller) return json(caller.body, caller.status);

    if (req.method === 'GET') {
      const r = await listTokens(store);
      return json(r.body, r.status);
    }
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const body = (await req.json().catch(() => ({}))) as {
      action?: unknown; name?: unknown; memberId?: unknown; id?: unknown;
    };
    const action = (body.action ?? '').toString();
    let r: Result;
    if (action === 'create') r = await createToken(store, caller, body);
    else if (action === 'revoke') r = await revokeToken(store, body, new Date());
    else r = { status: 400, body: { ok: false, error: 'unknown_action', message: "action 需為 'create' 或 'revoke'" } };
    return json(r.body, r.status);
  } catch (e) {
    if (e instanceof NotInstalledError) return json(NOT_INSTALLED_RESULT.body, NOT_INSTALLED_RESULT.status);
    console.error('[api-tokens] error:', e);
    return json({ ok: false, error: 'server_error', message: String(e) }, 500);
  }
});
