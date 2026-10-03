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
import type { AppContext } from './env';
import { DEFAULT_WORKSPACE } from './env';
import { knowledgeStorageAllowed } from './knowledge';
import { reserveStorageBytes, releaseStorageBytes, StorageQuotaError } from './storageQuota';
import { ImportError } from './knowledgeImport';

const VALID_BUCKETS = new Set(['task-images', 'kb-files', 'backups']);
export const isKnowledgeStoragePath = (path: string): boolean => /^(?:ws\/[^/]+\/)?kb\//.test(path);
export const isKnowledgeImportPath = (path: string): boolean => /^(?:ws\/[^/]+\/)?kb-imports(?:\/|$)/.test(path);
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
  if (isKnowledgeImportPath(path)) return false;
  if (path.startsWith('seller/')) return false; // seller dumps: never member-readable
  if (ws === DEFAULT_WORKSPACE) return !path.startsWith('ws/'); // legacy flat namespace only
  return path.startsWith(`ws/${ws}/`);
}

async function uploadBytes(request:Request):Promise<Uint8Array>{
  const reader=request.body?.getReader();if(!reader)return new Uint8Array();
  const chunks:Uint8Array[]=[];let total=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>MAX_UPLOAD_BYTES)throw new Error('upload_size_limit');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>undefined);}
  const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
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
  }

  const effectivePath = wsPath(ws, path);
  // Same namespace rule as reads/removes: default-workspace uploads may not
  // land under another tenant's ws/ prefix or the seller/ dumps.
  if (!pathAllowed(ws, effectivePath)) {
    return c.json({ data: null, error: { message: 'Invalid path' } }, 403);
  }
  const contentType = c.req.header('content-type') || 'application/octet-stream';
  if ((bucket === 'task-images' && isKnowledgeStoragePath(effectivePath)) || (bucket === 'kb-files' && (!isKnowledgeStoragePath(effectivePath) || !await knowledgeStorageAllowed(c.env, c.get('auth'), effectivePath)))) {
    return c.json({ data: null, error: { message: 'kb_forbidden' } }, 403);
  }
  let bytes:Uint8Array;
  try{bytes=await uploadBytes(c.req.raw);}catch(error){if(String(error).includes('upload_size_limit'))return c.json({data:null,error:{message:'File too large (max 20MB)'}},413);throw error;}
  const objectKey=key(bucket,effectivePath),previous=await c.env.ATTACHMENTS.head(objectKey);
  const reserved=Math.max(0,bytes.length-(previous?.size||0));
  try{await reserveStorageBytes(c.env,ws,reserved);}catch(error){if(error instanceof StorageQuotaError)return c.json({data:null,error:{message:'附件空間已滿，請刪除舊附件或聯繫管理員'}},413);if(error instanceof ImportError&&error.code==='storage_reconciliation_pending')return c.json({data:null,error:{code:error.code,message:'附件容量帳務正在核對，請稍後再試'}},409);throw error;}
  try{await c.env.ATTACHMENTS.put(objectKey,bytes,{httpMetadata:{contentType}});}
  catch(error){await releaseStorageBytes(c.env,ws,reserved);throw error;}
  await releaseStorageBytes(c.env,ws,Math.max(0,(previous?.size||0)-bytes.length));
  // Wire path = effective path: the frontend stores this and builds public
  // URLs from it, so tenant objects resolve without any client-side mapping.
  return c.json({ data: { path: effectivePath }, error: null });
}

export async function handleDownload(c: Context<AppContext>, bucket: string, path: string): Promise<Response> {
  if (isKnowledgeImportPath(path)) return c.json({ data: null, error: { message: 'Object not found' } }, 404);
  const privateKnowledge = bucket === 'kb-files' || isKnowledgeStoragePath(path);
  if (privateKnowledge) {
    const auth = c.get('auth');
    if (!auth || !isKnowledgeStoragePath(path) || !pathAllowed(auth.member.workspaceId || DEFAULT_WORKSPACE, path)
      || !await knowledgeStorageAllowed(c.env, auth, path, 'view')) {
      return c.json({ data: null, error: { message: 'Object not found' } }, 404);
    }
  }
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
  const cacheable = bucket === 'task-images' && !privateKnowledge;
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
  if (cacheable) {
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
  const paths = [...new Set(requested.filter((p) => typeof p === 'string' && pathAllowed(ws, p)))];
  if (bucket === 'task-images' || bucket === 'kb-files') {
    for (const path of paths) {
      if (!await knowledgeStorageAllowed(c.env, c.get('auth'), path)) {
        return c.json({ data: null, error: { message: 'kb_forbidden' } }, 403);
      }
    }
  }

  // Credit each successful deletion once; a later failure must not lose earlier credits.
  for(const path of paths){const objectKey=key(bucket,path),head=await c.env.ATTACHMENTS.head(objectKey);await c.env.ATTACHMENTS.delete(objectKey);await releaseStorageBytes(c.env,ws,head?.size||0);}
  return c.json({ data: paths, error: null });
}
