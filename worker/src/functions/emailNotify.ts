// Email notifications — Resend-backed emails for in-app `notifications` rows,
// plus the daily due-soon reminder cron. slack.ts is the sibling module: the
// config endpoints mirror slack-config (customer-bound key in the server-only
// email_config table wins, env.RESEND_API_KEY is the instance fallback, the
// key itself is NEVER returned to the client).
//
// Exports (see index.ts / db.ts):
//   resolveEmailConfig(env)          — effective Resend key + from address
//   handleEmailConfigStatus(c)       — GET  /api/functions/email-config (member JWT)
//   handleEmailConfigSet(c)          — POST /api/functions/email-config (admin; demo-blocked)
//   sendNotificationEmails(env,rows) — best-effort emails for freshly inserted
//                                      notifications rows (db.ts post-mutation hook)
//   runDueReminders(env)             — hourly cron entrypoint, self-gated to
//                                      01:00 UTC (09:00 台灣) once a day
//   sendResendEmail / escapeHtml     — reused by memberLogin.ts (set-password
//                                      invitations)

import type { Context } from 'hono';
import type { AppContext, Env } from '../env';
import { appBaseUrl, DEFAULT_WORKSPACE, isDemoWorkspace } from '../env';

const DEFAULT_FROM = 'LIVO <service@livo-tw.com>';
const RESEND_API = 'https://api.resend.com';
/** Safety cap on emails per invocation (bulk seed inserts must not fan out). */
const MAX_EMAILS_PER_CALL = 50;

type Row = Record<string, unknown>;

// ─── notifications.type → email preference type ────────────────────────────
// The frontend inserts these `type` values (createNotification call sites):
//   'assign'   — useTaskActions: 指派為經辦人           → pref 'assigned'
//   'review'   — useTaskActions: 指派為驗收人           → pref 'assigned'
//   'mention'  — useTaskComments/useTaskSpecs: @提及    → pref 'mentioned'
//   'due_soon' — useSideEffects + runDueReminders 到期  → pref 'due_soon'
// Everything else (comment / comment_reply / status_changed / system /
// approval_requested / approval_completed / unauthorized_login) stays
// in-app only — no email.
const PREF_TYPE: Record<string, 'assigned' | 'mentioned' | 'due_soon'> = {
  assign: 'assigned',
  review: 'assigned',
  mention: 'mentioned',
  due_soon: 'due_soon',
};

const TYPE_LABEL: Record<string, string> = {
  assign: '你被指派為經辦人',
  review: '你被指派為驗收人',
  mention: '你在留言中被提及',
  due_soon: '任務即將到期',
};

const ALL_PREF_TYPES = ['assigned', 'mentioned', 'due_soon'];

// ─── Config resolution (slack resolveSlackToken twin) ───────────────────────

export interface EmailConfig {
  apiKey: string;
  fromAddress: string;
  source: 'app' | 'env';
}

/** Customer-bound key (email_config row keyed by WORKSPACE id — the legacy
 *  'singleton' row was renamed to 'default' by migration) wins; falls back to
 *  env.RESEND_API_KEY (the instance transport also serves cloud-beta
 *  tenants). Neither set → null (feature silently off). */
export async function resolveEmailConfig(env: Env, ws: string = DEFAULT_WORKSPACE): Promise<EmailConfig | null> {
  try {
    const row = await env.DB.prepare(
      'SELECT api_key, from_address FROM email_config WHERE id = ? LIMIT 1'
    )
      .bind(ws)
      .first<{ api_key: string | null; from_address: string | null }>();
    if (row?.api_key) {
      return { apiKey: row.api_key, fromAddress: row.from_address || DEFAULT_FROM, source: 'app' };
    }
  } catch {
    /* email_config table may not exist on a pre-migration DB — fall through */
  }
  if (env.RESEND_API_KEY) {
    return {
      apiKey: env.RESEND_API_KEY,
      fromAddress: env.RESEND_FROM_EMAIL || DEFAULT_FROM,
      source: 'env',
    };
  }
  return null;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');

export async function sendResendEmail(
  cfg: EmailConfig,
  to: string,
  subject: string,
  html: string
): Promise<boolean> {
  try {
    const resp = await fetch(`${RESEND_API}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.fromAddress, to: [to], subject, html }),
    });
    if (!resp.ok) {
      console.error('[email-notify] Resend failed:', resp.status, await resp.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('[email-notify] Resend error:', err);
    return false;
  }
}

// ─── Email body ─────────────────────────────────────────────────────────────

function buildNotificationHtml(
  env: Env,
  type: string,
  content: string,
  task: { task_key: string; title: string } | null
): string {
  const label = TYPE_LABEL[type] || 'LIVO 通知';
  const taskBlock = task
    ? `<p style="margin:0 0 24px">
      <a href="${appBaseUrl(env)}/demo/?task=${encodeURIComponent(task.task_key)}"
         style="display:inline-block;background:#7C3AED;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">
        查看任務 ${escapeHtml(task.task_key)} →</a>
    </p>
    <p style="color:#64748B;margin:0 0 24px;font-size:14px;line-height:1.7">
      <span style="font-family:monospace">${escapeHtml(task.task_key)}</span> ${escapeHtml(task.title)}
    </p>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LIVO 通知</title></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Noto Sans TC',sans-serif;color:#0F172A">
<div style="max-width:600px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#7C3AED,#5B21B6);padding:36px 40px;text-align:center">
    <h1 style="margin:0;font-size:26px;font-weight:900;color:#fff;letter-spacing:-.5px">LIVO</h1>
  </div>
  <div style="padding:40px">
    <h2 style="font-size:20px;font-weight:700;margin:0 0 8px">🔔 ${escapeHtml(label)}</h2>
    ${content ? `<p style="color:#334155;margin:0 0 24px;line-height:1.7">${escapeHtml(content)}</p>` : ''}
    ${taskBlock}
    <p style="color:#94A3B8;margin:0;font-size:12px;line-height:1.7">
      不想收到這類信件？通知偏好可在 LIVO 的「個人設定 → 通知」中調整。
    </p>
  </div>
</div>
</body>
</html>`;
}

// ─── The pipeline: notifications INSERT → email ─────────────────────────────

interface EmailTarget {
  recipientId: string;
  type: string;
  prefType: 'assigned' | 'mentioned' | 'due_soon';
  taskId: string;
  content: string;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/**
 * Best-effort: email the recipients of freshly inserted `notifications` rows.
 * Called via ctx.waitUntil from db.ts (post-mutation hook) and directly from
 * runDueReminders. NEVER throws; every failure is logged and swallowed.
 * Rows may be wire-shaped (booleans) or raw D1 rows — only TEXT columns are read.
 */
export async function sendNotificationEmails(env: Env, rows: Row[]): Promise<void> {
  try {
    if (!rows.length) return;

    // Tenancy: rows carry workspace_id (wire rows from db.ts / the raw
    // due-reminder inserts). Process per workspace: the public-demo workspace
    // never emails its seeded members, other workspaces use their own (or the
    // instance) transport. Rows from one /api/query call share a workspace;
    // only the due-reminder cron produces mixed batches.
    const byWs = new Map<string, Row[]>();
    for (const r of rows) {
      const ws = asStr(r.workspace_id) || DEFAULT_WORKSPACE;
      if (isDemoWorkspace(env, ws)) continue; // demo must not email seeded members
      let arr = byWs.get(ws);
      if (!arr) {
        arr = [];
        byWs.set(ws, arr);
      }
      arr.push(r);
    }
    for (const [ws, wsRows] of byWs) {
      await sendWorkspaceNotificationEmails(env, ws, wsRows);
    }
  } catch (err) {
    console.error('[email-notify] error:', err); // must never propagate
  }
}

async function sendWorkspaceNotificationEmails(env: Env, ws: string, rows: Row[]): Promise<void> {
  try {
    // Map to pref types + dedupe within the batch (recipient/type/task once).
    const seen = new Set<string>();
    const targets: EmailTarget[] = [];
    for (const r of rows) {
      const type = asStr(r.type);
      const recipientId = asStr(r.recipient_id);
      const prefType = PREF_TYPE[type];
      if (!prefType || !recipientId) continue;
      const taskId = asStr(r.task_id);
      const key = `${recipientId}|${prefType}|${taskId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ recipientId, type, prefType, taskId, content: asStr(r.content) });
    }
    if (!targets.length) return;

    const cfg = await resolveEmailConfig(env, ws);
    if (!cfg) return; // no transport configured — feature silently off

    // Batch-load recipients, their prefs, and the referenced tasks (all
    // workspace-bounded — ids are unique, the predicate is defense in depth).
    const memberIds = [...new Set(targets.map((t) => t.recipientId))];
    const taskIds = [...new Set(targets.map((t) => t.taskId).filter(Boolean))];

    const memberRes = await env.DB.prepare(
      `SELECT id, name, email, is_active FROM members WHERE workspace_id = ? AND id IN (${placeholders(memberIds.length)})`
    )
      .bind(ws, ...memberIds)
      .all<{ id: string; name: string; email: string | null; is_active: number }>();
    const members = new Map((memberRes.results || []).map((m) => [m.id, m]));

    const prefRes = await env.DB.prepare(
      `SELECT user_id, email_notify_enabled, email_notify_types FROM user_notification_preferences
       WHERE workspace_id = ? AND user_id IN (${placeholders(memberIds.length)})`
    )
      .bind(ws, ...memberIds)
      .all<{ user_id: string; email_notify_enabled: number; email_notify_types: string | null }>();
    const prefs = new Map((prefRes.results || []).map((p) => [p.user_id, p]));

    const tasks = new Map<string, { task_key: string; title: string }>();
    if (taskIds.length) {
      const taskRes = await env.DB.prepare(
        `SELECT id, task_key, title FROM tasks WHERE workspace_id = ? AND id IN (${placeholders(taskIds.length)})`
      )
        .bind(ws, ...taskIds)
        .all<{ id: string; task_key: string; title: string }>();
      for (const t of taskRes.results || []) tasks.set(t.id, t);
    }

    let sent = 0;
    for (const target of targets) {
      if (sent >= MAX_EMAILS_PER_CALL) break;

      const member = members.get(target.recipientId);
      if (!member || !member.is_active || !member.email) continue;

      // Missing prefs row = defaults: enabled + all three types.
      const pref = prefs.get(target.recipientId);
      if (pref) {
        if (!pref.email_notify_enabled) continue;
        let types: string[] = ALL_PREF_TYPES;
        if (typeof pref.email_notify_types === 'string' && pref.email_notify_types !== '') {
          try {
            const parsed: unknown = JSON.parse(pref.email_notify_types);
            if (Array.isArray(parsed)) types = parsed.filter((x): x is string => typeof x === 'string');
          } catch {
            /* malformed prefs → default to all */
          }
        }
        if (!types.includes(target.prefType)) continue;
      }

      const task = tasks.get(target.taskId) || null;
      const summary = target.content || TYPE_LABEL[target.type] || '你有一則新通知';
      const subject = `LIVO 通知：${summary.slice(0, 40)}`;
      const html = buildNotificationHtml(env, target.type, target.content, task);
      if(target.type==='due_soon' && await env.DB.prepare("SELECT 1 FROM task_reminder_preferences WHERE workspace_id=? AND task_id=? AND member_id=? AND julianday(snoozed_until)>julianday('now')").bind(ws,target.taskId,target.recipientId).first()) continue;
      if (await sendResendEmail(cfg, member.email, subject, html)) sent++;
    }
    if (sent > 0) console.log(`[email-notify] ws=${ws} sent=${sent}/${targets.length}`);
  } catch (err) {
    console.error('[email-notify] workspace error:', err); // must never propagate
  }
}

// ─── Due-soon reminder cron ─────────────────────────────────────────────────

interface DueTaskRow {
  id: string;
  title: string;
  assignee_id: string;
  workspace_id: string | null;
}

/**
 * Hourly cron entrypoint (scheduled()); self-gates to a single daily run at
 * 01:00 UTC (09:00 台灣). Finds tasks due within the next 24h (due_date is a
 * YYYY-MM-DD string → TW-today or TW-tomorrow), not in a done status, with an
 * assignee, inserts a 'due_soon' notification per (task, assignee) — deduped
 * against unread due_soon rows from the last 24h — and pushes the email hook
 * manually (the db.ts hook only fires on the /api/query path).
 */
export async function runDueReminders(env: Env): Promise<void> {
  try {
    if (new Date().getUTCHours() !== 1) return; // once daily, 09:00 台灣

    const nowTW = new Date(Date.now() + 8 * 3_600_000);
    const todayTW = nowTW.toISOString().slice(0, 10);
    const tomorrowTW = new Date(nowTW.getTime() + 86_400_000).toISOString().slice(0, 10);
    const dedupeCutoff = new Date(Date.now() - 86_400_000).toISOString();

    const res = await env.DB.prepare(
      `SELECT t.id, t.title, t.assignee_id, t.workspace_id FROM tasks t
       JOIN statuses s ON s.id = t.status_id AND s.workspace_id=t.workspace_id
       WHERE t.assignee_id IS NOT NULL
         AND s.is_done = 0
         AND NOT EXISTS(SELECT 1 FROM task_reminder_preferences p WHERE p.workspace_id=t.workspace_id AND p.task_id=t.id AND p.member_id=t.assignee_id AND julianday(p.snoozed_until)>julianday('now'))
         AND t.due_date >= ? AND t.due_date <= ?
         AND NOT EXISTS (
           SELECT 1 FROM notifications n
           WHERE n.workspace_id=t.workspace_id AND n.task_id = t.id AND n.recipient_id = t.assignee_id
             AND n.type = 'due_soon' AND n.is_read = 0 AND n.created_at >= ?
         )
       LIMIT 200`
    )
      .bind(todayTW, tomorrowTW, dedupeCutoff)
      .all<DueTaskRow>();

    const dueTasks = res.results || [];
    if (!dueTasks.length) return;

    // Plain env.DB inserts (NOT runQuery) — content matches the frontend's
    // own due-soon insert (zh-TW notification.types.dueSoon + '：{title}')
    // so NotificationPanel renders both identically. workspace_id inherits
    // from the task so realtime/email routing lands in the right tenant.
    const now = new Date().toISOString();
    const inserted: Row[] = dueTasks.map((t) => ({
      workspace_id: t.workspace_id || DEFAULT_WORKSPACE,
      id: crypto.randomUUID(),
      recipient_id: t.assignee_id,
      sender_id: t.assignee_id, // sender is NOT NULL → assignee stands in (no system member)
      type: 'due_soon',
      task_id: t.id,
      content: `提醒：任務即將到期：${t.title}`,
      is_read: 0,
      created_at: now,
    }));
    const stmt = env.DB.prepare(
      `INSERT INTO notifications (workspace_id, id, recipient_id, sender_id, type, task_id, content, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    );
    const results=await env.DB.batch<{id:string}>(
      inserted.map((r) =>
        stmt.bind(r.workspace_id, r.id, r.recipient_id, r.sender_id, r.type, r.task_id, r.content, r.is_read, r.created_at)
      )
    );

    const stored=new Set(results.flatMap(result=>(result.results||[]).map(row=>row.id)));
    const created=inserted.filter(row=>stored.has(String(row.id)));
    await sendNotificationEmails(env, created);
    console.log(`[due-reminders] inserted=${created.length}`);
  } catch (err) {
    console.error('[due-reminders] error:', err);
  }
}

// ─── Customer self-bind email config (slack-config twin) ────────────────────

/** GET /api/functions/email-config — masked status only (member JWT). */
export async function handleEmailConfigStatus(c: Context<AppContext>): Promise<Response> {
  const env = c.env;
  const ws = c.get('auth')?.member?.workspaceId || DEFAULT_WORKSPACE;
  const envFallback = () =>
    c.json({
      configured: !!env.RESEND_API_KEY,
      source: env.RESEND_API_KEY ? 'env' : null,
      fromAddress: env.RESEND_API_KEY ? env.RESEND_FROM_EMAIL || DEFAULT_FROM : null,
    });
  try {
    const row = await env.DB.prepare(
      'SELECT from_address, configured_at FROM email_config WHERE id = ? AND api_key IS NOT NULL LIMIT 1'
    )
      .bind(ws)
      .first<{ from_address: string | null; configured_at: string | null }>();
    if (row) {
      return c.json({
        configured: true,
        source: 'app',
        fromAddress: row.from_address || DEFAULT_FROM,
        configuredAt: row.configured_at,
      });
    }
    return envFallback();
  } catch {
    return envFallback();
  }
}

/**
 * POST /api/functions/email-config — set/clear the customer's Resend key
 * (member JWT + demoGuard + admin). Body {apiKey, fromAddress}. Empty apiKey
 * disconnects. A non-empty key is validated against Resend (GET /domains)
 * before it is stored. Never echoes the key back.
 */
export async function handleEmailConfigSet(c: Context<AppContext>): Promise<Response> {
  const env = c.env;
  const auth = c.get('auth');
  const ws = auth?.member?.workspaceId || DEFAULT_WORKSPACE;
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      apiKey?: unknown;
      fromAddress?: unknown;
    };
    const apiKey = (body.apiKey ?? '').toString().trim();
    const fromAddress = (body.fromAddress ?? '').toString().trim();

    if (!apiKey) {
      // Disconnect: clear the stored key.
      await env.DB.prepare(
        `INSERT INTO email_config (id, api_key, from_address, configured_at, configured_by)
         VALUES (?, NULL, NULL, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET api_key = NULL, from_address = NULL, configured_at = NULL, configured_by = NULL`
      ).bind(ws).run();
      return c.json({ ok: true, configured: false });
    }

    if (!apiKey.startsWith('re_')) {
      return c.json({ ok: false, error: 'invalid_key', message: 'API Key 應以 re_ 開頭（Resend API Key）' }, 400);
    }
    // Accept "user@domain" or "Name <user@domain>".
    if (!fromAddress || !/^[^<>]*<?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(fromAddress)) {
      return c.json({ ok: false, error: 'invalid_from', message: '請填寫寄件人位址（例：LIVO <notify@your-domain.com>）' }, 400);
    }

    // Validate against Resend before persisting (200 = key is live).
    const test = await fetch(`${RESEND_API}/domains`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!test.ok) {
      return c.json(
        { ok: false, error: 'auth_failed', message: `Resend 驗證失敗（HTTP ${test.status}）：請確認 API Key 正確且未被撤銷` },
        400
      );
    }

    await env.DB.prepare(
      `INSERT INTO email_config (id, api_key, from_address, configured_at, configured_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET api_key = excluded.api_key, from_address = excluded.from_address,
         configured_at = excluded.configured_at, configured_by = excluded.configured_by`
    )
      .bind(ws, apiKey, fromAddress, new Date().toISOString(), auth?.member?.id ?? null)
      .run();

    return c.json({ ok: true, configured: true, fromAddress });
  } catch (e) {
    console.error('[email-config] error:', e);
    return c.json({ ok: false, error: 'server_error', message: String(e) }, 500);
  }
}
