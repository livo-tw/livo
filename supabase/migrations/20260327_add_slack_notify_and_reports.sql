-- ============================================================
-- Migration: user_notification_preferences + user_report_configs
-- Date: 2026-03-27
-- Description:
--   1. 个人 Slack 定期推播设定（提醒待办/待验收）
--   2. 自动日报/周报汇整设定（模板、范围、频道）
-- ============================================================

-- 1. User notification preferences (Slack digest)
CREATE TABLE IF NOT EXISTS user_notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  frequency TEXT NOT NULL DEFAULT 'daily',       -- 'daily' | 'weekly'
  weekday INT NOT NULL DEFAULT 1,                -- 0=Sun..6=Sat (only used when frequency='weekly')
  hour INT NOT NULL DEFAULT 9,                   -- 0-23
  include_assigned BOOLEAN NOT NULL DEFAULT true,
  include_review BOOLEAN NOT NULL DEFAULT true,
  last_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_notification_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "unp_select" ON user_notification_preferences FOR SELECT USING (true);
CREATE POLICY "unp_all" ON user_notification_preferences FOR ALL USING (true) WITH CHECK (true);

-- 2. User report configs (auto daily/weekly report)
CREATE TABLE IF NOT EXISTS user_report_configs (
  id TEXT PRIMARY KEY DEFAULT ('urc_' || extract(epoch from now())::bigint || '_' || substr(md5(random()::text), 1, 6)),
  user_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL DEFAULT 'daily',     -- 'daily' | 'weekly'
  enabled BOOLEAN NOT NULL DEFAULT false,
  hour INT NOT NULL DEFAULT 17,                  -- 0-23
  minute INT NOT NULL DEFAULT 30,                -- 0-59
  weekday INT NOT NULL DEFAULT 5,                -- 0=Sun..6=Sat (only used for weekly)
  template_key TEXT NOT NULL DEFAULT 'default_daily', -- 'default_daily' | 'default_weekly' | 'custom'
  custom_template TEXT,                          -- user's custom template with {{variables}}
  scope TEXT NOT NULL DEFAULT 'assigned_to_me',  -- 'assigned_to_me' | 'my_projects' | 'specific_projects'
  scope_project_ids TEXT[],                      -- project IDs when scope='specific_projects'
  send_target TEXT NOT NULL DEFAULT 'dm',        -- 'dm' | 'channel'
  send_channel TEXT,                             -- Slack channel name/ID when send_target='channel'
  last_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, report_type)
);

ALTER TABLE user_report_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "urc_select" ON user_report_configs FOR SELECT USING (true);
CREATE POLICY "urc_all" ON user_report_configs FOR ALL USING (true) WITH CHECK (true);
