// R2-backed storage endpoints. Object keys are `${bucket}/${path}` so the
// old Supabase bucket layout (task-images/…, backups/…) maps 1:1.
//
// TENANCY (CLOUD-BETA-DESIGN.md): workspace 'default' (self-host/local/demo)
// keeps the legacy flat namespace unchanged. Every other workspace lives
// under the `ws/<workspaceId>/` prefix inside each bucket:
//   - uploads are FORCED under the caller's prefix; the returned wire path is
//     the effective (prefixed) path and the frontend stores/uses that
//     (cfClient.upload returns the server path since the tenancy change);
//   - authed reads/removes are prefix-checked (default-ws members see only
//     the flat namespace; tenants see only their own prefix);
//   - `backups/seller/*` (revenue dumps) is never member-readable;
//   - beta workspaces get a storage quota (workspaces.storage_limit_mb,
//     usage tracked in workspaces.storage_used_bytes). 'default' has no
//     workspaces row → unlimited, exactly the old behavior.

import type { Context } from 'hono';
import type { AppContext, Env } from './env';
import { DEFAULT_WORKSPACE } from './env';
import { knowledgeStorageAllowed } from './knowledge';

const VALID_BUCKETS = new Set(['task-images', 'backups']);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB hard cap (frontend enforces 2 MB for attachments)
const INLINE_SAFE_TYPE = /^(image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|application\/pdf)\s*(;|$)/i;

function key(bucket: string, path: string): string {
  return `${bucket}/${path}`;
}

/** Effective wire path for an authed write: tenants are namespaced. */
function wsPath(ws: string, path: string): string {
  return ws === DEFAULT_WORKSPACE ? path : `ws/${ws}/${path}`;
}

/** May this workspace's members touch this (already-effective) path? */
function pathAllowed(ws: string, path: string): boolean {
  if (path.startsWith('seller/')) return false; // seller dumps: never member-readable
  if (ws === DEFAULT_WORKSPACE) return !path.startsWith('ws/'); // legacy flat namespace only
  return path.startsWith(`ws/${ws}/`);
}

interface WorkspaceQuotaRow {
  storage_limit_mb: number;
  storage_used_bytes: number;
}

/** Best-effort usage bookkeeping (delta in bytes, floor at 0). */
async function bumpUsage(env: Env, ws: string, delta: number): Promise<void> {
  if (ws === DEFAULT_WORKSPACE || delta === 0) return;
  try {
    await env.DB.prepare(
      'UPDATE workspaces SET storage_used_bytes = MAX(0, storage_used_bytes + ?) WHERE id = ?'
    )
      .bind(Math.round(delta), ws)
      .run();
  } catch {
    /* accounting is best-effort */
  }
}

export async function handleUpload(c: Context<AppContext>, bucket: string, path: string): Promise<Response> {
  if (!VALID_BUCKETS.has(bucket) || !path) {
    return c.json({ data: null, error: { message: 'Invalid bucket or path' } }, 400);
  }
  const ws = c.get('auth')?.member?.workspaceId || DEFAULT_WORKSPACE;
  const len = Number(c.req.header('content-length') || '0');
  if (len > MAX_UPLOAD_BYTES) {
    return c.json({ data: null, error: { message: 'File too large (max 20MB)' } }, 413);
  }

  // Quota for beta workspaces ('default' has no workspaces row → unlimited).
  if (ws !== DEFAULT_WORKSPACE) {
    if (!Number.isFinite(len) || len <= 0) {
      return c.json({ data: null, error: { message: 'Content-Length required' } }, 411);
    }
    const quota = await c.env.DB.prepare(
      'SELECT storage_limit_mb, storage_used_bytes FROM workspaces WHERE id = ?'
    )
      .bind(ws)
      .first<WorkspaceQuotaRow>();
    // QA multipart uploads reserve their full expected size before accepting parts.
    const reserved = await c.env.DB.prepare("SELECT COALESCE(SUM(expected_size),0) AS bytes FROM qa_upload_sessions WHERE workspace_id=? AND state IN ('initializing','uploading','finalizing','aborting')")
      .bind(ws).first<{bytes:number}>();
    if (quota && quota.storage_used_bytes + (reserved?.bytes ?? 0) + len > quota.storage_limit_mb * 1024 * 1024) {
      return c.json(
        { data: null, error: { message: `附件空間已滿（Beta 上限 ${quota.storage_limit_mb}MB），請刪除舊附件或聯繫 service@livo-tw.com` } },
        413
      );
    }
  }

  const effectivePath = wsPath(ws, path);
  // Same namespace rule as reads/removes: default-workspace uploads may not
  // land under another tenant's ws/ prefix or the seller/ dumps.
  if (!pathAllowed(ws, effectivePath)) {
    return c.json({ data: null, error: { message: 'Invalid path' } }, 403);
  }
  const contentType = c.req.header('content-type') || 'application/octet-stream';
  if (bucket === 'task-images' && !await knowledgeStorageAllowed(c.env, c.get('auth'), effectivePath)) {
    return c.json({ data: null, error: { message: 'kb_forbidden' } }, 403);
  }
  await c.env.ATTACHMENTS.put(key(bucket, effectivePath), c.req.raw.body, {
    httpMetadata: { contentType },
  });
  await bumpUsage(c.env, ws, len);
  // Wire path = effective path: the frontend stores this and builds public
  // URLs from it, so tenant objects resolve without any client-side mapping.
  return c.json({ data: { path: effectivePath }, error: null });
}

export async function handleDownload(c: Context<AppContext>, bucket: string, path: string): Promise<Response> {
  // backups are private per-workspace dumps: prefix-gated on the caller
  // (route already enforces member + super_admin). task-images stay public.
  if (bucket === 'backups') {
    const ws = c.get('auth')?.member?.workspaceId || DEFAULT_WORKSPACE;
    if (!pathAllowed(ws, path)) {
      return c.json({ data: null, error: { message: 'Object not found' } }, 404);
    }
  }

  // task-images are immutable and public — serve/store via the edge Cache API
  // so repeat views skip the R2 GET entirely. backups stay private/uncached.
  const cacheable = bucket === 'task-images';
  const cache = caches.default;
  if (cacheable) {
    const hit = await cache.match(c.req.raw);
    if (hit) return hit;
  }

  const obj = await c.env.ATTACHMENTS.get(key(bucket, path));
  if (!obj) return c.json({ data: null, error: { message: 'Object not found' } }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  // The stored content-type is whatever the uploader sent. Raster images and
  // PDFs display inline; anything else (HTML, SVG, XML…) downloads inside a
  // sandbox, so an upload can never run script on the API origin.
  headers.set('x-content-type-options', 'nosniff');
  if (!INLINE_SAFE_TYPE.test(headers.get('content-type') || '')) {
    headers.set('content-security-policy', "default-src 'none'; sandbox");
    headers.set('content-disposition', 'attachment');
  }
  if (bucket === 'task-images') {
    // Content-addressed-ish paths (timestamped) — safe to cache aggressively.
    headers.set('cache-control', 'public, max-age=31536000, immutable');
  } else {
    headers.set('cache-control', 'private, no-store');
  }
  const res = new Response(obj.body, { headers });
  if (cacheable) {
    c.executionCtx.waitUntil(cache.put(c.req.raw, res.clone()).catch(() => undefined));
  }
  return res;
}

export async function handleRemove(c: Context<AppContext>, bucket: string): Promise<Response> {
  if (!VALID_BUCKETS.has(bucket)) {
    return c.json({ data: null, error: { message: 'Invalid bucket' } }, 400);
  }
  const ws = c.get('auth')?.member?.workspaceId || DEFAULT_WORKSPACE;
  const body = (await c.req.json().catch(() => ({}))) as { paths?: string[] };
  const requested = Array.isArray(body.paths) ? body.paths : [];
  // Silently drop out-of-namespace paths (same shape as deleting a
  // nonexistent object) — a tenant can never delete another tenant's files.
  const paths = requested.filter((p) => typeof p === 'string' && pathAllowed(ws, p));
  if (bucket === 'task-images') {
    for (const path of paths) {
      if (!await knowledgeStorageAllowed(c.env, c.get('auth'), path)) {
        return c.json({ data: null, error: { message: 'kb_forbidden' } }, 403);
      }
    }
  }

  // Usage bookkeeping for tenants: size up objects before deleting.
  let freed = 0;
  if (ws !== DEFAULT_WORKSPACE) {
    const heads = await Promise.all(paths.map((p) => c.env.ATTACHMENTS.head(key(bucket, p))));
    for (const h of heads) freed += h?.size ?? 0;
  }
  await Promise.all(paths.map((p) => c.env.ATTACHMENTS.delete(key(bucket, p))));
  await bumpUsage(c.env, ws, -freed);
  return c.json({ data: paths, error: null });
}
