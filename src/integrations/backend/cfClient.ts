// LIVO Cloudflare backend client — drop-in replacement for the supabase-js
// subset the app uses (mockClient.ts is the interface reference; the wire
// contract is worker/src/protocol.ts + worker/DESIGN.md).
//
// - Query builders are LAZY THENABLES: nothing executes until `.then()` is
//   invoked (await / Promise.all / .then / .catch). They never reject — network
//   failures resolve to `{ data: null, error: { message } }` because the app
//   only ever reads `error.message`.
// - Auth sessions persist in localStorage['livo-auth'] with auto-refresh
//   scheduled at expiry minus 60 s. Events fired: 'SIGNED_IN' (async, like the
//   mock), 'SIGNED_OUT' (sync), 'TOKEN_REFRESHED'.
// - Realtime: ONE WebSocket to `${API_URL}/api/realtime?token=...`, opened
//   lazily on first subscribe; 15 s heartbeat; reconnect backoff
//   [500, 1000, 2000, 5000, 10000] (cap at last); rejoin + re-track on
//   reconnect with a fresh token.
//
// Zero imports from @supabase/supabase-js.

import type {
  ApiError,
  AuthResponse,
  AuthSession,
  AuthUser,
  ChangeBinding,
  ClientMsg,
  OrderSpec,
  QueryFilter,
  QueryRequest,
  QueryResponse,
  RpcResponse,
  ServerMsg,
} from '../../../worker/src/protocol';

// Re-exported so app code can swap `import type { Session } from '@supabase/supabase-js'`
// for `import type { Session } from '@/integrations/backend/cfClient'`.
export type Session = AuthSession;
export type { AuthSession, AuthUser };

export const API_URL = (import.meta.env.VITE_API_URL as string) || '';

const AUTH_STORAGE_KEY = 'livo-auth';

// ─── Small helpers ────────────────────────────────────────────────────────

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'Network error';

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Session store (localStorage + in-memory mirror) ─────────────────────

let memSession: AuthSession | null = null;
let sessionLoaded = false;

/** Sync access to the persisted session — used by keepalive beacon call sites. */
export function getStoredSession(): AuthSession | null {
  if (!sessionLoaded) {
    sessionLoaded = true;
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (raw) memSession = JSON.parse(raw) as AuthSession;
    } catch {
      memSession = null;
    }
  }
  return memSession;
}

function saveSession(session: AuthSession): void {
  memSession = session;
  sessionLoaded = true;
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // localStorage unavailable (private mode) — in-memory session still works
  }
}

function clearSession(): void {
  memSession = null;
  sessionLoaded = true;
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ─── Auth events ──────────────────────────────────────────────────────────

type AuthListener = (event: string, session: AuthSession | null) => void;
const authListeners: AuthListener[] = [];

function emitAuth(event: string, session: AuthSession | null): void {
  for (const fn of [...authListeners]) {
    try {
      fn(event, session);
    } catch (e) {
      console.error('[cfClient] auth listener error:', errMsg(e));
    }
  }
}

// ─── Token refresh ────────────────────────────────────────────────────────

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight: Promise<AuthSession | null> | null = null;

function scheduleAutoRefresh(session: AuthSession): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  if (!session.refresh_token) return;
  const delayMs = session.expires_at * 1000 - Date.now() - 60_000;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSession();
  }, Math.max(0, delayMs));
}

/**
 * Rotate the refresh token. Returns the new session, or null when the session
 * is gone (server rejected the refresh token → signed out locally).
 * A network failure keeps the current session and retries in 10 s.
 */
function refreshSession(): Promise<AuthSession | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async (): Promise<AuthSession | null> => {
    const current = getStoredSession();
    if (!current || !current.refresh_token) return null;
    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: current.refresh_token }),
      });
    } catch {
      // Network hiccup — keep the session, retry shortly.
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshSession();
      }, 10_000);
      return current;
    }
    let body: AuthResponse | null = null;
    try {
      body = (await res.json()) as AuthResponse;
    } catch {
      body = null;
    }
    if (res.ok && body && body.session) {
      saveSession(body.session);
      scheduleAutoRefresh(body.session);
      emitAuth('TOKEN_REFRESHED', body.session);
      return body.session;
    }
    // Refresh token rejected — the session is dead.
    clearSession();
    realtime.shutdown();
    emitAuth('SIGNED_OUT', null);
    return null;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Session with a still-valid access token (refreshes first when expired). */
async function ensureFreshSession(): Promise<AuthSession | null> {
  const s = getStoredSession();
  if (!s) return null;
  if (s.expires_at * 1000 - Date.now() < 30_000) {
    if (s.refresh_token) return refreshSession();
    clearSession();
    return null;
  }
  return s;
}

async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(extra || {}) };
  const s = await ensureFreshSession();
  if (s) headers.Authorization = `Bearer ${s.access_token}`;
  return headers;
}

// ─── Generic JSON POST (never throws) ─────────────────────────────────────

interface JsonResult {
  ok: boolean;
  status: number;
  body: unknown;
}

async function postJson(path: string, payload: unknown): Promise<JsonResult> {
  const headers = await authHeaders({ 'Content-Type': 'application/json' });
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

function extractError(r: JsonResult, fallback: string): ApiError {
  const b = r.body as { error?: unknown; message?: unknown } | null;
  if (b && typeof b === 'object') {
    const e = b.error;
    if (e && typeof e === 'object' && typeof (e as ApiError).message === 'string') {
      return e as ApiError;
    }
    if (typeof e === 'string') {
      // Worker error bodies are either {error: '<human message>'} or
      // {error: '<code>', message: '<human message>'} — prefer the human
      // message and keep the machine code for call sites that branch on it.
      if (typeof b.message === 'string' && b.message) return { message: b.message, code: e };
      return { message: e };
    }
    if (typeof b.message === 'string') return { message: b.message };
  }
  return { message: `${fallback} (HTTP ${r.status})` };
}

// ─── Query builder ────────────────────────────────────────────────────────

interface QueryResult {
  data: unknown;
  error: ApiError | null;
  count?: number | null;
}

interface SelectOpts {
  count?: 'exact';
  head?: boolean;
}

class CfQueryBuilder implements PromiseLike<QueryResult> {
  private req: QueryRequest;
  private promise: Promise<QueryResult> | null = null;

  constructor(table: string, init: Partial<QueryRequest> & { op: QueryRequest['op'] }) {
    this.req = { table, ...init };
  }

  // — projection / returning marker —
  select(cols?: string, opts?: SelectOpts): this {
    this.req.cols = cols || '*';
    if (opts && opts.count) this.req.count = opts.count;
    if (opts && opts.head) this.req.head = true;
    return this;
  }

  // — filters —
  private push(col: string, op: QueryFilter['op'], val: unknown): this {
    if (!this.req.filters) this.req.filters = [];
    this.req.filters.push({ col, op, val });
    return this;
  }

  eq(col: string, val: unknown): this { return this.push(col, 'eq', val); }
  neq(col: string, val: unknown): this { return this.push(col, 'neq', val); }
  gt(col: string, val: unknown): this { return this.push(col, 'gt', val); }
  gte(col: string, val: unknown): this { return this.push(col, 'gte', val); }
  lt(col: string, val: unknown): this { return this.push(col, 'lt', val); }
  lte(col: string, val: unknown): this { return this.push(col, 'lte', val); }
  like(col: string, val: string): this { return this.push(col, 'like', val); }
  ilike(col: string, val: string): this { return this.push(col, 'ilike', val); }
  is(col: string, val: unknown): this { return this.push(col, 'is', val); }
  in(col: string, vals: unknown[]): this { return this.push(col, 'in', vals); }

  not(col: string, op: string, val: unknown): this {
    // only `not('col', 'is', null)` exists app-wide; eq/in kept for headroom
    const mapped = (op === 'is' ? 'not.is' : op === 'in' ? 'not.in' : 'not.eq') as QueryFilter['op'];
    return this.push(col, mapped, val);
  }

  /** Raw PostgREST or-expression, e.g. 'project_id.eq.X,project_id.is.null'. */
  or(expr: string): this { return this.push('or', 'or', expr); }

  // — modifiers —
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean; foreignTable?: string }): this {
    if (!this.req.order) this.req.order = [];
    const spec: OrderSpec = { col, ascending: !opts || opts.ascending !== false };
    if (opts && opts.nullsFirst !== undefined) spec.nullsFirst = opts.nullsFirst;
    if (opts && opts.foreignTable !== undefined) spec.foreignTable = opts.foreignTable;
    this.req.order.push(spec);
    return this;
  }

  limit(n: number): this { this.req.limit = n; return this; }

  /** .range(from, to) → offset=from, limit=to-from+1 (unused today, cheap parity). */
  range(from: number, to: number): this {
    this.req.offset = from;
    this.req.limit = to - from + 1;
    return this;
  }

  single(): this { this.req.single = true; return this; }
  maybeSingle(): this { this.req.maybeSingle = true; return this; }

  // — execution (lazy; never rejects) —
  private exec(): Promise<QueryResult> {
    if (!this.promise) this.promise = this.run();
    return this.promise;
  }

  private async run(): Promise<QueryResult> {
    try {
      const r = await postJson('/api/query', this.req);
      const body = r.body as QueryResponse | null;
      if (body && typeof body === 'object' && ('data' in body || 'error' in body)) {
        return {
          data: body.data !== undefined ? body.data : null,
          error: body.error || null,
          count: body.count !== undefined ? body.count : null,
        };
      }
      return { data: null, error: extractError(r, 'Query failed'), count: null };
    } catch (e) {
      return { data: null, error: { message: errMsg(e) }, count: null };
    }
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<QueryResult | TResult> {
    return this.exec().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<QueryResult> {
    return this.exec().finally(onfinally);
  }
}

type Row = Record<string, unknown>;

function from(table: string) {
  return {
    select: (cols?: string, opts?: SelectOpts) =>
      new CfQueryBuilder(table, { op: 'select' }).select(cols, opts),
    insert: (values: Row | Row[]) =>
      new CfQueryBuilder(table, { op: 'insert', values: Array.isArray(values) ? values : [values] }),
    upsert: (values: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) =>
      new CfQueryBuilder(table, {
        op: 'upsert',
        values: Array.isArray(values) ? values : [values],
        ...(opts && opts.onConflict !== undefined ? { onConflict: opts.onConflict } : {}),
        ...(opts && opts.ignoreDuplicates !== undefined ? { ignoreDuplicates: opts.ignoreDuplicates } : {}),
      }),
    update: (values: Row) => new CfQueryBuilder(table, { op: 'update', values }),
    delete: () => new CfQueryBuilder(table, { op: 'delete' }),
  };
}

// ─── rpc ──────────────────────────────────────────────────────────────────

async function rpc(
  fn: string,
  params?: Record<string, unknown>
): Promise<{ data: unknown; error: ApiError | null }> {
  try {
    const r = await postJson(`/api/rpc/${encodeURIComponent(fn)}`, params || {});
    const body = r.body as RpcResponse | null;
    if (body && typeof body === 'object' && ('data' in body || 'error' in body)) {
      return { data: body.data !== undefined ? body.data : null, error: body.error || null };
    }
    if (!r.ok) return { data: null, error: extractError(r, `RPC ${fn} failed`) };
    return { data: body, error: null };
  } catch (e) {
    return { data: null, error: { message: errMsg(e) } };
  }
}

// ─── functions.invoke ─────────────────────────────────────────────────────

const functions = {
  async invoke(
    name: string,
    opts?: { body?: Record<string, unknown> }
  ): Promise<{ data: unknown; error: ApiError | null }> {
    try {
      const r = await postJson(`/api/functions/${name}`, (opts && opts.body) || {});
      if (!r.ok) return { data: null, error: extractError(r, `Function ${name} failed`) };
      return { data: r.body, error: null };
    } catch (e) {
      return { data: null, error: { message: errMsg(e) } };
    }
  },
};

// ─── storage ──────────────────────────────────────────────────────────────

const encodePath = (path: string): string =>
  path.split('/').map(encodeURIComponent).join('/');

function storageFrom(bucket: string) {
  return {
    async upload(
      path: string,
      file: Blob
    ): Promise<{ data: { path: string } | null; error: ApiError | null }> {
      try {
        const contentType = (file as File).type || 'application/octet-stream';
        const headers = await authHeaders({ 'Content-Type': contentType });
        const res = await fetch(`${API_URL}/api/storage/${bucket}/${encodePath(path)}`, {
          method: 'POST',
          headers,
          body: file,
        });
        if (!res.ok) {
          let message = `Upload failed (HTTP ${res.status})`;
          try {
            const b = (await res.json()) as { error?: ApiError };
            if (b && b.error && b.error.message) message = b.error.message;
          } catch {
            // non-JSON error body
          }
          return { data: null, error: { message } };
        }
        // Prefer the SERVER's effective path: cloud-beta workspaces get a
        // `ws/<id>/` prefix injected server-side, and call sites store/build
        // URLs from the returned path.
        let effectivePath = path;
        try {
          const b = (await res.json()) as { data?: { path?: string } };
          if (b && b.data && typeof b.data.path === 'string' && b.data.path) {
            effectivePath = b.data.path;
          }
        } catch {
          // body already consumed or non-JSON — fall back to the sent path
        }
        return { data: { path: effectivePath }, error: null };
      } catch (e) {
        return { data: null, error: { message: errMsg(e) } };
      }
    },

    /** SYNC, like supabase-js. Public bucket URLs served straight by the Worker. */
    getPublicUrl(path: string): { data: { publicUrl: string } } {
      return { data: { publicUrl: `${API_URL}/api/storage/${bucket}/${path}` } };
    },

    async remove(paths: string[]): Promise<{ data: unknown; error: ApiError | null }> {
      try {
        const r = await postJson(`/api/storage/${bucket}/remove`, { paths });
        if (!r.ok) return { data: null, error: extractError(r, 'Remove failed') };
        const body = r.body as { data?: unknown; error?: ApiError | null } | null;
        if (body && typeof body === 'object' && ('data' in body || 'error' in body)) {
          return { data: body.data !== undefined ? body.data : paths, error: body.error || null };
        }
        return { data: paths, error: null };
      } catch (e) {
        return { data: null, error: { message: errMsg(e) } };
      }
    },

    async download(path: string): Promise<{ data: Blob | null; error: ApiError | null }> {
      try {
        const headers = await authHeaders();
        const res = await fetch(`${API_URL}/api/storage/${bucket}/${encodePath(path)}`, {
          method: 'GET',
          headers,
        });
        if (!res.ok) return { data: null, error: { message: `Download failed (HTTP ${res.status})` } };
        return { data: await res.blob(), error: null };
      } catch (e) {
        return { data: null, error: { message: errMsg(e) } };
      }
    },

    /** Parity with the mock; no list call sites exist app-wide. */
    async list(_path?: string): Promise<{ data: Row[]; error: ApiError | null }> {
      return { data: [], error: null };
    },
  };
}

// ─── Realtime ─────────────────────────────────────────────────────────────

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000, 10000];
const HEARTBEAT_MS = 15_000;

type PresenceSnapshot = Record<string, Record<string, unknown>[]>;

interface ChannelOpts {
  config?: { presence?: { key?: string } };
}

interface PgChangesFilter {
  event?: string;
  schema?: string;
  table?: string;
  filter?: string;
}

interface ChangePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown>;
  old: Record<string, unknown>;
  table: string;
  schema: string;
}

type ChangeCb = (payload: ChangePayload) => void;
type PresenceCb = () => void;
type StatusCb = (status: string) => void;

export class CfChannel {
  readonly name: string;
  private mgr: RealtimeManager;
  private presenceKey?: string;
  private bindings: Array<{ binding: ChangeBinding; cb: ChangeCb }> = [];
  private presenceHandlers: PresenceCb[] = [];
  private statusCb: StatusCb | null = null;
  private snapshot: PresenceSnapshot = {};
  private lastTrack: Record<string, unknown> | null = null;
  /** Wants to be (re)joined whenever the socket is up. */
  wantSubscribed = false;
  private joined = false;

  constructor(mgr: RealtimeManager, name: string, opts?: ChannelOpts) {
    this.mgr = mgr;
    this.name = name;
    const key = opts && opts.config && opts.config.presence && opts.config.presence.key;
    if (key) this.presenceKey = key;
  }

  on(type: string, cfg: PgChangesFilter | { event?: string }, cb?: (...args: never[]) => void): this {
    if (type === 'postgres_changes' && cb) {
      const f = cfg as PgChangesFilter;
      const binding: ChangeBinding = {
        table: f.table || '',
        event: f.event || '*',
      };
      if (f.filter) binding.filter = f.filter;
      this.bindings.push({ binding, cb: cb as unknown as ChangeCb });
    } else if (type === 'presence' && cb) {
      // only { event: 'sync' } is consumed app-wide
      this.presenceHandlers.push(cb as unknown as PresenceCb);
    }
    return this;
  }

  subscribe(cb?: StatusCb): this {
    this.statusCb = cb || null;
    this.wantSubscribed = true;
    this.mgr.ensureConnected();
    if (this.mgr.isOpen()) this.sendJoin();
    return this;
  }

  /** @internal — join (or rejoin after reconnect). */
  sendJoin(): void {
    this.joined = false;
    const msg: ClientMsg = { t: 'join', ch: this.name, bindings: this.bindings.map((b) => b.binding) };
    if (this.presenceKey) msg.presenceKey = this.presenceKey;
    this.mgr.send(msg);
  }

  /** @internal */
  onJoined(): void {
    this.joined = true;
    const before = this.lastTrack;
    if (this.statusCb) {
      try {
        this.statusCb('SUBSCRIBED');
      } catch (e) {
        console.error('[cfClient] subscribe callback error:', errMsg(e));
      }
    }
    // re-track the remembered payload (queued track / reconnect retrack) only if
    // the SUBSCRIBED callback didn't already track this cycle. track() reassigns
    // lastTrack to a new object reference and sends immediately when joined, so an
    // unchanged reference means the callback did NOT track and we must restore
    // presence on reconnect; a changed reference means it already sent.
    if (this.lastTrack && this.lastTrack === before) {
      this.mgr.send({ t: 'track', ch: this.name, payload: this.lastTrack });
    }
  }

  /** @internal */
  onSocketDown(): void {
    this.joined = false;
  }

  /** @internal */
  onError(message: string): void {
    console.warn(`[cfClient] realtime channel '${this.name}' error:`, message);
    if (this.statusCb) {
      try {
        this.statusCb('CHANNEL_ERROR');
      } catch {
        // ignore
      }
    }
  }

  presenceState(): PresenceSnapshot {
    return this.snapshot;
  }

  async track(payload: Record<string, unknown>): Promise<string> {
    this.lastTrack = payload; // full-state replacement; queued until joined
    if (this.joined) this.mgr.send({ t: 'track', ch: this.name, payload });
    return 'ok';
  }

  async untrack(): Promise<string> {
    this.lastTrack = null;
    if (this.joined) this.mgr.send({ t: 'untrack', ch: this.name });
    return 'ok';
  }

  unsubscribe(): void {
    this.wantSubscribed = false;
    this.lastTrack = null;
    if (this.joined) this.mgr.send({ t: 'leave', ch: this.name });
    this.joined = false;
  }

  /** @internal */
  handleChange(msg: Extract<ServerMsg, { t: 'change' }>): void {
    const payload: ChangePayload = {
      eventType: msg.eventType,
      new: msg.new || {},
      old: msg.old || {},
      table: msg.table,
      schema: 'public',
    };
    for (const { binding, cb } of this.bindings) {
      if (binding.table !== msg.table) continue;
      if (binding.event !== '*' && binding.event !== msg.eventType) continue;
      if (!bindingFilterMatches(binding.filter, msg)) continue;
      try {
        cb(payload);
      } catch (e) {
        console.error('[cfClient] change handler error:', errMsg(e));
      }
    }
  }

  /** @internal */
  handlePresence(state: PresenceSnapshot): void {
    this.snapshot = state;
    for (const h of this.presenceHandlers) {
      try {
        h();
      } catch (e) {
        console.error('[cfClient] presence handler error:', errMsg(e));
      }
    }
  }
}

/** Only 'col=eq.value' is supported (matches app usage: task_id=eq.<id>). */
function bindingFilterMatches(
  filter: string | undefined,
  msg: { new: Record<string, unknown> | null; old: Record<string, unknown> | null }
): boolean {
  if (!filter) return true;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=eq\.(.*)$/.exec(filter);
  if (!m) return true; // unknown grammar — deliver rather than drop
  const col = m[1];
  const want = m[2];
  const fromNew = msg.new ? msg.new[col] : undefined;
  const fromOld = msg.old ? msg.old[col] : undefined;
  const got = fromNew !== undefined && fromNew !== null ? fromNew : fromOld;
  return got !== undefined && got !== null && String(got) === want;
}

class RealtimeManager {
  private ws: WebSocket | null = null;
  private channels = new Map<string, CfChannel>();
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private hbPending = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private connecting = false;
  private closedByUser = false;

  channel(name: string, opts?: ChannelOpts): CfChannel {
    let ch = this.channels.get(name);
    if (!ch) {
      ch = new CfChannel(this, name, opts);
      this.channels.set(name, ch);
    }
    return ch;
  }

  removeChannel(ch: CfChannel): void {
    ch.unsubscribe();
    const existing = this.channels.get(ch.name);
    if (existing === ch) this.channels.delete(ch.name);
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMsg): void {
    if (this.isOpen()) {
      try {
        this.ws!.send(JSON.stringify(msg));
      } catch (e) {
        console.warn('[cfClient] ws send failed:', errMsg(e));
      }
    }
  }

  ensureConnected(): void {
    this.closedByUser = false;
    if (this.ws || this.connecting || this.reconnectTimer !== null) return;
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.ws || this.connecting) return;
    this.connecting = true;
    try {
      // Always (re)connect with the CURRENT access token.
      const session = await ensureFreshSession();
      if (this.closedByUser) return;
      const token = session ? session.access_token : '';
      const wsBase = API_URL.replace(/^http/, 'ws');
      const ws = new WebSocket(`${wsBase}/api/realtime?token=${encodeURIComponent(token)}`);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.attempts = 0;
        this.startHeartbeat();
        // rejoin every subscribed channel (each re-tracks in onJoined)
        for (const ch of this.channels.values()) {
          if (ch.wantSubscribed) ch.sendJoin();
        }
      };

      ws.onmessage = (ev: MessageEvent) => {
        if (this.ws !== ws) return;
        let msg: ServerMsg;
        try {
          msg = JSON.parse(String(ev.data)) as ServerMsg;
        } catch {
          return;
        }
        this.dispatch(msg);
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.teardownSocket();
        this.scheduleReconnect();
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
        try {
          ws.close();
        } catch {
          // ignore
        }
      };
    } catch (e) {
      console.warn('[cfClient] realtime connect failed:', errMsg(e));
      this.teardownSocket();
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private dispatch(msg: ServerMsg): void {
    switch (msg.t) {
      case 'joined':
        this.channels.get(msg.ch)?.onJoined();
        break;
      case 'change':
        this.channels.get(msg.ch)?.handleChange(msg);
        break;
      case 'presence':
        this.channels.get(msg.ch)?.handlePresence(msg.state);
        break;
      case 'hb_ack':
        this.hbPending = false;
        break;
      case 'error':
        if (msg.ch) this.channels.get(msg.ch)?.onError(msg.message);
        else console.warn('[cfClient] realtime error:', msg.message);
        break;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // reset on (re)start so a stale flag can't trigger a false drop right after reconnect
    this.hbPending = false;
    this.hbTimer = setInterval(() => {
      if (this.hbPending) {
        // previous hb_ack never arrived → half-open socket. Tear down and reconnect.
        // The `if (this.ws !== ws) return` guards in onclose/onmessage prevent
        // double-processing once ws.close() fires.
        const ws = this.ws;
        this.teardownSocket();
        this.scheduleReconnect();
        if (ws) {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
        return;
      }
      this.hbPending = true;
      this.send({ t: 'hb' });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.hbTimer !== null) {
      clearInterval(this.hbTimer);
      this.hbTimer = null;
    }
  }

  private teardownSocket(): void {
    this.stopHeartbeat();
    this.hbPending = false;
    this.ws = null;
    for (const ch of this.channels.values()) ch.onSocketDown();
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return;
    let any = false;
    for (const ch of this.channels.values()) {
      if (ch.wantSubscribed) {
        any = true;
        break;
      }
    }
    if (!any) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.attempts, RECONNECT_BACKOFF_MS.length - 1)];
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** Close intentionally (sign-out). No reconnect until next subscribe. */
  shutdown(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.teardownSocket();
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.attempts = 0;
  }
}

const realtime = new RealtimeManager();

// Type shim for app code that imported RealtimeChannel from supabase-js.
export type RealtimeChannel = CfChannel;

// ─── auth API ─────────────────────────────────────────────────────────────

const auth = {
  async signInWithPassword(creds: { email: string; password: string }): Promise<{
    data: { user: AuthUser | null; session: AuthSession | null };
    error: ApiError | null;
  }> {
    try {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(creds),
      });
      let body: AuthResponse | null = null;
      try {
        body = (await res.json()) as AuthResponse;
      } catch {
        body = null;
      }
      if (!res.ok || !body || body.error || !body.session) {
        const error: ApiError =
          body && body.error ? body.error : { message: `Login failed (HTTP ${res.status})` };
        return { data: { user: null, session: null }, error };
      }
      const session = body.session;
      saveSession(session);
      scheduleAutoRefresh(session);
      // async, like the mock (and supabase-js)
      setTimeout(() => emitAuth('SIGNED_IN', session), 0);
      return { data: { user: session.user, session }, error: null };
    } catch (e) {
      return { data: { user: null, session: null }, error: { message: errMsg(e) } };
    }
  },

  /**
   * POST /api/auth/change-password — self-service password change.
   * On success the server revokes EVERY refresh token for the user and
   * returns a brand-new session for this device, so the stored session MUST
   * be replaced (otherwise the next auto-refresh would sign the user out).
   * Error `message` is the backend's zh human message; `code` is the machine
   * code (current_password_required | password_too_short |
   * invalid_current_password | demo_blocked | over_request_rate_limit |
   * auth_unavailable).
   */
  async changePassword(
    currentPassword: string,
    newPassword: string
  ): Promise<{ error: ApiError | null }> {
    try {
      const current = await ensureFreshSession();
      if (!current) return { error: { message: 'Not signed in' } };
      const res = await fetch(`${API_URL}/api/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${current.access_token}`,
        },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      let body: { error?: string | null; message?: string; session?: AuthSession } | null = null;
      try {
        body = (await res.json()) as { error?: string | null; message?: string; session?: AuthSession };
      } catch {
        body = null;
      }
      if (!res.ok || !body || body.error || !body.session) {
        const message =
          body && typeof body.message === 'string' && body.message
            ? body.message
            : `Change password failed (HTTP ${res.status})`;
        const code = body && typeof body.error === 'string' ? body.error : undefined;
        return { error: code ? { message, code } : { message } };
      }
      // All previous refresh tokens are dead — persist the fresh session.
      saveSession(body.session);
      scheduleAutoRefresh(body.session);
      emitAuth('TOKEN_REFRESHED', body.session);
      return { error: null };
    } catch (e) {
      return { error: { message: errMsg(e) } };
    }
  },

  async getSession(): Promise<{ data: { session: AuthSession | null }; error: null }> {
    let s = getStoredSession();
    if (s && s.expires_at * 1000 <= Date.now()) {
      if (s.refresh_token) {
        s = await refreshSession();
      } else {
        clearSession();
        s = null;
      }
    }
    if (s) scheduleAutoRefresh(s);
    return { data: { session: s }, error: null };
  },

  async getUser(): Promise<{ data: { user: AuthUser | null }; error: null }> {
    const s = getStoredSession();
    return { data: { user: s ? s.user : null }, error: null };
  },

  async signOut(): Promise<{ error: null }> {
    const s = getStoredSession();
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (s) {
      // best-effort server-side refresh-token revocation
      fetch(`${API_URL}/api/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${s.access_token}`,
        },
        body: JSON.stringify({ refresh_token: s.refresh_token }),
      }).catch(() => {
        // ignore — local sign-out proceeds regardless
      });
    }
    clearSession();
    realtime.shutdown();
    emitAuth('SIGNED_OUT', null); // sync, like the mock
    return { error: null };
  },

  onAuthStateChange(cb: AuthListener): {
    data: { subscription: { unsubscribe: () => void } };
  } {
    authListeners.push(cb);
    return {
      data: {
        subscription: {
          unsubscribe() {
            const i = authListeners.indexOf(cb);
            if (i > -1) authListeners.splice(i, 1);
          },
        },
      },
    };
  },

  async setSession(tokens: { access_token: string; refresh_token?: string }): Promise<{
    data: { session: AuthSession | null };
    error: ApiError | null;
  }> {
    const claims = decodeJwtPayload(tokens.access_token);
    const session: AuthSession = {
      user: {
        id: claims && typeof claims.sub === 'string' ? claims.sub : '',
        email: claims && typeof claims.email === 'string' ? claims.email : '',
      },
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || '',
      expires_at:
        claims && typeof claims.exp === 'number'
          ? claims.exp
          : Math.floor(Date.now() / 1000) + 3600,
    };
    saveSession(session);
    scheduleAutoRefresh(session);
    return { data: { session }, error: null };
  },

  async signInWithOAuth(): Promise<{ error: ApiError }> {
    return { error: { message: 'OAuth not available' } };
  },

  /**
   * POST /api/auth/signup — cloud-beta workspace creation via an invite
   * token (from the cloud-waitlist approval email). On success the returned
   * session is persisted and SIGNED_IN fires, exactly like signInWithPassword.
   * Failure error carries the worker's zh message + machine `code`
   * (invalid_invite | password_too_short | workspace_name_required |
   * already_member | signup_failed).
   */
  async signUpWithInvite(params: {
    invite: string;
    password: string;
    workspaceName: string;
    displayName: string;
  }): Promise<{ data: { user: AuthUser | null; session: AuthSession | null }; error: ApiError | null }> {
    try {
      const res = await fetch(`${API_URL}/api/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invite: params.invite,
          password: params.password,
          workspace_name: params.workspaceName,
          display_name: params.displayName,
        }),
      });
      let body: AuthResponse | null = null;
      try {
        body = (await res.json()) as AuthResponse;
      } catch {
        body = null;
      }
      if (!res.ok || !body || body.error || !body.session) {
        // Failure bodies are worker-shaped: {error: '<code>', message: '<zh>'}.
        const eb = body as unknown as { error?: unknown; message?: unknown } | null;
        const message =
          eb && typeof eb.message === 'string' && eb.message
            ? eb.message
            : `Signup failed (HTTP ${res.status})`;
        const code = eb && typeof eb.error === 'string' ? eb.error : undefined;
        return { data: { user: null, session: null }, error: code ? { message, code } : { message } };
      }
      const session = body.session;
      saveSession(session);
      scheduleAutoRefresh(session);
      setTimeout(() => emitAuth('SIGNED_IN', session), 0);
      return { data: { user: session.user, session }, error: null };
    } catch (e) {
      return { data: { user: null, session: null }, error: { message: errMsg(e) } };
    }
  },

  /**
   * POST /api/auth/set-password/verify — checks a set-password invitation
   * link (?token=, minted by the Jira import / 「啟用帳號」) and returns the
   * email it sets the password for. Error code: invalid_token.
   */
  async verifySetPasswordToken(token: string): Promise<{ email: string | null; error: ApiError | null }> {
    try {
      const res = await fetch(`${API_URL}/api/auth/set-password/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json().catch((): null => null)) as { email?: unknown; error?: unknown; message?: unknown } | null;
      if (!res.ok || !body || typeof body.email !== 'string') {
        const code = body && typeof body.error === 'string' ? body.error : 'invalid_token';
        const message = body && typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
        return { email: null, error: { message, code } };
      }
      return { email: body.email, error: null };
    } catch (e) {
      return { email: null, error: { message: errMsg(e) } };
    }
  },

  /**
   * POST /api/auth/set-password — sets the password from an invitation link.
   * The server revokes the user's other sessions and returns a new one, which
   * is persisted (SIGNED_IN fires, like signInWithPassword). Error codes:
   * invalid_token | password_too_short.
   */
  async setPasswordWithToken(
    token: string,
    password: string
  ): Promise<{ data: { user: AuthUser | null; session: AuthSession | null }; error: ApiError | null }> {
    try {
      const res = await fetch(`${API_URL}/api/auth/set-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const body = (await res.json().catch((): null => null)) as AuthResponse | null;
      if (!res.ok || !body || body.error || !body.session) {
        const eb = body as unknown as { error?: unknown; message?: unknown } | null;
        const message = eb && typeof eb.message === 'string' && eb.message ? eb.message : `HTTP ${res.status}`;
        const code = eb && typeof eb.error === 'string' ? eb.error : undefined;
        return { data: { user: null, session: null }, error: code ? { message, code } : { message } };
      }
      const session = body.session;
      saveSession(session);
      scheduleAutoRefresh(session);
      setTimeout(() => emitAuth('SIGNED_IN', session), 0);
      return { data: { user: session.user, session }, error: null };
    } catch (e) {
      return { data: { user: null, session: null }, error: { message: errMsg(e) } };
    }
  },
};

// ─── client factory ───────────────────────────────────────────────────────

export function createCfClient(): unknown {
  return {
    from,
    rpc,
    functions,
    storage: { from: storageFrom },
    auth,
    channel: (name: string, opts?: ChannelOpts) => realtime.channel(name, opts),
    removeChannel: (ch: CfChannel) => realtime.removeChannel(ch),
  };
}
