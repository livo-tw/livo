-- ============================================================
-- Migration: Add license key support to system_settings
-- Date: 2026-03-27
-- Description: Ensures system_settings table can store license key.
--              No new tables needed — license is stored as:
--              key='license', value='{"key": "LIVO-PRO-99999999-xxxxxxxx"}'
-- ============================================================

-- Ensure system_settings table exists (idempotent)
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- Ensure RLS is enabled
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

-- Ensure read policy exists (idempotent — won't error if exists)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'system_settings' AND policyname = 'system_settings_read') THEN
    CREATE POLICY "system_settings_read" ON system_settings FOR SELECT USING (true);
  END IF;
END $$;

-- Ensure write policy exists
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'system_settings' AND policyname = 'system_settings_write') THEN
    CREATE POLICY "system_settings_write" ON system_settings FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Insert default empty license (won't overwrite if already set)
INSERT INTO system_settings (key, value) VALUES ('license', '{}')
ON CONFLICT (key) DO NOTHING;
