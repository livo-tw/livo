// slack-config — customer self-bind Slack config (admin-gated; token write-only).
//
// SELF-HOST version. Lets a self-host customer connect their OWN Slack workspace
// from the app UI (系統管理 → 通知 / SlackCard) instead of editing env. The bot
// token is stored in the server-only slack_config table (RLS: no anon /
// authenticated access) and is NEVER returned to the client. Self-contained (no
// ../_shared import) to match the other docker/volumes/functions. Mirrors
// worker/src/functions/slack.ts — same request/response contract, so the shared
// frontend SlackCard works against both builds.
//
// Contract:
//   GET  → masked status (any authenticated member). Response:
//            app-bound token present: { configured:true, source:'app', team, configuredAt }
//            else:                    { configured:<!!env>, source:'env'|null, team:null }
//   POST { token } → set/clear (super_admin only):
//            empty token            → disconnect → { ok:true, configured:false }
//            token not 'xoxb-…'     → { ok:false, error:'invalid_token', message } (400)
//            Slack auth.test fails  → { ok:false, error:'auth_failed', message } (400)
//            success                → { ok:true, configured:true, team }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const SLACK_API = 'https://slack.com/api';

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
    const envToken = Deno.env.get('SLACK_BOT_TOKEN');

    // ── Verify caller identity via JWT (same pattern as manage-member) ──────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorized' }, 401);
    const jwt = authHeader.replace('Bearer ', '');
    const { data: { user: callerAuth }, error: authError } = await supabaseAdmin.auth.getUser(jwt);
    if (authError || !callerAuth) return json({ error: 'Invalid token' }, 401);

    // ── GET: masked status (any authenticated member) ──────────────────────
    if (req.method === 'GET') {
      const { data: row } = await supabaseAdmin
        .from('slack_config')
        .select('team_name, configured_at')
        .eq('id', 'singleton')
        .not('bot_token', 'is', null)
        .maybeSingle();

      if (row) {
        return json({
          configured: true,
          source: 'app',
          team: (row as any).team_name,
          configuredAt: (row as any).configured_at,
        });
      }
      return json({ configured: !!envToken, source: envToken ? 'env' : null, team: null });
    }

    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    // ── POST: set/clear — super_admin only ─────────────────────────
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

    const body = (await req.json().catch(() => ({}))) as { token?: unknown };
    const token = (body.token ?? '').toString().trim();

    if (!token) {
      // Disconnect: clear the stored token.
      await supabaseAdmin.from('slack_config').upsert(
        { id: 'singleton', bot_token: null, team_name: null, configured_at: null, configured_by: null },
        { onConflict: 'id' },
      );
      return json({ ok: true, configured: false });
    }

    if (!token.startsWith('xoxb-')) {
      return json({ ok: false, error: 'invalid_token', message: 'Bot Token 應以 xoxb- 開頭' }, 400);
    }

    // Validate against Slack before persisting.
    const testResp = await fetch(`${SLACK_API}/auth.test`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    const test = await testResp.json();
    if (!test.ok) {
      return json(
        { ok: false, error: 'auth_failed', message: `Slack 驗證失敗：${test.error ?? 'unknown'}（請確認 token 正確且未被撤銷）` },
        400,
      );
    }

    const teamName = test.team ?? '';
    await supabaseAdmin.from('slack_config').upsert(
      {
        id: 'singleton',
        bot_token: token,
        team_name: teamName,
        configured_at: new Date().toISOString(),
        configured_by: member.id ?? null,
      },
      { onConflict: 'id' },
    );

    return json({ ok: true, configured: true, team: teamName });
  } catch (e) {
    console.error('[slack-config] error:', e);
    return json({ ok: false, error: 'server_error', message: String(e) }, 500);
  }
});
