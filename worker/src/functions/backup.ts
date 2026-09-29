// Port of the scheduled-backup Edge Function (supabase/functions/scheduled-backup).
// - POST /api/functions/scheduled-backup (requireMember ran; body {manual:true})
// - runScheduledBackup(env, ctx): hourly cron entrypoint with the original
//   backup_settings self-gating (enabled / backup_hour TW / interval_days).
// Both paths are gated on a professional license, verified locally against
// system_settings key='license' + env.LICENSE_SECRET (no dependency on rpc.ts).

import type { Context } from 'hono';
import type { Ctx, Env, AppContext } from '../env';
import { DEFAULT_WORKSPACE } from '../env';
import { TABLES } from '../tables';
import { rowToWire, nowIso, type TableMeta } from '../meta';
import { checkLicense, checkProfessional } from '../license';
import { resolveSlackToken } from './slack';

// Exact table list from the original function (19 tables).
const BACKUP_TABLES = [
  'tasks', 'members', 'projects', 'statuses', 'sprints',
  'product_lines', 'comments', 'task_specs', 'task_checks',
  'task_todos', 'status_logs', 'task_deployments',
  'member_manuals', 'notifications', 'backup_settings',
  'activity_logs', 'task_attachments', 'user_column_configs', 'profiles',
] as const;

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FALLBACK_META: TableMeta = { pk: 'id', clientAccess: 'full' };

interface BackupSettingsRow {
  enabled?: number | null;
  backup_hour?: number | null;
  interval_days?: number | null;
  last_backup_at?: string | null;
  notify_channel?: string | null;
  [k: string]: unknown;
}

interface BackupResult {
  success: true;
  filename: string;
  totalRecords: number;
  fileSize: number;
  slackNotified: boolean;
}

// ── Core backup ───────────────────────────────────────────────────────────

async function performBackup(env: Env, ws: string, isManual: boolean): Promise<BackupResult> {
  const backup: Record<string, Record<string, unknown>[]> = {};
  for (const table of BACKUP_TABLES) {
    if (!IDENT_RE.test(table)) continue; // defense in depth (list is static)
    const meta = TABLES[table] ?? FALLBACK_META;
    // Tenancy: a backup contains ONLY the requesting workspace's rows.
    const res = await env.DB.prepare(`SELECT * FROM ${table} WHERE workspace_id = ?1`)
      .bind(ws)
      .all<Record<string, unknown>>();
    backup[table] = (res.results || []).map((r) => rowToWire(r, meta));
  }

  const jsonContent = JSON.stringify(backup, null, 2);
  const now = new Date();
  const p2 = (v: number) => String(v).padStart(2, '0');
  const filename =
    `backup_${now.getUTCFullYear()}${p2(now.getUTCMonth() + 1)}${p2(now.getUTCDate())}` +
    `_${p2(now.getUTCHours())}${p2(now.getUTCMinutes())}${p2(now.getUTCSeconds())}.json`;

  const bytes = new TextEncoder().encode(jsonContent);
  const fileSize = bytes.byteLength;
  const totalRecords = Object.values(backup).reduce((sum, arr) => sum + arr.length, 0);

  // Tenants live under their own R2 prefix; storage_path stores the wire path
  // the frontend downloads with (it passes storage.ts's per-ws prefix check).
  const storagePath = ws === DEFAULT_WORKSPACE ? filename : `ws/${ws}/${filename}`;
  await env.ATTACHMENTS.put(`backups/${storagePath}`, bytes, {
    httpMetadata: { contentType: 'application/json' },
  });

  await env.DB
    .prepare(
      'INSERT INTO backup_history (workspace_id, id, filename, file_size, storage_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    )
    .bind(ws, crypto.randomUUID(), filename, fileSize, storagePath, nowIso())
    .run();

  // Scheduled runs (not manual) record last_backup_at on every settings row
  // OF THIS WORKSPACE (original used .not('id','is',null) i.e. all rows).
  if (!isManual) {
    await env.DB
      .prepare('UPDATE backup_settings SET last_backup_at = ?1 WHERE workspace_id = ?2')
      .bind(now.toISOString(), ws)
      .run();
  }

  const slackNotified = await sendSlackNotification(env, ws, backup, filename, fileSize, totalRecords, now);

  return { success: true, filename, totalRecords, fileSize, slackNotified };
}

// ── Slack notify (direct Slack Web API; silently skipped when unconfigured) ──

async function sendSlackNotification(
  env: Env,
  ws: string,
  backup: Record<string, Record<string, unknown>[]>,
  filename: string,
  fileSize: number,
  totalRecords: number,
  now: Date
): Promise<boolean> {
  try {
    const settings = await env.DB
      .prepare('SELECT notify_channel FROM backup_settings WHERE workspace_id = ?1 LIMIT 1')
      .bind(ws)
      .first<{ notify_channel: string | null }>();
    const notifyChannel = settings?.notify_channel;
    const slackToken = await resolveSlackToken(env, ws);
    if (!notifyChannel || !slackToken) return false;

    const authHeaders = { Authorization: `Bearer ${slackToken}` };

    // Always resolve the channel by listing conversations (original behavior).
    let resolvedChannel = notifyChannel;
    const channelName = notifyChannel.replace(/^#/, '');
    const listResp = await fetch(
      'https://slack.com/api/conversations.list?limit=200&exclude_archived=true',
      { method: 'GET', headers: authHeaders }
    );
    const listData = (await listResp.json()) as {
      ok?: boolean;
      channels?: { id: string; name: string }[];
    };
    if (listData.ok && listData.channels) {
      const found = listData.channels.find((ch) => ch.name === channelName || ch.id === notifyChannel);
      if (found) resolvedChannel = found.id;
      else console.error('[backup] Slack channel not found:', notifyChannel);
    } else {
      console.error('[backup] conversations.list failed:', JSON.stringify(listData));
    }

    const fileSizeStr =
      fileSize < 1024 ? `${fileSize} B`
      : fileSize < 1024 * 1024 ? `${(fileSize / 1024).toFixed(1)} KB`
      : `${(fileSize / (1024 * 1024)).toFixed(1)} MB`;

    const tableSummary = Object.entries(backup)
      .filter(([, rows]) => rows.length > 0)
      .map(([name, rows]) => `• ${name}: ${rows.length} 筆`)
      .join('\n');

    const message = [
      `✅ *系統備份完成*`,
      ``,
      `📁 檔案：\`${filename}\``,
      `📊 總資料量：${totalRecords} 筆`,
      `💾 檔案大小：${fileSizeStr}`,
      `🕐 時間：${new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0]} (台灣時間)`,
      ``,
      `*各表格明細：*`,
      tableSummary,
    ].join('\n');

    const postResp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: resolvedChannel,
        text: message,
        username: 'PM 系統備份',
        icon_emoji: ':floppy_disk:',
      }),
    });
    const postData = (await postResp.json()) as { ok?: boolean; error?: string };
    if (!postData.ok) {
      console.error('[backup] Slack error:', postData.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[backup] Slack notification error:', err);
    return false;
  }
}

// ── Manual endpoint (POST /api/functions/scheduled-backup) ───────────────

export const handleBackup = async (c: Context<AppContext>): Promise<Response> => {
  try {
    let isManual = false;
    try {
      const body = (await c.req.json()) as { manual?: unknown };
      isManual = body?.manual === true;
    } catch {
      // no body / invalid JSON — treated as scheduled (original behavior)
    }

    const ws = c.get('auth')?.member?.workspaceId || DEFAULT_WORKSPACE;

    // Tier gate (contract C3): manual JSON/backup export is allowed for ANY
    // paid license (standard OR professional); the scheduled path (self-gating
    // auto-backup) stays professional-only. Cloud-beta workspaces carry a
    // minted PRO license from provisioning, so both paths pass for them.
    if (isManual) {
      const { tier } = await checkLicense(c.env, ws);
      if (tier === 'none') {
        return c.json(
          { error: 'license_required', message: '此功能需要有效授權。請聯繫 service@livo-tw.com。' },
          403
        );
      }
    } else {
      if (!(await checkProfessional(c.env, ws))) {
        return c.json(
          { error: 'license_required', message: '此功能需要專業版授權。請聯繫 service@livo-tw.com 升級。' },
          403
        );
      }
      const skip = await scheduledGate(c.env, ws);
      if (skip) return c.json(skip);
    }

    const result = await performBackup(c.env, ws, isManual);
    return c.json(result);
  } catch (err) {
    console.error('[backup] error:', err);
    return c.json({ error: String(err) }, 500);
  }
};

// ── Scheduled gating (original backup_settings logic) ────────────────────

async function scheduledGate(env: Env, ws: string): Promise<{ skipped: true; reason: string } | null> {
  const settings = await env.DB
    .prepare('SELECT * FROM backup_settings WHERE workspace_id = ?1 LIMIT 1')
    .bind(ws)
    .first<BackupSettingsRow>();

  console.log(
    '[backup] settings:',
    JSON.stringify({
      enabled: settings?.enabled,
      backup_hour: settings?.backup_hour,
      interval_days: settings?.interval_days,
      last_backup_at: settings?.last_backup_at,
    })
  );

  if (!settings || !settings.enabled) {
    return { skipped: true, reason: 'Backup not enabled' };
  }

  const now = new Date();
  const currentHourUTC = now.getUTCHours();
  const backupHourTW = settings.backup_hour ?? 3;
  const backupHourUTC = (backupHourTW - 8 + 24) % 24;

  if (currentHourUTC !== backupHourUTC) {
    return {
      skipped: true,
      reason: `Not backup hour. Current UTC: ${currentHourUTC}, configured TW: ${backupHourTW} (UTC: ${backupHourUTC})`,
    };
  }

  if (settings.last_backup_at) {
    const lastBackup = new Date(settings.last_backup_at);
    const diffHours = (now.getTime() - lastBackup.getTime()) / (1000 * 60 * 60);
    const minIntervalHours = Math.max((settings.interval_days || 1) * 24 - 2, 12);
    if (diffHours < minIntervalHours) {
      return {
        skipped: true,
        reason: `Not yet due. Last: ${diffHours.toFixed(1)}h ago, interval: ${minIntervalHours}h`,
      };
    }
  }

  return null;
}

// ── Cron entrypoint (hourly; called from index.ts scheduled()) ───────────

export async function runScheduledBackup(env: Env, _ctx: Ctx): Promise<void> {
  try {
    // Tenancy: one pass per workspace that has auto-backup enabled. Each
    // workspace self-gates on its own license, hour and interval, and a
    // failure in one workspace never blocks the others.
    const wsRes = await env.DB
      .prepare('SELECT DISTINCT workspace_id FROM backup_settings WHERE enabled = 1')
      .all<{ workspace_id: string | null }>();
    for (const row of wsRes.results || []) {
      const ws = row.workspace_id || DEFAULT_WORKSPACE;
      try {
        if (!(await checkProfessional(env, ws))) {
          console.log(`[backup] cron(${ws}): professional license required, skipping`);
          continue;
        }
        const skip = await scheduledGate(env, ws);
        if (skip) {
          console.log(`[backup] cron(${ws}) skipped:`, skip.reason);
          continue;
        }
        const result = await performBackup(env, ws, false);
        console.log(`[backup] cron(${ws}) done:`, result.filename, result.totalRecords, 'records');
      } catch (err) {
        console.error(`[backup] cron(${ws}) error:`, err);
      }
    }
  } catch (err) {
    console.error('[backup] cron error:', err);
  }
}
