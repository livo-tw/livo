-- ============================================================
-- Migration: 20260712_slack_config.sql
-- Date: 2026-07-12
-- Description:
--   Server-only Slack bot-token store for the self-host (Docker) build.
--   A self-host customer binds their OWN Slack workspace from the app UI
--   (系統管理 → 通知 / SlackCard) instead of editing env. The bot token lives
--   here in a single row (id='singleton') and is read ONLY by the service-role
--   Edge Functions (slack-notify / slack-channels / slack-digest / slack-config).
--   Mirrors worker/schema.sql's slack_config (Cloudflare build).
--
--   Token resolution order (see _shared/slack.ts → resolveSlackToken):
--     1. slack_config.bot_token  (app-bound token, wins)
--     2. env SLACK_BOT_TOKEN     (instance-level secret, fallback)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.slack_config (
  id            text PRIMARY KEY DEFAULT 'singleton',
  bot_token     text,        -- xoxb-… ; server-only, NEVER returned to clients
  team_name     text,        -- from Slack auth.test, shown to admin as 已連線: {team}
  configured_at timestamptz,
  configured_by text         -- member id who set it
);

-- RLS: only the service-role (Edge Functions) may touch this table.
-- The bot token must NEVER be selectable by the anon / authenticated roles.
-- Enabling RLS with NO permissive policy denies all access to those roles;
-- the service_role key used by Edge Functions bypasses RLS. Same pattern as the
-- orders table in 20260331_create_orders.sql (also a server-only secrets table).
ALTER TABLE public.slack_config ENABLE ROW LEVEL SECURITY;

-- No policies = no access for anon / authenticated users (neither read nor write).
-- Edge Functions use the service_role key which bypasses RLS.
