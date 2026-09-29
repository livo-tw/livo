// db.ts — the /api/query engine: translates QueryRequest (PostgREST-subset)
// into D1 SQL. Every identifier interpolated into SQL is validated against
// IDENT_RE; every value is a bound parameter. Rows leaving the Worker pass
// through rowToWire(); client values written to D1 pass through valueToDb().
// Multi-row statements are chunked at <=80 bound params and run atomically
// via env.DB.batch(). This function NEVER throws — all failures come back as
// { data: null, error: { message } }.

import type { Ctx, Env, AuthCtx } from './env';
import { DEMO_BLOCKED_MESSAGE, DEFAULT_WORKSPACE, isDemoMember } from './env';
import type {
  QueryRequest,
  QueryResponse,
  QueryFilter,
  OrderSpec,
  ApiError,
  ChangeEvent,
} from './protocol';
import { TABLES } from './tables';
import { rowToWire, valueToDb, nowIso } from './meta';
import type { TableMeta, WriteRule } from './meta';
import { notifyChanges } from './notify';
import { sendNotificationEmails } from './functions/emailNotify';
import { dispatchWebhooks } from './functions/webhooks';

// Structural tables the hourly demo reset cannot heal — writes from demo
// users are blocked on these (see the demo write-guard in runQuery).
const DEMO_PROTECTED_TABLES = new Set([
  'system_settings',
  'members',
  'statuses',
  'status_transition_rules',
]);

const MAX_PARAMS = 80;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Row = Record<string, unknown>;

// ─── Server-side permission floor ─────────────────────────────────────────
// Role ranks (members.role): member < admin < super_admin. Exported for the
// route-level role middlewares in index.ts.
export const ROLE_RANK: Record<string, number> = { member: 0, admin: 1, super_admin: 2 };

export function roleRank(role: string | null | undefined): number {
  return ROLE_RANK[role ?? ''] ?? 0; // unknown roles get the lowest rank
}

// Strictness order for combining insert+update on upsert (least → most).
const RULE_STRICTNESS: Record<WriteRule, number> = { all: 0, own: 1, admin: 2, super: 3, none: 4 };

function stricterRule(a: WriteRule, b: WriteRule): WriteRule {
  return RULE_STRICTNESS[a] >= RULE_STRICTNESS[b] ? a : b;
}

// Secure-by-default fallback for a future full-access table whose registry
// entry forgot the write spec: admins keep working, members get 42501.
const DEFAULT_WRITE: NonNullable<TableMeta['write']> = {
  insert: 'admin',
  update: 'admin',
  delete: 'admin',
};

function permissionDenied(table: string): QueryResponse {
  return {
    data: null,
    error: { message: `permission denied for table ${table}`, code: '42501' },
  };
}

/** Normalize req.values to plain-object rows (malformed entries are skipped —
 *  prepareRows rejects them later with its own error). */
function valuesAsRows(reqValues: unknown): Row[] {
  const input = Array.isArray(reqValues) ? reqValues : [reqValues];
  return input.filter(
    (r): r is Row => r !== null && typeof r === 'object' && !Array.isArray(r)
  );
}

// members SPECIAL rule column allowlists (see enforceWritePolicy). theme and
// auth_id must stay self-writable — the login linking flow depends on them
// (App.tsx:141 / useAuthState.ts) — and admins additionally get sort_order.
const MEMBERS_ADMIN_COLS = new Set(['theme', 'auth_id', 'sort_order']);
const MEMBERS_SELF_COLS = new Set(['theme', 'auth_id']);

/**
 * Permission floor for /api/query mutations — the server-side replacement for
 * the permissive RLS this backend inherited. Runs BEFORE any mutation SQL.
 * Returns an error QueryResponse to short-circuit, or null to proceed.
 * For 'own' rules on update/delete it INJECTS an `ownerCol = member.id`
 * filter into req.filters (AND-composed with the client WHERE), so foreign
 * rows silently no-op — RLS-like semantics rather than a hard error.
 */
function enforceWritePolicy(
  req: QueryRequest,
  table: string,
  meta: TableMeta,
  auth: AuthCtx
): QueryResponse | null {
  if (req.op === 'select') return null;
  const rank = roleRank(auth?.member?.role);
  const memberId = auth?.member?.id ?? '';

  // ── members SPECIAL rule (checked before the generic rules) ──
  // insert/delete are server-only (manage-member function writes directly).
  // update: super_admin unrestricted; admin may set {theme, auth_id,
  // sort_order} on any row; member may set {theme, auth_id} on their OWN row
  // (own-row via injected id filter — ANDs with the client's id/auth_id
  // filter and still matches their row in the login-linking flows).
  if (table === 'members') {
    if (req.op !== 'update') return permissionDenied(table); // insert/upsert/delete
    if (rank >= 2) return null;
    const patch =
      req.values !== null && typeof req.values === 'object' && !Array.isArray(req.values)
        ? (req.values as Row)
        : {};
    // Same column set db.ts will SET (keys with defined values; db.ts adds no
    // autofields on update, so nothing needs excluding).
    const setCols = Object.keys(patch).filter((k) => patch[k] !== undefined);
    const allowed = rank >= 1 ? MEMBERS_ADMIN_COLS : MEMBERS_SELF_COLS;
    if (setCols.some((c) => !allowed.has(c))) return permissionDenied(table);
    if (rank === 0 && req.filters && req.filters.length) {
      req.filters = [...req.filters, { col: 'id', op: 'eq', val: memberId }];
    }
    return null;
  }

  // ── Generic rules from the registry ──
  const write = meta.write ?? DEFAULT_WRITE;
  const rule: WriteRule =
    req.op === 'upsert' ? stricterRule(write.insert, write.update) : write[req.op];

  switch (rule) {
    case 'all':
      return null;
    case 'none':
      return permissionDenied(table);
    case 'admin':
      return rank >= 1 ? null : permissionDenied(table);
    case 'super':
      return rank >= 2 ? null : permissionDenied(table);
    case 'own': {
      if (rank >= 1) return null; // admin+ unrestricted
      const ownerCol = write.ownerCol;
      if (!ownerCol) return permissionDenied(table); // misconfig → deny
      if (req.op === 'update' || req.op === 'delete') {
        // Inject ownership into the WHERE. If the client sent no filters the
        // op keeps its original "without filters is not allowed" error.
        if (req.filters && req.filters.length) {
          req.filters = [...req.filters, { col: ownerCol, op: 'eq', val: memberId }];
        }
        return null;
      }
      // insert / upsert: every row must belong to the caller.
      for (const row of valuesAsRows(req.values)) {
        if (row[ownerCol] !== memberId) return permissionDenied(table);
      }
      return null;
    }
  }
}

/** Validate an SQL identifier (table/column name). Throws on anything unsafe. */
function ident(name: string): string {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new Error(`Invalid identifier: ${String(name)}`);
  }
  return name;
}

function getMeta(table: string): TableMeta {
  const meta = Object.prototype.hasOwnProperty.call(TABLES, table) ? TABLES[table] : undefined;
  if (!meta || meta.clientAccess !== 'full') {
    throw new Error(`Table "${table}" is not accessible`);
  }
  ident(table); // defense in depth — the name gets interpolated into SQL
  return meta;
}

// ─── Filters ─────────────────────────────────────────────────────────────

/** Coerce one client-supplied filter/write value to its D1 representation. */
function bindVal(col: string, val: unknown, meta: TableMeta): unknown {
  return valueToDb(col, val, meta);
}

const OR_OPS: Record<string, string> = {
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/**
 * Parse a PostgREST .or() expression: comma-joined `col.op.value` conditions
 * with ops eq|neq|is|gt|gte|lt|lte; `col.is.null` → IS NULL.
 * Covers the app's single call site `project_id.eq.X,project_id.is.null`.
 */
function parseOr(expr: string, meta: TableMeta, params: unknown[]): string {
  const parts = expr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('Empty or() expression');
  const conds = parts.map((part) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\.(eq|neq|is|gt|gte|lt|lte)\.([\s\S]*)$/.exec(part);
    if (!m) throw new Error(`Unsupported or() condition: ${part}`);
    const col = m[1];
    const op = m[2];
    const raw = m[3];
    if (col === undefined || op === undefined || raw === undefined) {
      throw new Error(`Unsupported or() condition: ${part}`);
    }
    ident(col);
    if (op === 'is') {
      if (raw === 'null') return `${col} IS NULL`;
      if (raw === 'true') return `${col} IS 1`;
      if (raw === 'false') return `${col} IS 0`;
      throw new Error(`or(): is only supports null/true/false, got "${raw}"`);
    }
    let val: unknown = raw;
    if ((meta.boolCols || []).includes(col)) {
      if (raw === 'true') val = 1;
      else if (raw === 'false') val = 0;
    }
    params.push(val);
    return `${col} ${OR_OPS[op]} ?`;
  });
  return `(${conds.join(' OR ')})`;
}

/** Build one SQL condition, pushing bound params. */
function buildCondition(f: QueryFilter, meta: TableMeta, params: unknown[]): string {
  if (f.op === 'or') {
    if (typeof f.val !== 'string') throw new Error('or() filter requires a string expression');
    return parseOr(f.val, meta, params);
  }
  const col = ident(f.col);
  switch (f.op) {
    case 'eq':
      params.push(bindVal(col, f.val, meta));
      return `${col} = ?`;
    case 'neq':
    case 'not.eq':
      params.push(bindVal(col, f.val, meta));
      return `${col} != ?`;
    case 'gt':
      params.push(bindVal(col, f.val, meta));
      return `${col} > ?`;
    case 'gte':
      params.push(bindVal(col, f.val, meta));
      return `${col} >= ?`;
    case 'lt':
      params.push(bindVal(col, f.val, meta));
      return `${col} < ?`;
    case 'lte':
      params.push(bindVal(col, f.val, meta));
      return `${col} <= ?`;
    case 'like':
      params.push(bindVal(col, f.val, meta));
      return `${col} LIKE ?`;
    case 'ilike':
      params.push(bindVal(col, f.val, meta));
      return `LOWER(${col}) LIKE LOWER(?)`;
    case 'is':
      if (f.val === null) return `${col} IS NULL`;
      if (typeof f.val === 'boolean') {
        params.push(f.val ? 1 : 0);
        return `${col} IS ?`;
      }
      throw new Error(`is filter accepts only null or boolean (col ${col})`);
    case 'not.is':
      if (f.val === null) return `${col} IS NOT NULL`;
      if (typeof f.val === 'boolean') {
        params.push(f.val ? 1 : 0);
        return `${col} IS NOT ?`;
      }
      throw new Error(`not.is filter accepts only null or boolean (col ${col})`);
    case 'in': {
      if (!Array.isArray(f.val)) throw new Error(`in filter requires an array (col ${col})`);
      if (f.val.length === 0) return '1=0';
      for (const v of f.val) params.push(bindVal(col, v, meta));
      return `${col} IN (${f.val.map(() => '?').join(', ')})`;
    }
    case 'not.in': {
      if (!Array.isArray(f.val)) throw new Error(`not.in filter requires an array (col ${col})`);
      if (f.val.length === 0) return '1=1';
      for (const v of f.val) params.push(bindVal(col, v, meta));
      return `${col} NOT IN (${f.val.map(() => '?').join(', ')})`;
    }
    default:
      throw new Error(`Unsupported filter op: ${String(f.op)}`);
  }
}

function buildWhere(
  filters: QueryFilter[] | undefined,
  meta: TableMeta
): { sql: string; params: unknown[] } {
  if (!filters || !filters.length) return { sql: '', params: [] };
  const params: unknown[] = [];
  const conds = filters.map((f) => buildCondition(f, meta, params));
  return { sql: ` WHERE ${conds.join(' AND ')}`, params };
}

// ─── SELECT helpers ──────────────────────────────────────────────────────

function buildSelectCols(cols?: string): string {
  const c = (cols ?? '*').trim();
  if (c === '' || c === '*') return '*';
  return c
    .split(',')
    .map((s) => ident(s.trim()))
    .join(', ');
}

function buildOrder(order?: OrderSpec[]): string {
  if (!order || !order.length) return '';
  const parts: string[] = [];
  for (const o of order) {
    if (o.foreignTable) continue; // no embeds exist app-wide; skip foreign-table ordering
    let s = `${ident(o.col)} ${o.ascending === false ? 'DESC' : 'ASC'}`;
    if (o.nullsFirst !== undefined) s += o.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST';
    parts.push(s);
  }
  return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
}

function buildLimitOffset(req: QueryRequest): string {
  let sql = '';
  const hasLimit = typeof req.limit === 'number' && Number.isFinite(req.limit);
  const hasOffset = typeof req.offset === 'number' && Number.isFinite(req.offset);
  if (hasLimit) sql += ` LIMIT ${Math.max(0, Math.floor(req.limit as number))}`;
  else if (hasOffset) sql += ' LIMIT -1'; // SQLite requires LIMIT before OFFSET
  if (hasOffset) sql += ` OFFSET ${Math.max(0, Math.floor(req.offset as number))}`;
  return sql;
}

/** Apply single/maybeSingle result shaping (PostgREST parity). */
function shapeRows(rows: Row[], req: QueryRequest): QueryResponse {
  if (req.single) {
    if (rows.length === 1) return { data: rows[0] ?? null, error: null };
    return {
      data: null,
      error: {
        message: 'JSON object requested, multiple (or no) rows returned',
        code: 'PGRST116',
      },
    };
  }
  if (req.maybeSingle) {
    if (rows.length <= 1) return { data: rows[0] ?? null, error: null };
    return {
      data: null,
      error: {
        message: 'JSON object requested, multiple (or no) rows returned',
        code: 'PGRST116',
      },
    };
  }
  return { data: rows, error: null };
}

// ─── Statement execution ─────────────────────────────────────────────────

/** Run 1..n RETURNING statements; >1 goes through batch() (atomic). */
async function runStatements(env: Env, stmts: D1PreparedStatement[]): Promise<Row[]> {
  if (stmts.length === 0) return [];
  if (stmts.length === 1) {
    const only = stmts[0];
    if (!only) return [];
    const res = await only.all<Row>();
    return res.results;
  }
  const results = await env.DB.batch<Row>(stmts);
  return results.flatMap((r) => r.results);
}

// ─── INSERT / UPSERT ─────────────────────────────────────────────────────

/** Normalize insert/upsert values to rows with registry defaults applied.
 *  `ws` is FORCED onto every row — a client can never write into another
 *  workspace regardless of what it sends. */
function prepareRows(
  reqValues: unknown,
  meta: TableMeta,
  ws: string
): { rows: Row[]; columns: string[] } {
  const input = Array.isArray(reqValues) ? reqValues : [reqValues];
  const rows: Row[] = [];
  for (const r of input) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error('insert/upsert values must be plain objects');
    }
    const row: Row = { ...(r as Row) };
    row.workspace_id = ws; // tenancy floor — overrides any client value
    if (meta.autoId && (row[meta.pk] === undefined || row[meta.pk] === null)) {
      row[meta.pk] = crypto.randomUUID();
    }
    for (const c of meta.autoNowCols || []) {
      if (row[c] === undefined || row[c] === null) row[c] = nowIso();
    }
    rows.push(row);
  }
  // Column set = union of keys across all rows (missing keys bind to NULL).
  const colSet = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (row[k] !== undefined) colSet.add(ident(k));
    }
  }
  return { rows, columns: [...colSet] };
}

function buildInsertStatements(
  env: Env,
  table: string,
  rows: Row[],
  columns: string[],
  meta: TableMeta,
  conflictSql: string
): D1PreparedStatement[] {
  if (!columns.length) throw new Error('insert requires at least one column');
  const rowsPerChunk = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  const tuple = `(${columns.map(() => '?').join(', ')})`;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += rowsPerChunk) {
    const chunk = rows.slice(i, i + rowsPerChunk);
    const sql =
      `INSERT INTO ${table} (${columns.join(', ')}) ` +
      `VALUES ${chunk.map(() => tuple).join(', ')}${conflictSql} RETURNING *`;
    const params: unknown[] = [];
    for (const row of chunk) {
      for (const c of columns) params.push(valueToDb(c, row[c], meta));
    }
    stmts.push(env.DB.prepare(sql).bind(...params));
  }
  return stmts;
}

/** Validate onConflict against the registry: must equal the pk or a declared unique set. */
function resolveConflictTarget(meta: TableMeta, onConflict?: string): string[] {
  if (!onConflict) return [meta.pk];
  const cols = onConflict.split(',').map((s) => ident(s.trim()));
  const key = (a: string[]) => [...a].sort().join(',');
  const wanted = key(cols);
  if (wanted === key([meta.pk])) return cols;
  for (const u of meta.uniques || []) {
    if (key(u) === wanted) return cols;
  }
  throw new Error(`onConflict "${onConflict}" does not match the primary key or a unique constraint`);
}

// ─── UPDATE / DELETE ─────────────────────────────────────────────────────

/**
 * Build statement(s) for `<prefixSql> WHERE <filters> RETURNING *`.
 * If the bound-param total exceeds MAX_PARAMS and there is a plain `in`
 * filter, its array is split across multiple statements (batched atomically)
 * — the unions of the per-chunk WHERE clauses are equivalent for `in`.
 */
function buildFilteredWriteStatements(
  env: Env,
  prefixSql: string,
  prefixParams: unknown[],
  filters: QueryFilter[],
  meta: TableMeta
): D1PreparedStatement[] {
  const whole = buildWhere(filters, meta);
  const single = () =>
    [env.DB.prepare(`${prefixSql}${whole.sql} RETURNING *`).bind(...prefixParams, ...whole.params)];

  if (prefixParams.length + whole.params.length <= MAX_PARAMS) return single();

  // Find the largest chunkable `in` filter (only plain `in` unions correctly).
  let bigIdx = -1;
  let bigLen = 0;
  filters.forEach((f, i) => {
    if (f.op === 'in' && Array.isArray(f.val) && f.val.length > bigLen) {
      bigIdx = i;
      bigLen = f.val.length;
    }
  });
  if (bigIdx === -1) return single(); // nothing to split; let D1 report the limit

  const big = filters[bigIdx];
  if (!big || !Array.isArray(big.val)) return single();
  const others = filters.filter((_, i) => i !== bigIdx);
  const othersParamCount = buildWhere(others, meta).params.length;
  const budget = MAX_PARAMS - prefixParams.length - othersParamCount;
  if (budget < 1) return single();

  const arr = big.val as unknown[];
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < arr.length; i += budget) {
    const sub: QueryFilter[] = filters.map((f, idx) =>
      idx === bigIdx ? { ...f, val: arr.slice(i, i + budget) } : f
    );
    const w = buildWhere(sub, meta);
    stmts.push(env.DB.prepare(`${prefixSql}${w.sql} RETURNING *`).bind(...prefixParams, ...w.params));
  }
  return stmts;
}

// ─── Change events ───────────────────────────────────────────────────────

function insertEvents(table: string, rows: Row[]): ChangeEvent[] {
  return rows.map((r) => ({ table, eventType: 'INSERT' as const, new: r, old: null }));
}

function updateEvents(table: string, rows: Row[], pk: string): ChangeEvent[] {
  return rows.map((r) => ({
    table,
    eventType: 'UPDATE' as const,
    new: r,
    old: { [pk]: r[pk] },
  }));
}

function deleteEvents(table: string, rows: Row[]): ChangeEvent[] {
  return rows.map((r) => ({ table, eventType: 'DELETE' as const, new: null, old: r }));
}

// ─── Post-mutation side-effects ──────────────────────────────────────────
// The single dispatch point after a successful mutation: realtime fan-out
// (always) + notification emails (INSERTs on `notifications`) + outbound
// webhooks (tasks/comments events). Both extras run via ctx.waitUntil, are
// internally demo-gated and never throw — the response is never blocked and
// a hook failure can never fail the write.

const WEBHOOK_EVENT: Record<string, string> = {
  'tasks:INSERT': 'task_created',
  'tasks:UPDATE': 'task_updated', // upsert emits UPDATE events → task_updated
  'tasks:DELETE': 'task_deleted',
  'comments:INSERT': 'comment_added',
};

function emitChanges(env: Env, ctx: Ctx, events: ChangeEvent[], ws: string): void {
  notifyChanges(env, ctx, events, ws);
  try {
    const first = events[0];
    if (!first) return;
    // All events of one call share table+eventType (see the builders above).
    const rows = events
      .map((e) => (e.eventType === 'DELETE' ? e.old : e.new))
      .filter((r): r is Row => r !== null);
    if (!rows.length) return;
    if (first.table === 'notifications' && first.eventType === 'INSERT') {
      ctx.waitUntil(sendNotificationEmails(env, rows));
      return;
    }
    const webhookEvent = WEBHOOK_EVENT[`${first.table}:${first.eventType}`];
    if (webhookEvent) ctx.waitUntil(dispatchWebhooks(env, webhookEvent, rows));
  } catch {
    /* side-effects are strictly best-effort */
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────

export async function runQuery(
  env: Env,
  ctx: Ctx,
  auth: AuthCtx,
  req: QueryRequest
): Promise<QueryResponse> {
  // Authorization: requireMember (valid active member) + the clientAccess
  // allowlist + enforceWritePolicy below (role floor / own-row scoping).
  try {
    const table = String(req.table ?? '');
    const meta = getMeta(table);

    // ── Tenancy floor ── every clientAccess:'full' table is workspace-scoped.
    // Reads/updates/deletes get a server-injected workspace filter (appended
    // AFTER the op-level "no filters" validations so their semantics keep
    // holding); inserts/upserts get workspace_id forced per-row in
    // prepareRows. Self-host/local installs live entirely in 'default'.
    const ws = auth?.member?.workspaceId || DEFAULT_WORKSPACE;
    const withWs = (filters?: QueryFilter[]): QueryFilter[] => [
      { col: 'workspace_id', op: 'eq', val: ws },
      ...(filters || []),
    ];

    // Demo write-guard (contract T3): demo users may browse and move tasks,
    // but must not rewrite STRUCTURAL tables — the hourly demo reset only
    // restores business tables (tasks/projects/…), so damage here would be
    // permanent: system_settings (license/team config), members (role
    // self-escalation, deleting the team), statuses (breaking every board),
    // and status transition rules. Only writes are blocked; reads pass
    // through, and task play stays fully usable. Cloud-beta tenants are NOT
    // demo users (isDemoMember is workspace-scoped).
    if (
      DEMO_PROTECTED_TABLES.has(table) &&
      req.op !== 'select' &&
      isDemoMember(env, auth)
    ) {
      return { data: null, error: { message: DEMO_BLOCKED_MESSAGE } };
    }

    // Server-side permission floor (role-based write rules + own-row scoping).
    const denied = enforceWritePolicy(req, table, meta, auth);
    if (denied) return denied;

    switch (req.op) {
      // ── SELECT ──────────────────────────────────────────────────────
      case 'select': {
        const cols = buildSelectCols(req.cols);
        const where = buildWhere(withWs(req.filters), meta);

        if (req.count === 'exact' && req.head) {
          const c = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM ${table}${where.sql}`)
            .bind(...where.params)
            .first<{ cnt: number }>();
          return { data: null, error: null, count: c?.cnt ?? 0 };
        }

        const sql = `SELECT ${cols} FROM ${table}${where.sql}${buildOrder(req.order)}${buildLimitOffset(req)}`;
        const res = await env.DB.prepare(sql).bind(...where.params).all<Row>();
        const rows = res.results.map((r) => rowToWire(r, meta));

        const shaped = shapeRows(rows, req);
        if (req.count === 'exact') {
          const c = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM ${table}${where.sql}`)
            .bind(...where.params)
            .first<{ cnt: number }>();
          return { ...shaped, count: c?.cnt ?? 0 };
        }
        return shaped;
      }

      // ── INSERT ──────────────────────────────────────────────────────
      case 'insert': {
        if (req.values === undefined || req.values === null) {
          throw new Error('insert requires values');
        }
        const { rows, columns } = prepareRows(req.values, meta, ws);
        if (!rows.length) {
          const empty = shapeRows([], req);
          return req.count === 'exact' ? { ...empty, count: 0 } : empty;
        }
        const stmts = buildInsertStatements(env, table, rows, columns, meta, '');
        const returned = (await runStatements(env, stmts)).map((r) => rowToWire(r, meta));
        emitChanges(env, ctx, insertEvents(table, returned), ws);
        const shaped = shapeRows(returned, req);
        return req.count === 'exact' ? { ...shaped, count: returned.length } : shaped;
      }

      // ── UPSERT ──────────────────────────────────────────────────────
      case 'upsert': {
        if (req.values === undefined || req.values === null) {
          throw new Error('upsert requires values');
        }
        const { rows, columns } = prepareRows(req.values, meta, ws);
        if (!rows.length) {
          const empty = shapeRows([], req);
          return req.count === 'exact' ? { ...empty, count: 0 } : empty;
        }
        // wsConflict tables carry workspace_id in a composite unique — extend
        // the client's LOGICAL target to the physical one, but ONLY when that
        // target really is composite: the pk needs wsPk (composite PRIMARY
        // KEY), a declared unique is always composite on wsConflict tables.
        // A plain upsert-by-id (notification_templates) must stay ON
        // CONFLICT (id) or SQLite rejects the statement outright.
        const logicalTarget = resolveConflictTarget(meta, req.onConflict);
        const isPlainPk = logicalTarget.length === 1 && logicalTarget[0] === meta.pk;
        const target =
          meta.wsConflict && (!isPlainPk || meta.wsPk)
            ? ['workspace_id', ...logicalTarget]
            : logicalTarget;
        const updateCols = columns.filter(
          (c) => !target.includes(c) && c !== meta.pk && c !== 'created_at' && c !== 'workspace_id',
        );
        // The DO UPDATE guard turns a conflict against ANOTHER workspace's
        // row (ids are client-suppliable) into a no-op instead of a hijack.
        const doClause =
          req.ignoreDuplicates || updateCols.length === 0
            ? ' DO NOTHING'
            : ` DO UPDATE SET ${updateCols.map((c) => `${c} = excluded.${c}`).join(', ')}` +
              ' WHERE workspace_id = excluded.workspace_id';
        const conflictSql = ` ON CONFLICT (${target.join(', ')})${doClause}`;
        const stmts = buildInsertStatements(env, table, rows, columns, meta, conflictSql);
        const returned = (await runStatements(env, stmts)).map((r) => rowToWire(r, meta));
        // Insert-vs-update is indistinguishable post-hoc; UPDATE is the safe
        // choice for the app's handlers (idempotent overwrite / refetch).
        emitChanges(env, ctx, updateEvents(table, returned, meta.pk), ws);
        const shaped = shapeRows(returned, req);
        return req.count === 'exact' ? { ...shaped, count: returned.length } : shaped;
      }

      // ── UPDATE ──────────────────────────────────────────────────────
      case 'update': {
        if (!req.filters || !req.filters.length) {
          throw new Error('update without filters is not allowed');
        }
        if (
          req.values === null ||
          typeof req.values !== 'object' ||
          Array.isArray(req.values)
        ) {
          throw new Error('update requires a values object');
        }
        const patch = req.values as Row;
        const setCols = Object.keys(patch)
          .filter((k) => patch[k] !== undefined && k !== 'workspace_id') // rows can never change workspace
          .map((k) => ident(k));
        if (!setCols.length) throw new Error('update requires at least one column');
        const setSql = setCols.map((c) => `${c} = ?`).join(', ');
        const setParams = setCols.map((c) => valueToDb(c, patch[c], meta));

        const stmts = buildFilteredWriteStatements(
          env,
          `UPDATE ${table} SET ${setSql}`,
          setParams,
          withWs(req.filters),
          meta
        );
        const returned = (await runStatements(env, stmts)).map((r) => rowToWire(r, meta));
        if (returned.length) {
          emitChanges(env, ctx, updateEvents(table, returned, meta.pk), ws);
        }
        return shapeRows(returned, req);
      }

      // ── DELETE ──────────────────────────────────────────────────────
      case 'delete': {
        if (!req.filters || !req.filters.length) {
          throw new Error('delete without filters is not allowed');
        }
        const stmts = buildFilteredWriteStatements(
          env,
          `DELETE FROM ${table}`,
          [],
          withWs(req.filters),
          meta
        );
        const returned = (await runStatements(env, stmts)).map((r) => rowToWire(r, meta));
        if (returned.length) {
          emitChanges(env, ctx, deleteEvents(table, returned), ws);
        }
        return shapeRows(returned, req);
      }

      default:
        throw new Error(`Unsupported op: ${String(req.op)}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const error: ApiError = { message };
    if (/UNIQUE constraint failed/i.test(message)) error.code = '23505';
    return { data: null, error };
  }
}
