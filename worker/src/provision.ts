// Cloud-beta workspace provisioning (CLOUD-BETA-DESIGN.md).
//
// A brand-new workspace needs the structural rows the frontend assumes exist
// (the 空庫首跑 problem): 7 statuses, one backup_settings row, the 4
// system_settings keys (the license row stays empty: there are no keys),
// the 9 default notification templates and the 5 disabled integration rows.
// Row ids repeat per workspace in seed.sql, so every id here is prefixed with
// the workspace's first 8 uuid chars to stay globally unique (statuses etc.
// keep single-column PKs).
//
// All statements are returned unexecuted so the signup handler can run
// workspace + auth user + member + defaults as ONE atomic env.DB.batch —
// a half-provisioned workspace can never exist.

import type { Env } from './env';
import { nowIso } from './meta';

// seed.sql statuses (semantic invariants: exactly one auto_start=1, done
// statuses have is_done=1, lowest sort_order = first column).
const STATUSES: Array<[string, string, string, number, number, number, number]> = [
  ['s1', '待辦', '#6B778C', 1, 0, 0, 0],
  ['s2', '正在進行', '#0065FF', 2, 0, 1, 0],
  ['s3', '待驗收', '#FF8B00', 3, 0, 0, 0],
  ['s4', '待討論確認', '#6554C0', 4, 0, 0, 0],
  ['s5', '等待部署', '#00B8D9', 5, 0, 0, 0],
  ['s6', '完成', '#36B37E', 6, 1, 0, 1],
  ['s7', '不做了', '#97A0AF', 7, 1, 0, 1],
];

// seed.sql required_fields — must stay in sync with DEFAULT_REQUIRED_FIELDS
// in src/context/UIContext.tsx.
const REQUIRED_FIELDS_JSON =
  '{"title": true, "project": true, "status": false, "priority": false, "assignee": false, "reviewer": false, "dueDate": true, "startDate": false, "tags": false, "background": false, "requirement": false, "notes": false, "checks": false, "todos": false, "gitlabUrl": false, "deployments": false}';

// seed.sql notification templates (name is unique per workspace).
const TEMPLATES: Array<[string, string, string, string, string]> = [
  ['ntpl-001', '新建任務通知', 'task_created', '📋 新任務建立：{{task_name}}｜指派：{{assignee}}｜到期：{{due_date}}｜{{description_summary}}', 'neutral'],
  ['ntpl-002', '狀態變更通知', 'status_changed', '🔄 「{{task_name}}」狀態從「{{prev_status}}」變更為「{{status}}」｜負責人：{{assignee}}', 'neutral'],
  ['ntpl-003', '指派變更通知', 'assignee_changed', '👋 {{assignee}}，你被指派了新任務：「{{task_name}}」｜到期：{{due_date}}', 'friendly'],
  ['ntpl-004', '到期提醒', 'due_reminder', '⚠️ 提醒：「{{task_name}}」明天到期｜負責人：{{assignee}}', 'warning'],
  ['ntpl-005', '任務逾期警告', 'overdue', '🚨 「{{task_name}}」已逾期 {{overdue_days}} 天！｜負責人：{{assignee}}', 'urgent'],
  ['ntpl-006', '請求簽核', 'approval_requested', '⏳ 「{{task_name}}」需要你的簽核｜請盡快處理', 'urgent'],
  ['ntpl-007', '簽核完成', 'approval_completed', '✅ 「{{task_name}}」簽核已完成｜簽核人：{{approver}}', 'celebration'],
  ['ntpl-008', '新增評論通知', 'comment_added', '💬 「{{task_name}}」有新評論｜來自 {{reporter}}', 'neutral'],
  ['ntpl-009', '自定義通知', 'custom', '📢 {{task_name}}', 'neutral'],
];

// seed.sql integration_* team_settings (shape-compatible with the frontend
// DEFAULT_* constants in src/components/integrations/constants.ts).
const INTEGRATIONS: Array<[string, string]> = [
  ['integration_slack', '{"enabled": false, "webhookUrl": "", "channel": "#general", "events": ["task_created", "status_changed", "comment_added"]}'],
  ['integration_webhook', '{"enabled": false, "url": "", "secret": "", "events": ["task_created", "status_changed", "task_completed"]}'],
  ['integration_email', '{"enabled": false, "smtpHost": "", "smtpPort": 587, "smtpUser": "", "smtpPassword": "", "fromName": "LIVO", "fromEmail": "", "events": ["task_assigned", "due_soon", "mentioned"]}'],
  ['integration_gitlab', '{"enabled": false, "url": "https://gitlab.com", "accessToken": "", "projectId": ""}'],
  ['integration_calendar', '{"enabled": false, "provider": "google", "calendarId": "", "syncDueDates": true, "syncStartDates": false}'],
];

/** Unexecuted statements that seed a new workspace's structural defaults. */
export async function workspaceProvisionStatements(
  env: Env,
  wsId: string,
  wsName: string,
  ownerEmail: string
): Promise<D1PreparedStatement[]> {
  const now = nowIso();
  const short = wsId.slice(0, 8);
  const stmts: D1PreparedStatement[] = [];

  stmts.push(
    env.DB.prepare(
      'INSERT INTO workspaces (id, name, plan, owner_email, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(wsId, wsName, 'beta', ownerEmail.toLowerCase(), now)
  );

  for (const [sid, name, color, sort, isDone, autoStart, autoDone] of STATUSES) {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO statuses (workspace_id, id, name, color, sort_order, is_done, auto_start, auto_done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(wsId, `${short}-${sid}`, name, color, sort, isDone, autoStart, autoDone)
    );
  }

  stmts.push(
    env.DB.prepare(
      'INSERT INTO backup_settings (workspace_id, id, enabled, interval_days, backup_hour) VALUES (?, ?, 0, 7, 3)'
    ).bind(wsId, `bset-${short}`)
  );

  const installationId = crypto.randomUUID();
  const licenseValue = '{}';
  const sysSettings: Array<[string, string]> = [
    ['required_fields', REQUIRED_FIELDS_JSON],
    ['required_custom_fields', '[]'],
    ['installation_id', JSON.stringify(installationId)],
    ['license', licenseValue],
  ];
  for (const [key, value] of sysSettings) {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO system_settings (workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?)'
      ).bind(wsId, key, value, now)
    );
  }

  for (const [tid, name, eventType, content, tone] of TEMPLATES) {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO notification_templates (workspace_id, id, name, event_type, template_content, tone, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)'
      ).bind(wsId, `${short}-${tid}`, name, eventType, content, tone, now, now)
    );
  }

  for (const [key, value] of INTEGRATIONS) {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO team_settings (workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?)'
      ).bind(wsId, key, value, now)
    );
  }

  return stmts;
}
