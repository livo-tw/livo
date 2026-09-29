-- ============================================================
-- Migration: Add installation_id support for license binding
-- Date: 2026-03-27
-- Description: Ensures system_settings has an installation_id row
--              for license key server binding mechanism.
-- ============================================================

-- Ensure system_settings table exists (idempotent)
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- Insert default installation_id placeholder (will be populated on first license activation)
INSERT INTO system_settings (key, value) VALUES ('installation_id', '""')
ON CONFLICT (key) DO NOTHING;
