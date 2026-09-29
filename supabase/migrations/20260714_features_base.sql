-- ============================================================
-- Migration: Feature-base tables — time tracking / email notify /
--            API tokens / webhooks (self-host parity with worker schema)
-- Date: 2026-07-14
-- All statements idempotent. RLS:
--   time_entries    → own-rows floor (member sees/edits own; admin+ all)
--   email_config    → server-only (RLS on, zero policies — like slack_config)
--   api_tokens      → server-only
--   webhook_configs → server-only (secret must never reach clients)
-- ============================================================

-- ── time_entries ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.time_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    text NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  member_id  text NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  minutes    integer NOT NULL DEFAULT 0,
  note       text NOT NULL DEFAULT '',
  entry_date date NOT NULL,
  started_at timestamptz,
  ended_at   timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_time_entries_task ON public.time_entries (task_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_member_date ON public.time_entries (member_id, entry_date);

ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "te_select" ON public.time_entries;
CREATE POLICY "te_select" ON public.time_entries
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "te_insert" ON public.time_entries;
CREATE POLICY "te_insert" ON public.time_entries
  FOR INSERT TO authenticated
  WITH CHECK (is_livo_admin() OR member_id = current_member_id());

DROP POLICY IF EXISTS "te_update" ON public.time_entries;
CREATE POLICY "te_update" ON public.time_entries
  FOR UPDATE TO authenticated
  USING (is_livo_admin() OR member_id = current_member_id());

DROP POLICY IF EXISTS "te_delete" ON public.time_entries;
CREATE POLICY "te_delete" ON public.time_entries
  FOR DELETE TO authenticated
  USING (is_livo_admin() OR member_id = current_member_id());

-- ── email_config（客戶自綁 Resend key；server-only）─────────
CREATE TABLE IF NOT EXISTS public.email_config (
  id            text PRIMARY KEY DEFAULT 'singleton',
  api_key       text,
  from_address  text,
  configured_at timestamptz,
  configured_by text
);
ALTER TABLE public.email_config ENABLE ROW LEVEL SECURITY;
-- no policies on purpose: only service_role (edge functions) may touch it

-- ── api_tokens（PAT；server-only）────────────────────────────
CREATE TABLE IF NOT EXISTS public.api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  member_id    text NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;

-- ── webhook_configs（secret server-only）─────────────────────
CREATE TABLE IF NOT EXISTS public.webhook_configs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url          text NOT NULL,
  events       jsonb NOT NULL DEFAULT '["task_created","task_updated","task_deleted","comment_added"]'::jsonb,
  secret       text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_status  text,
  last_sent_at timestamptz
);
ALTER TABLE public.webhook_configs ENABLE ROW LEVEL SECURITY;

-- ── user_notification_preferences：email 通知欄位 ───────────
ALTER TABLE public.user_notification_preferences
  ADD COLUMN IF NOT EXISTS email_notify_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.user_notification_preferences
  ADD COLUMN IF NOT EXISTS email_notify_types jsonb NOT NULL DEFAULT '["assigned","mentioned","due_soon"]'::jsonb;
