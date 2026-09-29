// og-task — public task Open Graph page. Port of supabase/functions/og-task.
//
// Bots/crawlers get an OG meta HTML page; humans get a 302 to the app.
// App URL fixed from the legacy https://tw-pm.lovable.app to the real
// deployment: appBaseUrl(env) + '/demo'.

import type { Context } from 'hono';
import type { AppContext } from '../env';
import { appBaseUrl, DEFAULT_WORKSPACE } from '../env';

const priorityLabels: Record<string, string> = {
  highest: '🔴 最高',
  high: '🟠 高',
  medium: '🟡 中',
  low: '🔵 低',
  lowest: '⚪ 最低',
};

interface TaskRow {
  id: string;
  task_key: string;
  title: string;
  priority: string | null;
  status_id: string | null;
  assignee_id: string | null;
  project_id: string | null;
  due_date: string | null;
  created_at: string;
}

const TASK_COLS =
  'id, task_key, title, priority, status_id, assignee_id, project_id, due_date, created_at';

export async function handleOgTask(c: Context<AppContext>): Promise<Response> {
  const appUrl = `${appBaseUrl(c.env)}/demo`;
  const taskKey = c.req.query('task');

  if (!taskKey) {
    return Response.redirect(appUrl, 302);
  }

  try {
    const db = c.env.DB;

    // Check user agent - if it's a bot/crawler, serve OG HTML; otherwise redirect
    const ua = c.req.header('user-agent') || '';
    const isBot = /Slackbot|facebookexternalhit|Twitterbot|LinkedInBot|WhatsApp|Discordbot|TelegramBot/i.test(
      ua
    );

    // This endpoint is PUBLIC: rich OG data is only ever served for workspace
    // 'default' (the public demo) — beta tenants' task metadata must not leak.
    // Find the task by task_key or id
    let task = await db
      .prepare(`SELECT ${TASK_COLS} FROM tasks WHERE task_key = ? AND workspace_id = ? LIMIT 1`)
      .bind(taskKey, DEFAULT_WORKSPACE)
      .first<TaskRow>();

    if (!task) {
      task = await db
        .prepare(`SELECT ${TASK_COLS} FROM tasks WHERE id = ? AND workspace_id = ? LIMIT 1`)
        .bind(taskKey, DEFAULT_WORKSPACE)
        .first<TaskRow>();
    }

    if (!task) {
      // Not found under 'default' (a beta tenant's task, or garbage): humans
      // get the usual redirect to the app (which enforces login); bots get a
      // GENERIC OG card with zero task details.
      const fallbackUrl = `${appUrl}/?task=${encodeURIComponent(taskKey)}`;
      if (!isBot) {
        return Response.redirect(fallbackUrl, 302);
      }
      return genericOgResponse(fallbackUrl);
    }

    // Fetch related display names (demo workspace only — see guard above)
    const nameOf = async (table: 'statuses' | 'members' | 'projects', id: string | null) => {
      if (!id) return null;
      const row = await db
        .prepare(`SELECT name FROM ${table} WHERE id = ? AND workspace_id = ? LIMIT 1`)
        .bind(id, DEFAULT_WORKSPACE)
        .first<{ name: string }>();
      return row?.name ?? null;
    };

    const [statusName0, assigneeName0, projectName0] = await Promise.all([
      nameOf('statuses', task.status_id),
      nameOf('members', task.assignee_id),
      nameOf('projects', task.project_id),
    ]);

    const statusName = statusName0 || '—';
    const assigneeName = assigneeName0 || '未指派';
    const projectName = projectName0 || '—';
    const priorityLabel = (task.priority && priorityLabels[task.priority]) || task.priority || '';

    const ogTitle = `${task.task_key} - ${task.title}`;
    const ogDescription = `專案：${projectName} | 狀態：${statusName} | 優先級：${priorityLabel} | 負責人：${assigneeName}${task.due_date ? ` | 到期日：${task.due_date}` : ''}`;
    const redirectUrl = `${appUrl}/?task=${task.task_key}`;

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
    return Response.redirect(`${appUrl}/?task=${encodeURIComponent(taskKey)}`, 302);
  }
}

/** Generic OG card for bots when the task isn't in the demo workspace — no
 *  title, status, assignee, or any other task detail is exposed. */
function genericOgResponse(redirectUrl: string): Response {
  const ogTitle = 'LIVO 任務';
  const ogDescription = '登入 LIVO 以檢視此任務';
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
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
