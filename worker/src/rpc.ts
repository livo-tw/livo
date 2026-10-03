// RPC handlers — POST /api/rpc/:fn (and legacy /rest/v1/rpc/:fn).
//
// License functions (check_license / activate_license / reset_license) are
// stubs: the open-source edition has no license keys and every feature is
// available. check_license still reports the hosted-workspace quota.
//
// Field-lock functions port 20260326100000_create_field_locks.sql. They
// require a valid Bearer JWT resolving to an ACTIVE MEMBER (requireMember),
// and the acting member id is ALWAYS the authenticated member's — the
// client-supplied p_member_id is ignored, so a stolen/valid JWT can no
// longer acquire or release locks on someone else's behalf.

import type { Context } from 'hono';
import type { AppContext, Ctx, Env } from './env';
import { DEFAULT_WORKSPACE, DEMO_BLOCKED_MESSAGE, isDemoLocked } from './env';
import type { ChangeEvent, RpcResponse } from './protocol';
import { requireMember, resolveActiveMember, verifyAccessToken } from './auth';
import { notifyChanges } from './notify';
import { nowIso, rowToWire, type TableMeta } from './meta';
import { TABLES } from './tables';
import { knowledgeLockAllowed } from './knowledge';
import { handleKnowledgePreferences } from './knowledgePreferences';
import { PLANNING_FNS, taskPlanningRpc, planningError } from './taskPlanning';

// ─── Small helpers ────────────────────────────────────────────────────────

const FIELD_LOCKS_META: TableMeta = TABLES['field_locks'] ?? {
  pk: 'lock_key',
  clientAccess: 'full',
};

interface FieldLockRow {
  lock_key: string;
  locked_by: string;
  expires_at: string;
}

// ─── License RPCs (open-source edition) ───────────────────────────────────
// There are no license keys: check_license always reports every feature as
// available. activate/reset stay as no-ops so older clients get a clear
// answer instead of an unknown-function error.

const LICENSE_NOT_REQUIRED = '開源版不需要授權金鑰，所有功能都已開放。';

async function checkLicense(_env: Env, _ws: string): Promise<Record<string, unknown>> {
  return {
    valid: true,
    tier: 'professional',
    email: null,
    expires_at: null,
    is_perpetual: true,
    is_expired: false,
    installation_bound: false,
  };
}

async function activateLicense(_env: Env, _ws: string, _licenseKey: unknown): Promise<Record<string, unknown>> {
  return { valid: false, error: 'not_required', message: LICENSE_NOT_REQUIRED };
}

async function resetLicense(_env: Env, _ws: string, _resetCode: unknown): Promise<Record<string, unknown>> {
  return { success: false, error: 'not_required', message: LICENSE_NOT_REQUIRED };
}

// ─── Field-lock RPCs (port of acquire/release_field_lock, release_all_locks) ──

function lockEvent(
  eventType: 'INSERT' | 'UPDATE' | 'DELETE',
  row: FieldLockRow
): ChangeEvent {
  const wire = rowToWire({ ...row }, FIELD_LOCKS_META);
  if (eventType === 'DELETE') return { table: 'field_locks', eventType, new: null, old: wire };
  if (eventType === 'UPDATE') {
    return { table: 'field_locks', eventType, new: wire, old: { lock_key: row.lock_key } };
  }
  return { table: 'field_locks', eventType, new: wire, old: null };
}

async function acquireFieldLock(
  env: Env,
  ctx: Ctx,
  ws: string,
  lockKey: string,
  memberId: string,
  ttlSeconds: number
): Promise<Record<string, unknown>> {
  const now = nowIso();

  // Clean up an expired lock on this key first (ISO strings compare lexicographically)
  await env.DB.prepare(
    'DELETE FROM field_locks WHERE workspace_id = ? AND lock_key = ? AND expires_at < ?'
  )
    .bind(ws, lockKey, now)
    .run();

  const existing = await env.DB.prepare(
    'SELECT lock_key, locked_by, expires_at FROM field_locks WHERE workspace_id = ? AND lock_key = ?'
  )
    .bind(ws, lockKey)
    .first<FieldLockRow>();

  if (existing && existing.locked_by !== memberId) {
    // Different user holds a live lock
    return { acquired: false, locked_by: existing.locked_by };
  }

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await env.DB.prepare(
    'INSERT OR REPLACE INTO field_locks (workspace_id, lock_key, locked_by, expires_at) VALUES (?, ?, ?, ?)'
  )
    .bind(ws, lockKey, memberId, expiresAt)
    .run();

  const row: FieldLockRow = { lock_key: lockKey, locked_by: memberId, expires_at: expiresAt };
  notifyChanges(env, ctx, [lockEvent(existing ? 'UPDATE' : 'INSERT', row)], ws);

  return { acquired: true };
}

async function releaseFieldLock(
  env: Env,
  ctx: Ctx,
  ws: string,
  lockKey: string,
  memberId: string
): Promise<void> {
  const res = await env.DB.prepare(
    'DELETE FROM field_locks WHERE workspace_id = ? AND lock_key = ? AND locked_by = ? RETURNING lock_key, locked_by, expires_at'
  )
    .bind(ws, lockKey, memberId)
    .all<FieldLockRow>();

  const events = (res.results || []).map((r) => lockEvent('DELETE', r));
  notifyChanges(env, ctx, events, ws);
}

async function releaseAllLocks(env: Env, ctx: Ctx, ws: string, memberId: string): Promise<void> {
  const res = await env.DB.prepare(
    'DELETE FROM field_locks WHERE workspace_id = ? AND locked_by = ? RETURNING lock_key, locked_by, expires_at'
  )
    .bind(ws, memberId)
    .all<FieldLockRow>();

  const events = (res.results || []).map((r) => lockEvent('DELETE', r));
  notifyChanges(env, ctx, events, ws);
}

// ─── Entry point ──────────────────────────────────────────────────────────

const LOCK_FNS = new Set(['acquire_field_lock', 'release_field_lock', 'release_all_locks']);

export async function handleRpc(c: Context<AppContext>, fn: string): Promise<Response> {
  let args: Record<string, unknown> = {};
  try {
    const body = (await c.req.json()) as unknown;
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      args = body as Record<string, unknown>;
    }
  } catch {
    // empty / non-JSON body → no args (check_license takes none)
  }

  try {
    // ── Demo lock (contract T3): on the public demo instance nobody may
    if (fn === 'kb_preferences') {
      let authed = false;
      const failure = await requireMember(c, async () => { authed = true; });
      if (!authed) return c.json({ data: null, error: { message: 'kb_forbidden' } }, failure instanceof Response && failure.status === 403 ? 403 : 401);
      return c.json(await handleKnowledgePreferences(c.env, c.get('auth'), args));
    }
    //    activate or reset the license — keeps it permanently PRO. check_license
    //    (read-only) stays open. ──
    if ((fn === 'activate_license' || fn === 'reset_license') && isDemoLocked(c.env)) {
      return c.json(
        { data: null, error: { message: DEMO_BLOCKED_MESSAGE } } satisfies RpcResponse,
        403
      );
    }

    if (PLANNING_FNS.has(fn)) {
      let authed=false;
      const failure=await requireMember(c,async()=>{authed=true;});
      if (!authed) return failure instanceof Response ? failure : c.json({data:null,error:{message:'planning_forbidden'}},403);
      try {
        const data=await taskPlanningRpc(c.env,c.get('auth'),fn,args);
        if (fn==='livo_set_task_deadline') {
          notifyChanges(c.env,c.executionCtx,[{table:'tasks',eventType:'UPDATE',new:data,old:{id:data.id}}],c.get('auth').member.workspaceId || DEFAULT_WORKSPACE);
        }
        return c.json({data,error:null});
      } catch(error) {
        const message=planningError(error);
        return c.json({data:null,error:{message}},message==='planning_forbidden'?403:message==='planning_conflict'?409:400);
      }
    }

    // ── Public license functions ──
    // Workspace resolution: anonymous callers (self-host boot, 官網) operate
    // on 'default'; an authenticated member operates on their own workspace
    // (cloud-beta tenants read the license row minted at provisioning).
    if (fn === 'check_license' || fn === 'activate_license' || fn === 'reset_license') {
      let ws = DEFAULT_WORKSPACE;
      const m = /^Bearer\s+(.+)$/i.exec((c.req.header('Authorization') || '').trim());
      if (m) {
        const claims = await verifyAccessToken(c.env, m[1] ?? '');
        if (claims) {
          const resolved = await resolveActiveMember(c.env, claims.sub, claims.email);
          if (resolved.ok) ws = resolved.member.workspace_id || DEFAULT_WORKSPACE;
        }
      }
      if (fn === 'check_license') {
        const data = await checkLicense(c.env, ws);
        // Beta workspaces get their quota piggybacked so the frontend can
        // render a truthful storage meter (default/self-host: no field).
        if (ws !== DEFAULT_WORKSPACE) {
          try {
            const quota = await c.env.DB.prepare(
              'SELECT member_limit, storage_limit_mb, storage_used_bytes FROM workspaces WHERE id = ?'
            )
              .bind(ws)
              .first<Record<string, unknown>>();
            if (quota) data.workspace_quota = quota;
          } catch {
            /* quota display is best-effort */
          }
        }
        return c.json({ data, error: null } satisfies RpcResponse);
      }
      if (fn === 'activate_license') {
        const data = await activateLicense(c.env, ws, args['license_key']);
        return c.json({ data, error: null } satisfies RpcResponse);
      }
      const data = await resetLicense(c.env, ws, args['reset_code']);
      return c.json({ data, error: null } satisfies RpcResponse);
    }

    // ── Lock functions: require a Bearer JWT resolving to an active member ──
    if (LOCK_FNS.has(fn)) {
      // Reuse the requireMember middleware directly (auth_id lookup, email
      // heal, is_active enforcement, micro-cache). On failure it produces its
      // own Response — re-wrap as an RpcResponse with the same status.
      let authed = false;
      const failure = await requireMember(c, async () => {
        authed = true;
      });
      if (!authed) {
        const status = failure instanceof Response && failure.status === 403 ? 403 : 401;
        return c.json(
          {
            data: null,
            error: { message: status === 403 ? 'Forbidden' : 'Unauthorized' },
          } satisfies RpcResponse,
          status
        );
      }

      // Locks are always attributed to the AUTHENTICATED member; the
      // client-supplied p_member_id is ignored (spoofing hardening).
      const memberId = c.get('auth').member.id;
      const lockWs = c.get('auth').member.workspaceId || DEFAULT_WORKSPACE;

      if (fn === 'release_all_locks') {
        await releaseAllLocks(c.env, c.executionCtx, lockWs, memberId);
        return c.json({ data: true, error: null } satisfies RpcResponse);
      }

      const lockKey = typeof args['p_lock_key'] === 'string' ? args['p_lock_key'] : '';
      if (!lockKey) {
        return c.json(
          { data: null, error: { message: 'p_lock_key is required' } } satisfies RpcResponse,
          400
        );
      }

      if (fn === 'acquire_field_lock') {
        if (!await knowledgeLockAllowed(c.env, c.get('auth'), lockKey)) {
          return c.json({ data: null, error: { message: 'kb_forbidden' } } satisfies RpcResponse, 403);
        }
        const rawTtl = args['p_ttl_seconds'];
        const ttl =
          typeof rawTtl === 'number' && Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 30;
        const data = await acquireFieldLock(c.env, c.executionCtx, lockWs, lockKey, memberId, ttl);
        return c.json({ data, error: null } satisfies RpcResponse);
      }

      // release_field_lock
      await releaseFieldLock(c.env, c.executionCtx, lockWs, lockKey, memberId);
      return c.json({ data: true, error: null } satisfies RpcResponse);
    }

    return c.json({
      data: null,
      error: { message: `Unknown function: ${fn}` },
    } satisfies RpcResponse);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json(
      { data: null, error: { message: `RPC ${fn} failed: ${message}` } } satisfies RpcResponse,
      500
    );
  }
}
