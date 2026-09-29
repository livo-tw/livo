-- Cloud-beta tenancy migration for PRE-EXISTING DBs (see CLOUD-BETA-DESIGN.md).
-- Fresh DBs get the final shape straight from schema.sql and never run this.
-- Runner: migrate/apply-tenant-alters.mjs (sentinel = tasks.workspace_id, LAST).

ALTER TABLE members ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE profiles ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE product_lines ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE projects ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE statuses ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE sprints ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE task_deployments ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE task_specs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE task_checks ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE task_todos ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE comments ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE status_logs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE notifications ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE member_manuals ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE tags ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE task_tags ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE backup_settings ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE backup_history ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE task_attachments ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE user_column_configs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE activity_logs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE user_notification_preferences ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE user_report_configs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE custom_fields ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE task_custom_field_values ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE task_dependencies ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE task_templates ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE work_reports ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE user_board_prefs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE status_transition_rules ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE approval_rules ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE approval_rule_steps ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE approval_requests ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE approval_actions ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE external_account_bindings ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE external_action_logs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE slack_thread_mappings ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE interaction_tokens ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE report_send_targets ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE report_send_logs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE notification_templates ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE notification_rules ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE notification_delivery_logs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE due_date_reminders ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE standup_sessions ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE standup_member_durations ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE time_entries ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE api_tokens ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE webhook_configs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';

-- notification_templates: per-workspace template names
DROP INDEX IF EXISTS uq_notification_templates_name;

-- system_settings: PK key → (workspace_id, key)
CREATE TABLE IF NOT EXISTS system_settings_v2 (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  key        TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  PRIMARY KEY (workspace_id, key)
);
INSERT OR IGNORE INTO system_settings_v2 (workspace_id, key, value, updated_at, updated_by) SELECT 'default', key, value, updated_at, updated_by FROM system_settings;
DROP TABLE IF EXISTS system_settings;
ALTER TABLE system_settings_v2 RENAME TO system_settings;

-- team_settings: PK key → (workspace_id, key)
CREATE TABLE IF NOT EXISTS team_settings_v2 (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  key        TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT REFERENCES members(id) ON DELETE SET NULL,
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (workspace_id, key)
);
INSERT OR IGNORE INTO team_settings_v2 (workspace_id, key, value, updated_by, updated_at) SELECT 'default', key, value, updated_by, updated_at FROM team_settings;
DROP TABLE IF EXISTS team_settings;
ALTER TABLE team_settings_v2 RENAME TO team_settings;

-- field_locks: ephemeral (30s TTL locks) — recreate with composite PK
DROP TABLE IF EXISTS field_locks;
CREATE TABLE IF NOT EXISTS field_locks (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  lock_key   TEXT NOT NULL,
  locked_by  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, lock_key)
);
CREATE INDEX IF NOT EXISTS idx_field_locks_expires ON field_locks (expires_at);
CREATE INDEX IF NOT EXISTS idx_field_locks_locked_by ON field_locks (locked_by);

-- slack_config / email_config: row id becomes the workspace id
UPDATE slack_config SET id='default' WHERE id='singleton';
UPDATE email_config SET id='default' WHERE id='singleton';

-- SENTINEL — keep LAST (apply-tenant-alters.mjs probes this column)
ALTER TABLE tasks ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';
