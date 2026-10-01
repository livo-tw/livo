import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// App base URL. Prefer the explicit APP_BASE_URL env (host root, e.g.
// https://pm.acme.com); otherwise derive from the incoming request (behind Kong
// the real host is in x-forwarded-*). Falls back to the public site. The
// self-hosted app is served at the root of that host.
function resolveAppUrl(req: Request): string {
  const explicit = Deno.env.get('APP_BASE_URL');
  let base: string;
  if (explicit) {
    base = explicit.replace(/\/+$/, '');
  } else {
    const url = new URL(req.url);
    const proto = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
    base = host ? `${proto}://${host}` : 'https://livo-tw.com';
  }
  return base;
}

const priorityLabels: Record<string, string> = {
  highest: '🔴 最高',
  high: '🟠 高',
  medium: '🟡 中',
  low: '🔵 低',
  lowest: '⚪ 最低',
};

Deno.serve(async (req) => {
  const APP_URL = resolveAppUrl(req);
  const url = new URL(req.url);
  const taskKey = url.searchParams.get('task');

  if (!taskKey) {
    return Response.redirect(APP_URL, 302);
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Find the task by task_key or id
    let task: any = null;
    const { data: byKey } = await supabase
      .from('tasks')
      .select('id, task_key, title, priority, status_id, assignee_id, project_id, due_date, created_at')
      .eq('task_key', taskKey)
      .limit(1)
      .single();

    if (byKey) {
      task = byKey;
    } else {
      const { data: byId } = await supabase
        .from('tasks')
        .select('id, task_key, title, priority, status_id, assignee_id, project_id, due_date, created_at')
        .eq('id', taskKey)
        .limit(1)
        .single();
      if (byId) task = byId;
    }

    if (!task) {
      return Response.redirect(`${APP_URL}/?task=${taskKey}`, 302);
    }

    // Fetch related data
    const [statusRes, assigneeRes, projectRes] = await Promise.all([
      supabase.from('statuses').select('name').eq('id', task.status_id).single(),
      task.assignee_id
        ? supabase.from('members').select('name').eq('id', task.assignee_id).single()
        : Promise.resolve({ data: null }),
      supabase.from('projects').select('name').eq('id', task.project_id).single(),
    ]);

    const statusName = statusRes.data?.name || '—';
    const assigneeName = assigneeRes.data?.name || '未指派';
    const projectName = projectRes.data?.name || '—';
    const priorityLabel = priorityLabels[task.priority] || task.priority;

    const ogTitle = `${task.task_key} - ${task.title}`;
    const ogDescription = `專案：${projectName} | 狀態：${statusName} | 優先級：${priorityLabel} | 負責人：${assigneeName}${task.due_date ? ` | 到期日：${task.due_date}` : ''}`;
    const redirectUrl = `${APP_URL}/?task=${task.task_key}`;

    // Check user agent - if it's a bot/crawler, serve OG HTML; otherwise redirect
    const ua = req.headers.get('user-agent') || '';
    const isBot = /Slackbot|facebookexternalhit|Twitterbot|LinkedInBot|WhatsApp|Discordbot|TelegramBot/i.test(ua);

    if (!isBot) {
      return Response.redirect(redirectUrl, 302);
    }

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escHtml(ogTitle)}</title>
  <meta property="og:title" content="${escHtml(ogTitle)}" />
  <meta property="og:description" content="${escHtml(ogDescription)}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${escHtml(redirectUrl)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${escHtml(ogTitle)}" />
  <meta name="twitter:description" content="${escHtml(ogDescription)}" />
  <meta http-equiv="refresh" content="0;url=${escHtml(redirectUrl)}">
</head>
<body>
  <p>Redirecting to <a href="${escHtml(redirectUrl)}">${escHtml(ogTitle)}</a></p>
</body>
</html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    console.error('OG task error:', err);
    return Response.redirect(`${APP_URL}/?task=${taskKey}`, 302);
  }
});

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
