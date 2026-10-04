// due-reminders — server-side due-date reminder sweep (scheduler/service or
// super_admin invoked).
//
// SELF-HOST version. The frontend only creates due_soon notifications when the
// affected user is actually logged in (src/context/hooks/useSideEffects.ts) —
// nobody opens the app, nobody gets reminded. This function runs from the
// livo-scheduler sidecar (docker-compose, hourly, service-role key) and creates
// the same notifications server-side: tasks due today/tomorrow (Asia/Taipei
// dates, within 24h), not in a done status, with an assignee. It inserts the
// SAME notification shape the frontend does (type 'due_soon', sender =
// recipient, content 「提醒：任務即將到期：<title>」) so NotificationPanel
// renders it identically, and the livo_notify_email_dispatch DB trigger
// (20260714_notify_dispatch.sql) then emails it automatically when the
// customer has bound a Resend key and the recipient's preferences allow it.
//
// Dedupe: a task+recipient pair is skipped when a 'due_soon' notification for
// it is still unread OR was created within the last 24h — hourly scheduler
// ticks never spam.
//
// Auth: POST only. Callers must present the service-role key, or a member JWT
// whose member row is super_admin (same gate as scheduled-backup's manual
// path). Self-contained (no ../_shared import) to match the other
// docker/volumes/functions.
//
// Response: { ok:true, checked:<tasks matched>, notified:<notifications created> }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

// tasks.due_date is a date string (YYYY-MM-DD) in Taiwan-local terms across the
// app; compute "today"/"tomorrow" in UTC+8 like scheduled-backup's hour check.
function twDateString(offsetDays: number): string {
  const tw = new Date(Date.now() + 8 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000);
  return tw.toISOString().split('T')[0];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    // ── Auth: service-role key OR super_admin member JWT ────────────────────
    const authHeader = req.headers.get('Authorization') || '';
    const callerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!callerToken) return json({ error: 'Unauthorized' }, 401);
    if (callerToken !== serviceKey) {
      const { data: { user: callerAuth }, error: callerErr } =
        await supabase.auth.getUser(callerToken);
      if (callerErr || !callerAuth) return json({ error: 'Invalid token' }, 401);
      let callerRole: string | null = null;
      // No e-mail fallback and only active members: an unlinked login may carry an
      // admin's address, and a member deactivated within the hour still has a token.
      const { data: byAuth } = await supabase
        .from('members').select('role').eq('auth_id', callerAuth.id).eq('is_active', true).maybeSingle();
      callerRole = (byAuth as { role?: string } | null)?.role ?? null;
      if (callerRole !== 'super_admin') {
        return json({ error: 'Permission denied: super_admin role required' }, 403);
      }
    }

    // ── Find tasks due within 24h, not done, with an assignee ──────────────
    const today = twDateString(0);
    const tomorrow = twDateString(1);

    const { data: tasks, error: tasksErr } = await supabase
      .from('tasks')
      .select('id, title, assignee_id, due_date, statuses!inner(is_done)')
      .in('due_date', [today, tomorrow])
      .not('assignee_id', 'is', null)
      .eq('statuses.is_done', false);
    if (tasksErr) return json({ ok: false, error: tasksErr.message }, 500);

    const dueTasks = (tasks ?? []) as Array<{
      id: string; title: string; assignee_id: string; due_date: string;
    }>;

    let notified = 0;
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    for (const task of dueTasks) {
      const {data:paused,error:pauseError}=await supabase.rpc('livo_task_reminder_paused',{p_task:task.id,p_member:task.assignee_id});
      if(pauseError || paused) continue;
      // Skip when a due_soon notification for this task+recipient is still
      // unread or was already created within the last 24h.
      const { data: existing, error: existErr } = await supabase
        .from('notifications')
        .select('id')
        .eq('recipient_id', task.assignee_id)
        .eq('task_id', task.id)
        .eq('type', 'due_soon')
        .or(`is_read.eq.false,created_at.gte.${sinceIso}`)
        .limit(1);
      if (existErr) {
        console.error('[due-reminders] dedupe check failed:', existErr.message);
        continue;
      }
      if (existing && existing.length > 0) continue;

      // Same shape as the frontend's due_soon insert (useSideEffects.ts):
      // sender = recipient, zh-TW content = notification.types.dueSoon + title.
      // The livo_notify_email_dispatch trigger picks this up and emails it.
      const { data: inserted, error: insErr } = await supabase.from('notifications').insert({
        recipient_id: task.assignee_id,
        sender_id: task.assignee_id,
        type: 'due_soon',
        task_id: task.id,
        content: `提醒：任務即將到期：${task.title}`,
        is_read: false,
      }).select('id');
      if (insErr) {
        console.error('[due-reminders] notification insert failed:', insErr.message);
        continue;
      }
      notified+=inserted?.length||0;
    }

    return json({ ok: true, checked: dueTasks.length, notified });
  } catch (e) {
    console.error('[due-reminders] error:', e);
    return json({ ok: false, error: 'server_error', message: String(e) }, 500);
  }
});
