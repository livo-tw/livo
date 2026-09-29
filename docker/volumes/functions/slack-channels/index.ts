// slack-channels — list the workspace's channels for the SlackCard picker.
//
// SELF-HOST version: calls the Slack Web API DIRECTLY (Bearer bot token). The
// old Lovable connector gateway is removed. The token is resolved from the
// server-only slack_config table (customer-bound) or the SLACK_BOT_TOKEN env
// fallback. Self-contained (no ../_shared import) to match the other
// docker/volumes/functions.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const SLACK_API = 'https://slack.com/api';

async function resolveSlackToken(supabase: any): Promise<string | undefined> {
  try {
    const { data } = await supabase
      .from('slack_config')
      .select('bot_token')
      .eq('id', 'singleton')
      .maybeSingle();
    if (data?.bot_token) return data.bot_token;
  } catch {
    // slack_config table may not exist on a pre-migration DB — fall through.
  }
  return Deno.env.get('SLACK_BOT_TOKEN') || undefined;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const token = await resolveSlackToken(supabase);
    if (!token) {
      return new Response(JSON.stringify({ error: 'slack_not_configured' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const resp = await fetch(`${SLACK_API}/conversations.list?limit=200&exclude_archived=true`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    if (!data.ok) {
      return new Response(JSON.stringify({ error: data.error }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const channels = (data.channels || []).map((c: any) => ({
      id: c.id,
      name: c.name,
      is_private: c.is_private || false,
    }));

    return new Response(JSON.stringify({ channels }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[slack] channels error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
