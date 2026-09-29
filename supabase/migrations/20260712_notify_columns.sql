-- ============================================================
-- Migration: Slack DM notify-window columns on backup_settings
-- Date: 2026-07-12
-- Description: slack-notify (edge function) SELECTs dm_notify_enabled /
--   dm_notify_start_hour / dm_notify_end_hour; without these columns
--   PostgREST rejects the select and every Slack notification 500s on a
--   fresh self-host install. Mirrors worker/schema.sql (D1) defaults.
-- ============================================================

ALTER TABLE public.backup_settings ADD COLUMN IF NOT EXISTS dm_notify_enabled    boolean NOT NULL DEFAULT true;
ALTER TABLE public.backup_settings ADD COLUMN IF NOT EXISTS dm_notify_start_hour integer NOT NULL DEFAULT 0;
ALTER TABLE public.backup_settings ADD COLUMN IF NOT EXISTS dm_notify_end_hour   integer NOT NULL DEFAULT 24;
