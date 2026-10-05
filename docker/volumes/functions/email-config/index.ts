// email-config — customer self-bind Resend email config (admin-gated; key write-only).
//
// SELF-HOST version. Lets a self-host customer connect their OWN Resend account
// from the app UI (系統管理 → 通知) instead of editing env. The API key is
// stored in the server-only email_config table (RLS: no anon / authenticated
// access) and is NEVER returned to the client. The livo_notify_email_dispatch
// DB trigger (20260714_notify_dispatch.sql) reads it to send notification
// emails asynchronously via pg_net. Self-contained (no ../_shared import) to
// match the other docker/volumes/functions — same structure as slack-config.
//
// Contract:
//   GET  → masked status (any authenticated member). Response:
//            configured: { configured:true, source:'app', fromAddress, configuredAt }
//            else:       { configured:false, source:null, fromAddress:null }
//   POST { apiKey, fromAddress } → set/clear (super_admin only;
//         callers presenting the service-role key are exempt):
//            empty apiKey             → disconnect → { ok:true, configured:false }
//            apiKey not 're_…'        → { ok:false, error:'invalid_key', message } (400)
//            missing/bad fromAddress  → { ok:false, error:'invalid_from', message } (400)
//            Resend key check fails   → { ok:false, error:'auth_failed', message } (400)
//            success                  → { ok:true, configured:true, fromAddress }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const RESEND_API = 'https://api.resend.com';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

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

    // ── Verify caller identity (service-role key exempt; else JWT) ──────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    const isServiceCaller = !!serviceKey && jwt === serviceKey;
    let callerAuth: { id: string; email?: string } | null = null;
    if (!isServiceCaller) {
      const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(jwt);
      if (authError || !user) return json({ error: 'Invalid token' }, 401);
      callerAuth = user as { id: string; email?: string };
    }

    // ── GET: masked status (any authenticated member) ──────────────────────
    if (req.method === 'GET') {
      const { data: row } = await supabaseAdmin
        .from('email_config')
        .select('from_address, configured_at')
        .eq('id', 'singleton')
        .not('api_key', 'is', null)
        .neq('api_key', '')
        .maybeSingle();

      if (row) {
        return json({
          configured: true,
          source: 'app',
          fromAddress: (row as any).from_address ?? null,
          configuredAt: (row as any).configured_at ?? null,
        });
      }
      return json({ configured: false, source: null, fromAddress: null });
    }

    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    // ── POST: set/clear — super_admin only (service key exempt) ────
    let memberId: string | null = null;
    if (!isServiceCaller) {
      // No e-mail fallback and only active members: an unlinked login may carry an
      // admin's address, and a member deactivated within the hour still has a token.
      let member: { id?: string; role?: string } | null = null;
      const { data: byAuth } = await supabaseAdmin
        .from('members')
        .select('id, role')
        .eq('auth_id', callerAuth!.id)
        .eq('is_active', true)
        .maybeSingle();
      member = byAuth as typeof member;
      if (!member || member.role !== 'super_admin') {
        return json({ error: 'Permission denied: super_admin role required' }, 403);
      }
      memberId = member.id ?? null;
    }

    const body = (await req.json().catch(() => ({}))) as { apiKey?: unknown; fromAddress?: unknown };
    const apiKey = (body.apiKey ?? '').toString().trim();
    const fromAddress = (body.fromAddress ?? '').toString().trim();

    if (!apiKey) {
      // Disconnect: clear the stored config.
      await supabaseAdmin.from('email_config').upsert(
        { id: 'singleton', api_key: null, from_address: null, configured_at: null, configured_by: null },
        { onConflict: 'id' },
      );
      return json({ ok: true, configured: false });
    }

    if (!apiKey.startsWith('re_')) {
      return json({ ok: false, error: 'invalid_key', message: 'API Key 應以 re_ 開頭（Resend API Key）' }, 400);
    }
    // Accept "user@domain" or "Name <user@domain>" (same rule as the worker build).
    if (!fromAddress || !/^[^<>]*<?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(fromAddress)) {
      return json({ ok: false, error: 'invalid_from', message: '請填寫寄件人位址（例：LIVO <notify@your-domain.com>）' }, 400);
    }

    // Validate the key against Resend before persisting (200 = key is live).
    const testResp = await fetch(`${RESEND_API}/domains`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!testResp.ok) {
      return json(
        { ok: false, error: 'auth_failed', message: `Resend 驗證失敗（HTTP ${testResp.status}）：請確認 API Key 正確且未被撤銷` },
        400,
      );
    }

    await supabaseAdmin.from('email_config').upsert(
      {
        id: 'singleton',
        api_key: apiKey,
        from_address: fromAddress,
        configured_at: new Date().toISOString(),
        configured_by: memberId,
      },
      { onConflict: 'id' },
    );

    return json({ ok: true, configured: true, fromAddress });
  } catch (e) {
    console.error('[email-config] error:', e);
    return json({ ok: false, error: 'server_error', message: String(e) }, 500);
  }
});
