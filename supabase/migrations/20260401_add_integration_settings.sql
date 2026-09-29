-- 20260401_add_integration_settings.sql
-- 第三方服務整合設定，複用 team_settings 表
-- 此檔案確認 team_settings 表存在後插入預設整合設定

-- 確保 team_settings 表存在（若 20260401_team_settings.sql 先執行則已存在）
-- updated_by 必須是 text：members.id 是 TEXT。這檔在字母序上先於
-- 20260401_team_settings.sql 執行，全新合併安裝以這裡的定義為準——
-- 寫成 uuid 會讓 FK 型別不符、整個 schema 建立中斷（20260402 的修復檔
-- 因 ON_ERROR_STOP 根本執行不到）。
CREATE TABLE IF NOT EXISTS team_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}',
  updated_by text REFERENCES members(id) ON DELETE SET NULL,
  updated_at timestamptz DEFAULT now()
);

-- Slack 整合預設設定
INSERT INTO team_settings (key, value, updated_at)
VALUES (
  'integration_slack',
  jsonb_build_object(
    'enabled', false,
    'webhookUrl', '',
    'channel', '#general',
    'events', jsonb_build_array('task_created', 'status_changed', 'comment_added')
  ),
  now()
)
ON CONFLICT (key) DO NOTHING;

-- Webhook 整合預設設定
INSERT INTO team_settings (key, value, updated_at)
VALUES (
  'integration_webhook',
  jsonb_build_object(
    'enabled', false,
    'url', '',
    'secret', '',
    'events', jsonb_build_array('task_created', 'status_changed', 'task_completed')
  ),
  now()
)
ON CONFLICT (key) DO NOTHING;

-- Email 通知預設設定
INSERT INTO team_settings (key, value, updated_at)
VALUES (
  'integration_email',
  jsonb_build_object(
    'enabled', false,
    'smtpHost', '',
    'smtpPort', 587,
    'smtpUser', '',
    'smtpPassword', '',
    'fromName', 'LIVO',
    'fromEmail', '',
    'events', jsonb_build_array('task_assigned', 'due_soon', 'mentioned')
  ),
  now()
)
ON CONFLICT (key) DO NOTHING;

-- GitLab 整合預設設定
INSERT INTO team_settings (key, value, updated_at)
VALUES (
  'integration_gitlab',
  jsonb_build_object(
    'enabled', false,
    'url', 'https://gitlab.com',
    'accessToken', '',
    'projectId', ''
  ),
  now()
)
ON CONFLICT (key) DO NOTHING;

-- 日曆同步預設設定
INSERT INTO team_settings (key, value, updated_at)
VALUES (
  'integration_calendar',
  jsonb_build_object(
    'enabled', false,
    'provider', 'google',
    'calendarId', '',
    'syncDueDates', true,
    'syncStartDates', false
  ),
  now()
)
ON CONFLICT (key) DO NOTHING;
