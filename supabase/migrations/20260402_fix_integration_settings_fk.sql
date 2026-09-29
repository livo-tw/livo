-- 20260402_fix_integration_settings_fk.sql
-- 修正 team_settings.updated_by 欄位型別：UUID → TEXT
-- members.id 為 TEXT 型別，原欄位使用 uuid 導致外鍵型別不匹配

-- 先移除舊的外鍵約束
ALTER TABLE team_settings DROP CONSTRAINT IF EXISTS team_settings_updated_by_fkey;

-- 將 updated_by 欄位型別從 uuid 改為 text
ALTER TABLE team_settings ALTER COLUMN updated_by TYPE text USING updated_by::text;

-- 重新建立正確的外鍵約束（TEXT 對 TEXT）
ALTER TABLE team_settings
  ADD CONSTRAINT team_settings_updated_by_fkey
  FOREIGN KEY (updated_by) REFERENCES members(id) ON DELETE SET NULL;
