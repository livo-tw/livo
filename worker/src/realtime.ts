// RealtimeHub Durable Object — replaces Supabase Realtime (postgres_changes +
// presence) for the LIVO app. Single instance (idFromName('hub')), standard
// non-hibernating WebSockets, all state in memory.
//
// Contract (DESIGN.md "realtime.ts" + reports/realtime.md):
//   - /ws        GET upgrade. memberId comes from the `x-auth-user` header set by
//                index.ts after JWT verification (the DO never sees raw tokens).
//   - /notify    POST ChangeEvent[] from db.ts/rpc.ts after committed writes.
//   - postgres_changes parity: senders RECEIVE their own events (the app dedupes
//     by id / uses a 3 s echo guard in useTaskSpecs — do not suppress echoes).
//   - presence parity: key = member id; track() replaces THIS socket's payload
//     wholesale; consumers only use full `sync` snapshots, so every mutation
//     broadcasts the complete snapshot (Record<key, payload[]>, multiple sockets
//     under one key concatenated).
//   - DELETE events carry the full old row (db.ts sends it) — handlers need at
//     least old.id, and old.task_id for comments.
//   - Liveness: client heartbeats every 15 s; a lazy 10 s sweep closes sockets
//     silent for >30 s; the interval is cleared when no sockets remain.

import type { ChangeBinding, ChangeEvent, ClientMsg, ServerMsg } from './protocol';
import type { Env } from './env';
import { realtimeEventForMember, realtimeIdentity, realtimeIdentityActive, type RealtimeIdentity } from './realtimeAccess';

const SWEEP_INTERVAL_MS = 10_000;
const STALE_AFTER_MS = 30_000;

interface ChannelSub {
  bindings: ChangeBinding[];
  presenceKey?: string;
}

interface SocketState extends RealtimeIdentity {
  lastSeen: number;
  channels: Map<string, ChannelSub>;
  messageTail?: Promise<void>;
}

interface PresenceEntry {
  key: string;
  payload: Record<string, unknown>;
}

/** Parse the only supported filter grammar: `col=eq.value`. */
function parseFilter(filter: string): { col: string; val: string } | null {
  const i = filter.indexOf('=eq.');
  if (i <= 0) return null;
  const col = filter.slice(0, i);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) return null;
  return { col, val: filter.slice(i + 4) };
}

function bindingMatches(b: ChangeBinding, ev: ChangeEvent): boolean {
  if (b.table !== ev.table) return false;
  if (b.event !== '*' && b.event !== ev.eventType) return false;
  if (b.filter) {
    const f = parseFilter(b.filter);
    if (!f) return false; // unparseable filter never matches (fail closed)
    const row = ev.new ?? ev.old;
    if (!row) return false;
    return String(row[f.col]) === f.val;
  }
  return true;
}

function isValidBinding(b: unknown): b is ChangeBinding {
  if (b === null || typeof b !== 'object') return false;
  const x = b as Record<string, unknown>;
  return (
    typeof x.table === 'string' &&
    typeof x.event === 'string' &&
    (x.filter === undefined || typeof x.filter === 'string')
  );
}

function isChangeEvent(v: unknown): v is ChangeEvent {
  if (v === null || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.table === 'string' &&
    (e.eventType === 'INSERT' || e.eventType === 'UPDATE' || e.eventType === 'DELETE')
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export class RealtimeHub {
  private sockets = new Map<WebSocket, SocketState>();
  /** Per channel: this socket's single presence entry (track() replaces it). */
  private presence = new Map<string, Map<WebSocket, PresenceEntry>>();
  private pendingPresence = new Set<string>();
  private presenceFlush: Promise<void> | null = null;
  private sweeper: number | undefined;

  constructor(_state: DurableObjectState, private readonly env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/ws') return this.handleWs(req);
    if (url.pathname === '/notify' && req.method === 'POST') return this.handleNotify(req);
    return new Response(JSON.stringify({ error: { message: 'Not found' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── WebSocket lifecycle ─────────────────────────────────────────────────

  private async handleWs(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const identity = realtimeIdentity(req.headers);
    if (!identity || !await realtimeIdentityActive(this.env, identity).catch(() => false)) {
      return new Response('Unauthorized', { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    this.sockets.set(server, { ...identity, lastSeen: Date.now(), channels: new Map() });
    server.addEventListener('message', (ev) => { void this.onMessage(server, ev); });
    server.addEventListener('close', () => this.dropSocket(server, false));
    server.addEventListener('error', () => this.dropSocket(server));
    this.ensureSweeper();

    return new Response(null, { status: 101, webSocket: client });
  }

  private onMessage(ws: WebSocket, ev: MessageEvent): Promise<void> {
    const st = this.sockets.get(ws);
    if (!st) return Promise.resolve();
    // Live identity reads are asynchronous; keep the socket's original wire
    // order while allowing every other connection to progress independently.
    const next = (st.messageTail ?? Promise.resolve()).then(async () => {
      if (this.sockets.get(ws) !== st) return;
      await this.processMessage(ws, ev);
    }).catch(() => { this.dropSocket(ws); });
    st.messageTail = next;
    return next;
  }

  private async processMessage(ws: WebSocket, ev: MessageEvent): Promise<void> {
    const st = this.sockets.get(ws);
    if (!st) return;
    if (!await this.authorizeSocket(ws, st)) return;
    st.lastSeen = Date.now();

    if (typeof ev.data !== 'string') {
      this.send(ws, { t: 'error', message: 'Binary messages are not supported' });
      return;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      this.send(ws, { t: 'error', message: 'Malformed JSON' });
      return;
    }
    if (!isPlainObject(msg) || typeof msg.t !== 'string') {
      this.send(ws, { t: 'error', message: 'Invalid message shape' });
      return;
    }

    try {
      this.handleClientMsg(ws, st, msg as ClientMsg);
    } catch {
      // Never let a handler bug kill the socket loop.
      this.send(ws, { t: 'error', message: 'Internal error handling message' });
    }
  }

  /** Heartbeats and subscriptions cannot keep revoked or expired credentials alive. */
  private async authorizeSocket(ws: WebSocket, st: SocketState): Promise<boolean> {
    const active = await realtimeIdentityActive(this.env, st).catch(() => false);
    if (!active) this.dropSocket(ws);
    return active && this.sockets.get(ws) === st;
  }

  private handleClientMsg(ws: WebSocket, st: SocketState, msg: ClientMsg): void {
    switch (msg.t) {
      case 'join': {
        if (typeof msg.ch !== 'string' || msg.ch === '') {
          this.send(ws, { t: 'error', message: 'join requires ch' });
          return;
        }
        const bindings = Array.isArray(msg.bindings) ? msg.bindings.filter(isValidBinding) : [];
        const presenceKey =
          typeof msg.presenceKey === 'string' && msg.presenceKey !== '' ? msg.presenceKey : undefined;
        st.channels.set(msg.ch, { bindings, presenceKey });
        this.send(ws, { t: 'joined', ch: msg.ch });
        if (presenceKey) {
          // Joiner (and everyone else in ch) gets the current snapshot so the
          // 'sync'-only consumers render existing viewers immediately.
          this.queuePresenceBroadcast(msg.ch);
        } else {
          // Re-join without presence config: drop any stale presence entry.
          const pm = this.presence.get(msg.ch);
          if (pm && pm.delete(ws)) {
            if (pm.size === 0) this.presence.delete(msg.ch);
            this.queuePresenceBroadcast(msg.ch);
          }
        }
        return;
      }

      case 'leave': {
        if (typeof msg.ch !== 'string') return;
        st.channels.delete(msg.ch);
        const pm = this.presence.get(msg.ch);
        if (pm && pm.delete(ws)) {
          if (pm.size === 0) this.presence.delete(msg.ch);
          this.broadcastPresence(msg.ch);
        }
        return;
      }

      case 'track': {
        if (typeof msg.ch !== 'string') {
          this.send(ws, { t: 'error', message: 'track requires ch' });
          return;
        }
        const sub = st.channels.get(msg.ch);
        if (!sub) {
          this.send(ws, { t: 'error', ch: msg.ch, message: 'track before join' });
          return;
        }
        const payload = isPlainObject(msg.payload) ? msg.payload : {};
        const key = sub.presenceKey || st.memberId;
        let pm = this.presence.get(msg.ch);
        if (!pm) {
          pm = new Map();
          this.presence.set(msg.ch, pm);
        }
        // Full-state replacement for THIS socket (supabase track() parity).
        pm.set(ws, { key, payload });
        this.queuePresenceBroadcast(msg.ch);
        return;
      }

      case 'untrack': {
        if (typeof msg.ch !== 'string') return;
        const pm = this.presence.get(msg.ch);
        if (pm && pm.delete(ws)) {
          if (pm.size === 0) this.presence.delete(msg.ch);
          this.queuePresenceBroadcast(msg.ch);
        }
        return;
      }

      case 'hb': {
        this.send(ws, { t: 'hb_ack' });
        return;
      }

      default: {
        this.send(ws, {
          t: 'error',
          message: `Unknown message type: ${String((msg as { t?: unknown }).t)}`,
        });
      }
    }
  }

  /** Remove a socket from all bookkeeping; broadcast presence for affected channels. */
  private dropSocket(ws: WebSocket, close = true): void {
    const st = this.sockets.get(ws);
    if (!st) return;
    this.sockets.delete(ws);

    const affected: string[] = [];
    for (const [ch, pm] of [...this.presence]) {
      if (pm.delete(ws)) {
        if (pm.size === 0) this.presence.delete(ch);
        affected.push(ch);
      }
    }
    if (close) {
      try {
        ws.close(1000, 'connection closed');
      } catch {
        /* already closed */
      }
    }
    // Broadcast AFTER removal so remaining viewers see the departure (implicit
    // untrack on disconnect — supabase presence-leave parity).
    for (const ch of affected) this.queuePresenceBroadcast(ch);
    if (this.sockets.size === 0) this.clearSweeper();
  }

  // ── Sends ───────────────────────────────────────────────────────────────

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Send failed → socket is dead; clean it up (may cascade broadcasts).
      this.dropSocket(ws);
    }
  }

  // ── Presence ────────────────────────────────────────────────────────────

  /** Record<key, payload[]> — multiple sockets under the same key concatenate. */
  private presenceSnapshot(ch: string): Record<string, Record<string, unknown>[]> {
    const out: Record<string, Record<string, unknown>[]> = {};
    const pm = this.presence.get(ch);
    if (pm) {
      for (const entry of pm.values()) {
        (out[entry.key] ||= []).push(entry.payload);
      }
    }
    return out;
  }

  /** Dropping several revoked sockets coalesces into one flush, never recursive fan-out. */
  private queuePresenceBroadcast(ch: string): void {
    this.pendingPresence.add(ch);
    if (this.presenceFlush) return;
    this.presenceFlush = this.flushPresenceBroadcasts().finally(() => {
      this.presenceFlush = null;
      const next = this.pendingPresence.values().next().value as string | undefined;
      if (next !== undefined) this.queuePresenceBroadcast(next);
    });
  }

  private async flushPresenceBroadcasts(): Promise<void> {
    while (this.pendingPresence.size) {
      const channels = [...this.pendingPresence];
      this.pendingPresence.clear();
      for (const ch of channels) await this.broadcastPresence(ch);
    }
  }

  /** Push the current snapshot only to still-authorized sockets joined to `ch`. */
  private async broadcastPresence(ch: string): Promise<void> {
    const recipients: Array<[WebSocket, SocketState]> = [];
    for (const [ws, st] of [...this.sockets]) {
      if (st.channels.has(ch) && await this.authorizeSocket(ws, st)) recipients.push([ws, st]);
    }
    const msg: ServerMsg = { t: 'presence', ch, state: this.presenceSnapshot(ch) };
    for (const [ws, st] of recipients) {
      if (this.sockets.get(ws) === st) this.send(ws, msg);
    }
  }

  // ── Change fan-out (/notify) ────────────────────────────────────────────

  private async handleNotify(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: { message: 'Invalid JSON' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!Array.isArray(body)) {
      return new Response(JSON.stringify({ error: { message: 'Expected ChangeEvent[]' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const workspaceId = req.headers.get('x-workspace-id');
    if (!workspaceId) return new Response('Workspace required', { status: 400 });
    for (const [ws, st] of [...this.sockets]) {
      if (st.workspaceId !== workspaceId || !await this.authorizeSocket(ws, st)) continue;
      for (const raw of body) {
        if (!isChangeEvent(raw)) continue;
        const ev = realtimeEventForMember(raw, st);
        if (!ev) continue;
        for (const [ch, sub] of [...st.channels]) {
          if (!this.sockets.has(ws)) break; // dropped mid-loop by a failed send
          // One message per matching channel, even if several bindings match.
          if (sub.bindings.some((b) => bindingMatches(b, ev))) {
            this.send(ws, {
              t: 'change',
              ch,
              table: ev.table,
              eventType: ev.eventType,
              new: ev.new,
              old: ev.old,
            });
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Liveness sweep ──────────────────────────────────────────────────────

  private ensureSweeper(): void {
    if (this.sweeper !== undefined) return;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  private clearSweeper(): void {
    if (this.sweeper !== undefined) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [ws, st] of [...this.sockets]) {
      if (now - st.lastSeen > STALE_AFTER_MS || st.expiresAt <= Math.floor(now / 1000)) this.dropSocket(ws);
    }
    if (this.sockets.size === 0) this.clearSweeper();
  }
}
