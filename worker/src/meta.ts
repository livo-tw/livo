// Table metadata registry interface + wire<->db value coercion.
// The concrete `TABLES` data lives in tables.ts (generated from the schema).
//
// D1/SQLite stores booleans as 0/1 and json/arrays as TEXT, but the frontend
// expects JSON true/false and real arrays/objects (it uses patterns like
// `row.is_active !== false` that break on 0/1). Every row that leaves the
// Worker MUST pass through rowToWire(); every client-provided value written
// to D1 MUST pass through valueToDb().

/**
 * Server-side write floor for one mutation kind (RLS replacement):
 *   'all'   — any active member
 *   'own'   — member-role callers limited to rows whose `ownerCol` equals
 *             their member id (admin+ unrestricted)
 *   'admin' — admin or super_admin
 *   'super' — super_admin only
 *   'none'  — no client writes at all (server-side code paths only)
 */
export type WriteRule = 'all' | 'own' | 'admin' | 'super' | 'none';

export interface TableMeta {
  /** Primary key column(s). Single-col for all client tables. */
  pk: string;
  /** Composite unique keys usable as upsert onConflict targets. */
  uniques?: string[][];
  /** May the frontend /api/query touch this table? */
  clientAccess: 'full' | 'none';
  /**
   * Per-op write rules enforced in db.ts (runQuery) BEFORE any mutation runs.
   * Every clientAccess:'full' table MUST declare this; if a future table
   * forgets, db.ts falls back to admin/admin/admin (secure by default).
   * upsert is checked against the stricter of insert+update.
   * `ownerCol` is required whenever any rule is 'own'.
   */
  write?: { insert: WriteRule; update: WriteRule; delete: WriteRule; ownerCol?: string };
  /** Protected system-setting keys add a super_admin write floor in db.ts. */
  superOnlyKeys?: readonly string[];
  /** Columns stored as INTEGER 0/1 but exposed as JSON booleans. */
  boolCols?: string[];
  /** Columns stored as TEXT JSON but exposed as parsed JSON values. */
  jsonCols?: string[];
  /** Generate crypto.randomUUID() id on insert when absent. */
  autoId?: boolean;
  /** Auto-fill with ISO now() on insert when absent (e.g. 'created_at'). */
  autoNowCols?: string[];
  /**
   * SOME physical unique on this table includes workspace_id, so db.ts
   * ws-extends the client's logical upsert conflict target — but only when
   * that logical target is actually the composite one: a declared `uniques`
   * entry (notification_templates name → (workspace_id, name)), or the pk
   * itself when `wsPk` is also set (system_settings/team_settings key →
   * PRIMARY KEY (workspace_id, key)). A plain upsert-by-id on a table whose
   * id stays a standalone PK must NOT be extended (ON CONFLICT would match
   * no index and hard-fail). Tenancy scoping itself needs no flag — EVERY
   * clientAccess:'full' table is workspace-scoped (see runQuery).
   */
  wsConflict?: boolean;
  /** The physical PRIMARY KEY is (workspace_id, pk). Implies wsConflict. */
  wsPk?: boolean;
}

export type TableRegistry = Record<string, TableMeta>;

export function rowToWire(row: Record<string, unknown>, meta: TableMeta): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const c of meta.boolCols || []) {
    if (c in out && out[c] !== null && out[c] !== undefined) out[c] = !!out[c];
  }
  for (const c of meta.jsonCols || []) {
    const v = out[c];
    if (typeof v === 'string' && v !== '') {
      try { out[c] = JSON.parse(v); } catch { /* leave as-is (legacy plain text) */ }
    }
  }
  return out;
}

export function valueToDb(col: string, val: unknown, meta: TableMeta): unknown {
  if (val === undefined) return null;
  if ((meta.boolCols || []).includes(col)) {
    if (val === null) return null;
    return val ? 1 : 0;
  }
  if ((meta.jsonCols || []).includes(col)) {
    if (val === null) return null;
    return typeof val === 'string' ? val : JSON.stringify(val);
  }
  if (typeof val === 'boolean') return val ? 1 : 0; // safety net
  if (val !== null && typeof val === 'object') return JSON.stringify(val);
  return val;
}

export const nowIso = () => new Date().toISOString();
