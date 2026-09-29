// Outbound webhooks — admin-managed HTTP endpoints that receive signed
// task/comment change events. Config lives in the server-only webhook_configs
// table (NOT in tables.ts): the signing secret is generated here, returned
// exactly ONCE on creation, and never leaves the server again.
//
// Exports (see index.ts / db.ts):
//   handleWebhooksGet(c)  — GET  /api/functions/webhooks (admin) — list, secret omitted
//   handleWebhooksPost(c) — POST /api/functions/webhooks (admin; demo-blocked)
//                           {url, events[]}            → create (secret returned once)
//                           {id, action:'toggle'}      → enable/disable
//                           {id, action:'delete'}      → remove
//   dispatchWebhooks(env, eventType, rows) — fire-and-forget dispatch hooked
//                           into db.ts post-mutation (tasks/comments events)

import type { Context } from 'hono';
import type { AppContext, Env } from '../env';
import { DEFAULT_WORKSPACE, isDemoWorkspace } from '../env';

export type WebhookEvent = 'task_created' | 'task_updated' | 'task_deleted' | 'comment_added';

const WEBHOOK_EVENTS: WebhookEvent[] = [
  'task_created',
  'task_updated',
  'task_deleted',
  'comment_added',
];

const DISPATCH_TIMEOUT_MS = 10_000;
const MAX_STATUS_LEN = 200; // last_status stores '200' or a truncated error string

type Row = Record<string, unknown>;

// ─── Small helpers ──────────────────────────────────────────────────────────

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let hex = '';
  for (let i = 0; i < buf.length; i++) hex += buf[i].toString(16).padStart(2, '0');
  return hex;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function parseEvents(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw === 'string' && raw !== '') {
    try {
      const p: unknown = JSON.parse(raw);
      if (Array.isArray(p)) return p.filter((x): x is string => typeof x === 'string');
    } catch {
      /* not JSON */
    }
  }
  return [];
}

// ─── Admin CRUD ─────────────────────────────────────────────────────────────

interface WebhookConfigRow {
  id: string;
  url: string;
  events: string | null;
  secret: string;
  enabled: number;
  created_at: string | null;
  last_status: string | null;
  last_sent_at: string | null;
}

/** GET /api/functions/webhooks — list configs (caller's workspace only).
 *  The secret is NEVER included. */
export async function handleWebhooksGet(c: Context<AppContext>): Promise<Response> {
  try {
    const ws = c.get('auth')?.member?.workspaceId || DEFAULT_WORKSPACE;
    const res = await c.env.DB.prepare(
      `SELECT id, url, events, enabled, created_at, last_status, last_sent_at
       FROM webhook_configs WHERE workspace_id = ? ORDER BY created_at DESC`
    ).bind(ws).all<Omit<WebhookConfigRow, 'secret'>>();
    // snake_case on the wire: WebhooksCard and the self-host edge function
    // both use last_status/last_sent_at — keep the three in lockstep.
    const webhooks = (res.results || []).map((w) => ({
      id: w.id,
      url: w.url,
      events: parseEvents(w.events),
      enabled: !!w.enabled,
      created_at: w.created_at,
      last_status: w.last_status,
      last_sent_at: w.last_sent_at,
    }));
    return c.json({ webhooks });
  } catch (e) {
    console.error('[webhooks] list error:', e);
    return c.json({ webhooks: [] });
  }
}

/**
 * POST /api/functions/webhooks — create / toggle / delete (admin; demo-blocked).
 * Create returns the signing secret exactly ONCE; it is unrecoverable afterwards.
 */
export async function handleWebhooksPost(c: Context<AppContext>): Promise<Response> {
  const env = c.env;
  const auth = c.get('auth');
  const ws = auth?.member?.workspaceId || DEFAULT_WORKSPACE;
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: unknown;
      action?: unknown;
      url?: unknown;
      events?: unknown;
    };
    const action = (body.action ?? '').toString();

    // ── toggle / delete (workspace-bounded — ids from other tenants 404) ──
    if (action === 'toggle' || action === 'delete') {
      const id = (body.id ?? '').toString().trim();
      if (!id) return c.json({ ok: false, error: 'id_required' }, 400);
      const result =
        action === 'delete'
          ? await env.DB.prepare('DELETE FROM webhook_configs WHERE id = ? AND workspace_id = ?')
              .bind(id, ws)
              .run()
          : await env.DB.prepare('UPDATE webhook_configs SET enabled = 1 - enabled WHERE id = ? AND workspace_id = ?')
              .bind(id, ws)
              .run();
      if (!result.meta.changes) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json({ ok: true });
    }

    // ── create ──
    const url = (body.url ?? '').toString().trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return c.json({ ok: false, error: 'invalid_url', message: '請填寫完整的 Webhook URL' }, 400);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return c.json({ ok: false, error: 'invalid_url', message: '僅支援 http(s) URL' }, 400);
    }
    const requested = Array.isArray(body.events)
      ? body.events.filter((x): x is string => typeof x === 'string')
      : [];
    const events = requested.length
      ? WEBHOOK_EVENTS.filter((e) => requested.includes(e))
      : [...WEBHOOK_EVENTS];
    if (!events.length) {
      return c.json(
        { ok: false, error: 'invalid_events', message: `events 需為 ${WEBHOOK_EVENTS.join(' / ')} 之一` },
        400
      );
    }

    const id = crypto.randomUUID();
    const secret = `whsec_${randomHex(16)}`; // 32 hex chars
    await env.DB.prepare(
      `INSERT INTO webhook_configs (workspace_id, id, url, events, secret, enabled, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    )
      .bind(ws, id, url, JSON.stringify(events), secret, auth?.member?.id ?? null, new Date().toISOString())
      .run();

    // The ONLY time the secret is ever returned.
    return c.json({ ok: true, id, url, events, secret });
  } catch (e) {
    console.error('[webhooks] error:', e);
    return c.json({ ok: false, error: 'server_error', message: String(e) }, 500);
  }
}

// ─── Dispatch (db.ts post-mutation hook) ────────────────────────────────────

/**
 * POST {event, timestamp, data} to every enabled config subscribed to
 * `eventType`, signed with X-Livo-Signature (HMAC-SHA256 hex of the raw body,
 * keyed by the config's secret). Best-effort: 10s timeout per endpoint,
 * last_status/last_sent_at updated per attempt, NEVER throws. Skipped
 * entirely on the public demo instance (must not spray external endpoints).
 */
export async function dispatchWebhooks(env: Env, eventType: string, rows: Row[]): Promise<void> {
  try {
    if (!rows.length) return;
    // Tenancy: rows from one mutation share a workspace; only that
    // workspace's endpoints may receive them. The public-demo workspace never
    // sprays external endpoints (old instance-wide demo skip, now scoped).
    const ws = (typeof rows[0]?.workspace_id === 'string' && rows[0].workspace_id) || DEFAULT_WORKSPACE;
    if (isDemoWorkspace(env, ws)) return;

    let configs: WebhookConfigRow[] = [];
    try {
      const res = await env.DB.prepare(
        'SELECT id, url, events, secret, enabled FROM webhook_configs WHERE enabled = 1 AND workspace_id = ?'
      ).bind(ws).all<WebhookConfigRow>();
      configs = (res.results || []).filter((cfg) => parseEvents(cfg.events).includes(eventType));
    } catch {
      return; // webhook_configs table may not exist on a pre-migration DB
    }
    if (!configs.length) return;

    const payload = JSON.stringify({
      event: eventType,
      timestamp: new Date().toISOString(),
      data: rows,
    });

    await Promise.allSettled(
      configs.map(async (cfg) => {
        let status: string;
        try {
          const signature = await hmacSha256Hex(cfg.secret, payload);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
          try {
            const resp = await fetch(cfg.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Livo-Event': eventType,
                'X-Livo-Signature': signature,
              },
              body: payload,
              signal: controller.signal,
            });
            status = String(resp.status);
          } finally {
            clearTimeout(timer);
          }
        } catch (err) {
          status = String(err).slice(0, MAX_STATUS_LEN);
        }
        try {
          await env.DB.prepare(
            'UPDATE webhook_configs SET last_status = ?, last_sent_at = ? WHERE id = ?'
          )
            .bind(status, new Date().toISOString(), cfg.id)
            .run();
        } catch {
          /* best-effort bookkeeping */
        }
      })
    );
  } catch (err) {
    console.error('[webhooks] dispatch error:', err); // must never propagate
  }
}
