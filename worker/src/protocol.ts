// LIVO Cloudflare backend — wire protocol shared by the Worker and the
// frontend cfClient shim. Pure types only: this file is imported by both
// tsconfigs (worker + vite app), so it must not reference DOM or Workers types.

// ─── Errors ──────────────────────────────────────────────────────────────

export interface ApiError {
  message: string;
  /** Postgres-compatible code where call sites check it (e.g. '23505' unique violation, 'PGRST116' no rows). */
  code?: string;
}

// ─── Query (POST /api/query) ─────────────────────────────────────────────

export type FilterOp =
  | 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte'
  | 'like' | 'ilike' | 'is' | 'in'
  | 'not.eq' | 'not.is' | 'not.in'
  | 'contains' | 'overlaps'
  /** Raw PostgREST-style or_ expression: val is the string given to .or() */
  | 'or';

export interface QueryFilter {
  col: string;
  op: FilterOp;
  val: unknown;
}

export interface OrderSpec {
  col: string;
  ascending: boolean;
  nullsFirst?: boolean;
  /** Order inside an embedded relation, e.g. .order('x', { foreignTable: 'comments' }) */
  foreignTable?: string;
}

export interface QueryRequest {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete' | 'upsert';
  /**
   * Raw select string as given to .select(), parsed server-side.
   * Supports '*', column lists, and one level of embeds: 'a, b, rel(x, y)'.
   */
  cols?: string;
  filters?: QueryFilter[];
  order?: OrderSpec[];
  limit?: number;
  /** .range(from, to) → offset=from, limit=to-from+1 */
  offset?: number;
  single?: boolean;
  maybeSingle?: boolean;
  /** { count: 'exact' } on select/insert */
  count?: 'exact';
  /** head:true → return count only, no rows */
  head?: boolean;
  /** Rows for insert/upsert (array) or patch object for update. */
  values?: unknown;
  onConflict?: string;
  ignoreDuplicates?: boolean;
}

export interface QueryResponse {
  data: unknown;
  error: ApiError | null;
  count?: number | null;
}

// ─── Auth (POST /api/auth/*) ─────────────────────────────────────────────

export interface AuthUser {
  id: string;          // auth user id (uuid) — maps to members.auth_id
  email: string;
}

export interface AuthSession {
  user: AuthUser;
  access_token: string;
  refresh_token: string;
  /** Unix seconds when access_token expires. */
  expires_at: number;
}

export interface LoginRequest { email: string; password: string }
export interface RefreshRequest { refresh_token: string }
export interface AuthResponse { user: AuthUser | null; session: AuthSession | null; error: ApiError | null }

// ─── RPC (POST /api/rpc/:fn) ─────────────────────────────────────────────

export interface RpcResponse { data: unknown; error: ApiError | null }

// ─── Realtime (WS /api/realtime?token=...) ───────────────────────────────
// One WebSocket per client, channels multiplexed. Presence key = member id.
// postgres_changes semantics preserved: events echo back to the sender.

export interface ChangeBinding {
  table: string;
  /** '*' | 'INSERT' | 'UPDATE' | 'DELETE' */
  event: string;
  /** Only 'col=eq.value' is supported (matches app usage: task_id=eq.<id>). */
  filter?: string;
}

export type ClientMsg =
  | { t: 'join'; ch: string; bindings?: ChangeBinding[]; presenceKey?: string }
  | { t: 'leave'; ch: string }
  | { t: 'track'; ch: string; payload: Record<string, unknown> }
  | { t: 'untrack'; ch: string }
  | { t: 'hb' };

export type ServerMsg =
  | { t: 'joined'; ch: string }
  /** Full presence snapshot, sent on every join/leave/track/untrack/disconnect. */
  | { t: 'presence'; ch: string; state: Record<string, Record<string, unknown>[]> }
  | {
      t: 'change';
      ch: string;
      table: string;
      eventType: 'INSERT' | 'UPDATE' | 'DELETE';
      new: Record<string, unknown> | null;
      old: Record<string, unknown> | null;
    }
  | { t: 'hb_ack' }
  | { t: 'error'; ch?: string; message: string };

/** Worker → DO internal notification of a committed DB change. */
export interface ChangeEvent {
  table: string;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
}

// ─── Storage (/api/storage/:bucket/...) ──────────────────────────────────

export interface StorageUploadResponse { data: { path: string } | null; error: ApiError | null }
export interface StorageRemoveRequest { paths: string[] }

// ─── Functions (POST /api/functions/:name) ──────────────────────────────

export interface FunctionResponse { data: unknown; error: ApiError | null }
