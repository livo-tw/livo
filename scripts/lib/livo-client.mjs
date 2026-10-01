// The handful of LIVO calls scripts/jira-attachments.mjs needs, for both
// backends:
//   Cloudflare (--api): POST /api/query, /api/storage/…, /api/auth/*
//   self-hosted Docker (--supabase): PostgREST /rest/v1, Storage /storage/v1,
//                                    GoTrue /auth/v1 (needs the ANON_KEY)
// Sign-in: an API key or an admin's email + password. Cloudflare takes the key
// as the Bearer token; Docker trades it for a 15-minute login JWT
// (functions/api-tokens/exchange). Password sessions refresh and Docker key
// tokens are traded again before they run out, so a long upload run does not
// expire midway.

const PAT_PREFIX = 'livo_pat_';

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function fail(what, res, body) {
  const msg =
    (body && typeof body === 'object' && (body.error?.message || body.message || body.msg || body.error_description || body.error)) ||
    `HTTP ${res.status}`;
  return new Error(`${what}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
}

// ── Cloudflare worker ───────────────────────────────────────────────────

async function connectCloudflare({ api, token, email, password }) {
  const base = api.replace(/\/+$/, '');
  let session = null;

  const postAuth = async (route, body) => {
    const res = await fetch(`${base}/api/auth/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await readJson(res);
    if (!res.ok || !json?.session) throw fail(route === 'login' ? '登入失敗 / sign-in failed' : 'refresh', res, json);
    return json.session;
  };
  if (!token) session = await postAuth('login', { email, password });

  const authorization = async () => {
    if (session && session.expires_at * 1000 - Date.now() < 120_000) {
      session = await postAuth('refresh', { refresh_token: session.refresh_token });
    }
    return `Bearer ${session ? session.access_token : token}`;
  };

  const query = async (req) => {
    const res = await fetch(`${base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: await authorization() },
      body: JSON.stringify(req),
    });
    const json = await readJson(res);
    if (!res.ok || json?.error) throw fail(`${req.op} ${req.table}`, res, json);
    return json?.data;
  };
  const filtersOf = (filters) =>
    Object.entries(filters).map(([col, val]) =>
      Array.isArray(val) ? { col, op: 'in', val } : { col, op: 'eq', val }
    );

  return {
    kind: 'cloudflare',
    loginEmail: email || null,
    memberId: null,
    /** worker/src/storage.ts MAX_UPLOAD_BYTES */
    maxUploadBytes: 20 * 1024 * 1024,
    select: async (table, cols, filters = {}) => (await query({ table, op: 'select', cols, filters: filtersOf(filters) })) || [],
    insert: async (table, row) => ((await query({ table, op: 'insert', values: [row], cols: '*' })) || [])[0] || null,
    update: async (table, id, patch) => {
      await query({ table, op: 'update', values: patch, filters: [{ col: 'id', op: 'eq', val: id }], cols: 'id' });
    },
    upload: async (bucket, path, bytes, contentType) => {
      const res = await fetch(`${base}/api/storage/${bucket}/${encodePath(path)}`, {
        method: 'POST',
        headers: { Authorization: await authorization(), 'Content-Type': contentType },
        body: bytes,
      });
      const json = await readJson(res);
      if (!res.ok || json?.error) throw fail('upload', res, json);
      return json?.data?.path || path; // cloud workspaces get a ws/ prefix
    },
    publicUrl: (bucket, path) => `${base}/api/storage/${bucket}/${encodePath(path)}`,
  };
}

// ── Self-hosted Supabase (Docker) ───────────────────────────────────────

async function connectSupabase({ supabase, anonKey, token, email, password }) {
  const base = supabase.replace(/\/+$/, '');
  if (!anonKey) throw new Error('Docker 版需要 --anon-key（docker/.env 的 ANON_KEY）/ --anon-key is required');
  const isApiKey = !!token && token.startsWith(PAT_PREFIX);
  let session = null;
  let memberId = null;

  const tokenCall = async (grant, body) => {
    const res = await fetch(`${base}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await readJson(res);
    if (!res.ok || !json?.access_token) throw fail(grant === 'password' ? '登入失敗 / sign-in failed' : 'refresh', res, json);
    return { ...json, expires_at: json.expires_at || Math.floor(Date.now() / 1000) + (json.expires_in || 3600) };
  };
  // API key → 15-minute login JWT of the bound member (see the install README,
  // "用 API 金鑰操作 LIVO").
  const exchange = async () => {
    const res = await fetch(`${base}/functions/v1/api-tokens/exchange`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await readJson(res);
    if (!res.ok || !json?.access_token) {
      const err = fail('API 金鑰換證失敗 / API key exchange failed', res, json);
      if (res.status === 404) {
        err.message += '（這套安裝還沒有 API 金鑰功能，請先升級到新版，或改用 --email 登入）';
      }
      throw err;
    }
    memberId = json.member?.id || memberId;
    return {
      access_token: json.access_token,
      expires_at: json.expires_at || Math.floor(Date.now() / 1000) + (json.expires_in || 900),
    };
  };
  if (isApiKey) session = await exchange();
  else if (!token) session = await tokenCall('password', { email, password });

  // Key tokens live 15 minutes: trade again with 5 left, so a large upload never
  // starts on a token that is about to run out.
  const renewMarginMs = isApiKey ? 5 * 60_000 : 120_000;
  const headers = async (extra = {}) => {
    if (session && session.expires_at * 1000 - Date.now() < renewMarginMs) {
      session = isApiKey ? await exchange() : await tokenCall('refresh_token', { refresh_token: session.refresh_token });
    }
    return { apikey: anonKey, Authorization: `Bearer ${session ? session.access_token : token}`, ...extra };
  };
  const quote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const filterQuery = (filters) =>
    Object.entries(filters)
      .map(([col, val]) =>
        Array.isArray(val)
          ? `${encodeURIComponent(col)}=in.${encodeURIComponent(`(${val.map(quote).join(',')})`)}`
          : `${encodeURIComponent(col)}=eq.${encodeURIComponent(String(val))}`
      )
      .join('&');

  return {
    kind: 'docker',
    loginEmail: email || null,
    /** Member an API key is bound to (from the exchange). */
    get memberId() {
      return memberId;
    },
    /** docker-compose.yml storage FILE_SIZE_LIMIT default; an install can change it in docker/.env */
    maxUploadBytes: 200 * 1024 * 1024,
    select: async (table, cols, filters = {}) => {
      const qs = [`select=${encodeURIComponent(cols)}`, filterQuery(filters)].filter(Boolean).join('&');
      const res = await fetch(`${base}/rest/v1/${table}?${qs}`, { headers: await headers() });
      const json = await readJson(res);
      if (!res.ok) throw fail(`select ${table}`, res, json);
      return json || [];
    },
    insert: async (table, row) => {
      const res = await fetch(`${base}/rest/v1/${table}`, {
        method: 'POST',
        headers: await headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
        body: JSON.stringify(row),
      });
      const json = await readJson(res);
      if (!res.ok) throw fail(`insert ${table}`, res, json);
      return Array.isArray(json) ? json[0] || null : json;
    },
    update: async (table, id, patch) => {
      const res = await fetch(`${base}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: await headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw fail(`update ${table}`, res, await readJson(res));
    },
    upload: async (bucket, path, bytes, contentType) => {
      const res = await fetch(`${base}/storage/v1/object/${bucket}/${encodePath(path)}`, {
        method: 'POST',
        headers: await headers({ 'Content-Type': contentType, 'x-upsert': 'false' }),
        body: bytes,
      });
      const json = await readJson(res);
      if (!res.ok) throw fail('upload', res, json);
      return path;
    },
    publicUrl: (bucket, path) => `${base}/storage/v1/object/public/${bucket}/${encodePath(path)}`,
  };
}

export async function connectLivo(opts) {
  if (opts.api) return connectCloudflare(opts);
  if (opts.supabase) return connectSupabase(opts);
  throw new Error('請指定 --api（Cloudflare 版）或 --supabase（Docker 版）/ pass --api or --supabase');
}
