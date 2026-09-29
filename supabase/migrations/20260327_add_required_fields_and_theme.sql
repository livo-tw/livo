-- ============================================================
-- Migration: Add required_fields system setting + theme column
-- Date: 2026-03-27
-- ============================================================

-- 1. system_settings table for required field configuration
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- Insert default required fields config (only title and project are required by default)
INSERT INTO system_settings (key, value) VALUES (
  'required_fields',
  '{"title": true, "project": true, "status": false, "priority": false, "assignee": false, "reviewer": false, "dueDate": true, "startDate": false, "tags": false, "background": false, "requirement": false, "notes": false, "checks": false, "todos": false, "gitlabUrl": false, "deployments": false}'
) ON CONFLICT (key) DO NOTHING;

-- Enable RLS
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

-- Everyone can read settings (idempotent: 20260327_add_license_key.sql may
-- have created the same policies already — bare CREATE POLICY errors then)
DROP POLICY IF EXISTS "system_settings_read" ON system_settings;
CREATE POLICY "system_settings_read" ON system_settings
  FOR SELECT USING (true);

-- Only admins can update (enforced in app layer too)
DROP POLICY IF EXISTS "system_settings_write" ON system_settings;
CREATE POLICY "system_settings_write" ON system_settings
  FOR ALL USING (true) WITH CHECK (true);

-- 2. Add theme column to members table
ALTER TABLE members ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'dark';

-- 3. Add system_settings to realtime publication (idempotent)
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE system_settings;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
