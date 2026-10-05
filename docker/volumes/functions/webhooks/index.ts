// webhooks — customer webhook endpoint CRUD (admin-gated; secret shown once).
//
// SELF-HOST version. Manages the webhook_configs table (server-only: RLS with
// zero policies — the signing secret must never reach clients). Actual event
// delivery is done inside Postgres by the livo_webhook_dispatch trigger
// (20260714_notify_dispatch.sql) via pg_net; each request is HMAC-SHA256
// signed with the per-hook secret (X-Livo-Signature header, hex over the raw
// request body). Self-contained (no ../_shared import) to match the other
// docker/volumes/functions — same structure as slack-config.
//
// Contract (super_admin only; service-role key exempt):
//   GET  → { webhooks: [{ id, url, events, enabled, created_at,
//                         last_status, last_sent_at }] }         (never the secret)
//   POST { action:'create', url, events? }
//        → { ok:true, id, url, events, secret:'whsec_…' }        (secret shown ONCE)
//   POST { action:'toggle', id } → { ok:true, enabled }
//   POST { action:'delete', id } → { ok:true }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const ALLOWED_EVENTS = ['task_created', 'task_updated', 'task_deleted', 'comment_added'];
const PUBLIC_COLUMNS = 'id, url, events, enabled, created_at, last_status, last_sent_at';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

function generateSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return 'whsec_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    // ── Verify caller: service-role key exempt; else JWT → admin+ member ───
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    const isServiceCaller = !!serviceKey && jwt === serviceKey;
    let memberId: string | null = null;
    if (!isServiceCaller) {
      const { data: { user: callerAuth }, error: authError } = await supabaseAdmin.auth.getUser(jwt);
      if (authError || !callerAuth) return json({ error: 'Invalid token' }, 401);

      // No e-mail fallback and only active members: an unlinked login may carry an
      // admin's address, and a member deactivated within the hour still has a token.
      let member: { id?: string; role?: string } | null = null;
      const { data: byAuth } = await supabaseAdmin
        .from('members')
        .select('id, role')
        .eq('auth_id', callerAuth.id)
        .eq('is_active', true)
        .maybeSingle();
      member = byAuth as typeof member;
      if (!member || member.role !== 'super_admin') {
        return json({ error: 'Permission denied: super_admin role required' }, 403);
      }
      memberId = member.id ?? null;
    }

    // ── GET: list (public columns only — never the secret) ─────────────────
    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin
        .from('webhook_configs')
        .select(PUBLIC_COLUMNS)
        .order('created_at', { ascending: false });
      if (error) return json({ error: error.message }, 500);
      return json({ webhooks: data ?? [] });
    }

    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const body = (await req.json().catch(() => ({}))) as {
      action?: unknown; url?: unknown; events?: unknown; id?: unknown;
    };
    const action = (body.action ?? '').toString();

    // ── create ──────────────────────────────────────────────────────────────
    if (action === 'create') {
      const url = (body.url ?? '').toString().trim();
      if (!/^https?:\/\/.+/i.test(url)) {
        return json({ ok: false, error: 'invalid_url', message: 'Webhook URL 必須以 http:// 或 https:// 開頭' }, 400);
      }
      let events = Array.isArray(body.events)
        ? (body.events as unknown[]).map((e) => String(e)).filter((e) => ALLOWED_EVENTS.includes(e))
        : [];
      if (events.length === 0) events = [...ALLOWED_EVENTS];
      // De-duplicate while keeping ALLOWED_EVENTS order.
      events = ALLOWED_EVENTS.filter((e) => events.includes(e));

      const secret = generateSecret();
      const { data, error } = await supabaseAdmin
        .from('webhook_configs')
        .insert({ url, events, secret, enabled: true, created_by: memberId })
        .select('id')
        .single();
      if (error) return json({ ok: false, error: error.message }, 500);
      // The ONLY time the secret is ever returned (same shape as the worker
      // build's webhooks function so the shared frontend works on both).
      return json({ ok: true, id: (data as any).id, url, events, secret });
    }

    // ── toggle / delete ─────────────────────────────────────────────────────
    if (action === 'toggle' || action === 'delete') {
      const id = (body.id ?? '').toString().trim();
      if (!id) return json({ ok: false, error: 'missing_id' }, 400);

      if (action === 'delete') {
        const { error } = await supabaseAdmin.from('webhook_configs').delete().eq('id', id);
        if (error) return json({ ok: false, error: error.message }, 500);
        return json({ ok: true });
      }

      const { data: row, error: readErr } = await supabaseAdmin
        .from('webhook_configs')
        .select('id, enabled')
        .eq('id', id)
        .maybeSingle();
      if (readErr) return json({ ok: false, error: readErr.message }, 500);
      if (!row) return json({ ok: false, error: 'not_found' }, 404);
      const enabled = !(row as any).enabled;
      const { error: updErr } = await supabaseAdmin
        .from('webhook_configs')
        .update({ enabled })
        .eq('id', id);
      if (updErr) return json({ ok: false, error: updErr.message }, 500);
      return json({ ok: true, enabled });
    }

    return json({ ok: false, error: 'unknown_action' }, 400);
  } catch (e) {
    console.error('[webhooks] error:', e);
    return json({ ok: false, error: 'server_error', message: String(e) }, 500);
  }
});
