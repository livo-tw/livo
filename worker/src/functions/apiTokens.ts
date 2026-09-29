// Personal access tokens (PAT) — machine credentials for the /api/* surface.
// Rows live in the server-only api_tokens table (NOT in tables.ts): the plain
// token is returned exactly ONCE on creation and only its sha256 is stored.
// Authentication happens in auth.ts requireMember (Bearer livo_pat_… → the
// bound member's identity, inheriting the same server-side permission floor).
//
// Exports (see index.ts):
//   handleApiTokensGet(c)  — GET  /api/functions/api-tokens (admin) — list, no hash
//   handleApiTokensPost(c) — POST /api/functions/api-tokens (admin; demo-blocked)
//                            {action:'create', name, memberId?} → token shown once
//                            {action:'revoke', id}              → sets revoked_at

import type { Context } from 'hono';
import type { AppContext } from '../env';
import { sha256Hex } from '../auth';

export const PAT_PREFIX = 'livo_pat_';
const MAX_NAME_LEN = 100;

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let hex = '';
  for (let i = 0; i < buf.length; i++) hex += buf[i].toString(16).padStart(2, '0');
  return hex;
}

interface ApiTokenRow {
  id: string;
  name: string;
  member_id: string;
  created_by: string;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** GET /api/functions/api-tokens — list tokens (caller's workspace only).
 *  token_hash is NEVER included. */
export async function handleApiTokensGet(c: Context<AppContext>): Promise<Response> {
  const ws = c.get('auth').member.workspaceId;
  try {
    const res = await c.env.DB.prepare(
      `SELECT id, name, member_id, created_by, created_at, last_used_at, revoked_at
       FROM api_tokens WHERE workspace_id = ? ORDER BY created_at DESC`
    )
      .bind(ws)
      .all<ApiTokenRow>();
    const tokens = (res.results || []).map((t) => ({
      id: t.id,
      name: t.name,
      memberId: t.member_id,
      createdBy: t.created_by,
      createdAt: t.created_at,
      lastUsedAt: t.last_used_at,
      revokedAt: t.revoked_at,
    }));
    return c.json({ tokens });
  } catch (e) {
    console.error('[api-tokens] list error:', e);
    return c.json({ tokens: [] });
  }
}

/** POST /api/functions/api-tokens — create / revoke (admin; demo-blocked). */
export async function handleApiTokensPost(c: Context<AppContext>): Promise<Response> {
  const env = c.env;
  const auth = c.get('auth');
  const ws = auth.member.workspaceId;
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      action?: unknown;
      name?: unknown;
      memberId?: unknown;
      id?: unknown;
    };
    const action = (body.action ?? '').toString();

    // ── revoke ──
    if (action === 'revoke') {
      const id = (body.id ?? '').toString().trim();
      if (!id) return c.json({ ok: false, error: 'id_required' }, 400);
      const result = await env.DB.prepare(
        'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL'
      )
        .bind(new Date().toISOString(), id, ws)
        .run();
      if (!result.meta.changes) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json({ ok: true });
    }

    // ── create ──
    if (action !== 'create') {
      return c.json({ ok: false, error: 'unknown_action', message: "action 需為 'create' 或 'revoke'" }, 400);
    }
    const name = (body.name ?? '').toString().trim();
    if (!name || name.length > MAX_NAME_LEN) {
      return c.json({ ok: false, error: 'invalid_name', message: '請為 token 取一個名稱（100 字內）' }, 400);
    }
    // Token acts AS this member (defaults to the caller) — must exist, be active,
    // and belong to the caller's workspace (no cross-tenant minting by id-guessing).
    const memberId = (body.memberId ?? '').toString().trim() || auth.member.id;
    const member = await env.DB.prepare('SELECT id FROM members WHERE id = ? AND workspace_id = ? AND is_active = 1')
      .bind(memberId, ws)
      .first<{ id: string }>();
    if (!member) {
      return c.json({ ok: false, error: 'invalid_member', message: '綁定的成員不存在或已停用' }, 400);
    }

    const id = crypto.randomUUID();
    const token = `${PAT_PREFIX}${randomHex(16)}`; // livo_pat_ + 32 hex chars
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare(
      `INSERT INTO api_tokens (id, name, token_hash, member_id, created_by, created_at, workspace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, name, tokenHash, memberId, auth.member.id, new Date().toISOString(), ws)
      .run();

    // The ONLY time the plain token is ever returned.
    return c.json({ ok: true, id, name, memberId, token });
  } catch (e) {
    console.error('[api-tokens] error:', e);
    return c.json({ ok: false, error: 'server_error', message: String(e) }, 500);
  }
}
