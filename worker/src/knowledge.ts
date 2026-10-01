/** Knowledge mutations are single-row, optimistic and permission-checked in SQL. */
import type { AuthCtx, Ctx, Env } from './env';
import { DEFAULT_WORKSPACE } from './env';
import type { QueryRequest, QueryResponse } from './protocol';
import { rowToWire } from './meta';
import { TABLES } from './tables';
import { notifyChanges } from './notify';

const pageColumns = new Set(['title', 'body', 'parent_id', 'project_id', 'sort_order', 'admin_only', 'is_archived']);
const fail = (message: string): QueryResponse => ({ data: null, error: { message, code: '42501' } });
export const knowledgeAdmin = (role: string) => role === 'admin' || role === 'super_admin';

export async function knowledgeLockAllowed(env: Env, auth: AuthCtx, lockKey: string): Promise<boolean> {
  if (!lockKey.startsWith('kb:')) return true;
  const row = await env.DB.prepare(`SELECT id FROM kb_pages WHERE workspace_id = ? AND id = ?
    AND ((is_archived = 0 AND admin_only = 0) OR ? = 1)`)
    .bind(auth.member.workspaceId || DEFAULT_WORKSPACE, lockKey.slice(3), knowledgeAdmin(auth.member.role) ? 1 : 0).first();
  return !!row;
}

export async function writeKnowledge(env: Env, ctx: Ctx, auth: AuthCtx, req: QueryRequest): Promise<QueryResponse> {
  const ws = auth.member.workspaceId || DEFAULT_WORKSPACE;
  const member = auth.member.id;
  const admin = knowledgeAdmin(auth.member.role) ? 1 : 0;
  if (!member || req.op === 'upsert' || req.table === 'kb_revisions') return fail('kb_forbidden');
  const values = req.values && typeof req.values === 'object' && !Array.isArray(req.values)
    ? req.values as Record<string, unknown> : {};
  const value = (key: string) => values[key];
  const id = req.op === 'insert' ? crypto.randomUUID() : req.filters?.find(f => f.col === 'id' && f.op === 'eq')?.val;
  if (typeof id !== 'string' || req.filters?.some(f => f.op !== 'eq' || !['id', 'version', 'created_by'].includes(f.col))) return fail('kb_invalid_request');
  const stamp = new Date().toISOString();
  // Every mutation checks the live lock, not a prior SELECT that can race.
  const lock = `NOT EXISTS (SELECT 1 FROM field_locks WHERE workspace_id = ? AND lock_key = 'kb:' || kb_pages.id AND locked_by != ? AND expires_at > ?)`;
  const editable = `(admin_only = 0 OR ? = 1) AND is_archived = 0 AND ${lock}`;
  let statement: D1PreparedStatement;
  let pageId = id;
  if (req.table === 'kb_pages') {
    const allowed = new Set([...pageColumns, 'created_by', 'updated_by']);
    if (Object.keys(values).some(k => !allowed.has(k))) return fail('kb_forbidden');
    if (!admin && (value('admin_only') !== undefined || value('is_archived') !== undefined)) return fail('kb_forbidden');
    if (value('title') !== undefined && (typeof value('title') !== 'string' || !(value('title') as string).trim() || (value('title') as string).length > 200)) return fail('kb_invalid_title');
    if (value('body') !== undefined && (typeof value('body') !== 'string' || (value('body') as string).length > 1000000)) return fail('kb_invalid_body');
    for (const key of ['admin_only', 'is_archived']) if (value(key) !== undefined && typeof value(key) !== 'boolean') return fail('kb_invalid_request');
    if (value('sort_order') !== undefined && !Number.isSafeInteger(value('sort_order'))) return fail('kb_invalid_request');
    if (req.op === 'insert') {
      if (typeof value('title') !== 'string') return fail('kb_invalid_title');
      statement = env.DB.prepare(`INSERT INTO kb_pages
        (id, workspace_id, title, body, project_id, parent_id, sort_order, admin_only, is_archived, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
        .bind(id, ws, (value('title') as string).trim(), value('body') ?? '', value('project_id') ?? null,
          value('parent_id') ?? null, value('sort_order') ?? 0, value('admin_only') ? 1 : 0, value('is_archived') ? 1 : 0, member, member, stamp, stamp);
    } else if (req.op === 'update') {
      const version = req.filters?.find(f => f.col === 'version')?.val;
      if (!Number.isSafeInteger(version)) return fail('kb_conflict');
      const cols = Object.keys(values).filter(k => pageColumns.has(k));
      if (!cols.length) return fail('kb_invalid_request');
      // An admin may unarchive, but archived content remains immutable until then.
      const unarchive = admin && cols.length === 1 && value('is_archived') === false;
      const eligibility = unarchive ? lock : editable;
      statement = env.DB.prepare(`UPDATE kb_pages SET ${cols.map(k => `${k} = ?`).join(', ')},
        updated_by = ?, updated_at = ?, version = version + 1
        WHERE workspace_id = ? AND id = ? AND version = ? AND ${eligibility}
        AND EXISTS (SELECT 1 FROM field_locks WHERE workspace_id = ? AND lock_key = 'kb:' || kb_pages.id AND locked_by = ? AND expires_at > ?)
        RETURNING *`).bind(...cols.map(k => typeof value(k) === 'boolean' ? Number(value(k)) : value(k)),
          member, stamp, ws, id, version, ...(unarchive ? [] : [admin]), ws, member, stamp, ws, member, stamp);
    } else if (req.op === 'delete') {
      statement = env.DB.prepare(`DELETE FROM kb_pages WHERE workspace_id = ? AND id = ?
        AND (? = 1 OR created_by = ?) AND ${lock} RETURNING *`).bind(ws, id, admin, member, ws, member, stamp);
    } else return fail('kb_invalid_request');
  } else if (req.table === 'kb_attachments') {
    if (req.op === 'insert') {
      pageId = String(value('page_id') ?? '');
      const path = String(value('storage_path') ?? '');
      const prefix = `${ws === DEFAULT_WORKSPACE ? '' : `ws/${ws}/`}kb/${pageId}/`;
      if (!pageId || !path.startsWith(prefix) || path.includes('..') || !value('file_name') || !Number.isSafeInteger(value('file_size')) || Number(value('file_size')) < 0 || Number(value('file_size')) > 2097152) return fail('kb_invalid_attachment');
      statement = env.DB.prepare(`INSERT INTO kb_attachments
        (id, workspace_id, page_id, file_name, file_size, file_type, storage_path, uploaded_by, created_at)
        SELECT ?, ?, id, ?, ?, ?, ?, ?, ? FROM kb_pages WHERE workspace_id = ? AND id = ? AND ${editable} RETURNING *`)
        .bind(id, ws, value('file_name'), value('file_size'), value('file_type') ?? '', path, member, stamp,
          ws, pageId, admin, ws, member, stamp);
    } else if (req.op === 'delete') {
      statement = env.DB.prepare(`DELETE FROM kb_attachments WHERE workspace_id = ? AND id = ? AND page_id IN (
        SELECT id FROM kb_pages WHERE workspace_id = ? AND ${editable}) RETURNING *`)
        .bind(ws, id, ws, admin, ws, member, stamp);
    } else return fail('kb_forbidden');
  } else return fail('kb_forbidden');
  const result = await statement.all<Record<string, unknown>>();
  const rows = result.results.map(r => rowToWire(r, TABLES[req.table]!));
  if (!rows.length) return fail('kb_conflict');
  notifyChanges(env, ctx, rows.map(r => ({ table: req.table,
    eventType: req.op === 'delete' ? 'DELETE' as const : req.op === 'insert' ? 'INSERT' as const : 'UPDATE' as const,
    new: req.op === 'delete' ? null : r, old: req.op === 'delete' ? r : null })), ws);
  // Revision subscribers reload after a save; the trigger already committed.
  if (req.table === 'kb_pages' && req.op === 'update') {
    const revision = await env.DB.prepare('SELECT * FROM kb_revisions WHERE workspace_id = ? AND page_id = ? AND version = ?')
      .bind(ws, id, req.filters?.find(f => f.col === 'version')?.val).first<Record<string, unknown>>();
    if (revision) notifyChanges(env, ctx, [{ table: 'kb_revisions', eventType: 'INSERT', new: revision, old: null }], ws);
  }
  return { data: req.single || req.maybeSingle ? rows[0] : rows, error: null };
}

/** The shared task-images bucket must not bypass a locked page's file policy. */
export async function knowledgeStorageAllowed(env: Env, auth: AuthCtx, path: string): Promise<boolean> {
  const ws = auth.member.workspaceId || DEFAULT_WORKSPACE;
  const local = ws === DEFAULT_WORKSPACE ? path : path.replace(`ws/${ws}/`, '');
  if (!local.startsWith('kb/')) return true;
  const pageId = local.split('/')[1];
  if (!pageId || local.includes('..')) return false;
  const row = await env.DB.prepare(`SELECT id FROM kb_pages WHERE workspace_id = ? AND id = ?
    AND is_archived = 0 AND (admin_only = 0 OR ? = 1)
    AND NOT EXISTS (SELECT 1 FROM field_locks WHERE workspace_id = ? AND lock_key = 'kb:' || kb_pages.id
      AND locked_by != ? AND expires_at > ?)`).bind(ws, pageId, knowledgeAdmin(auth.member.role) ? 1 : 0,
      ws, auth.member.id, new Date().toISOString()).first();
  return !!row;
}
