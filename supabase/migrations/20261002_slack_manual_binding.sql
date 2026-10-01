-- ============================================================================
-- Migration: 20261002_slack_manual_binding.sql
-- Admin-assigned Slack accounts, for members whose Slack email differs from
-- their LIVO email (personal Slack address, an alias, …).
--
-- verified_by records how the server verified a Slack binding:
--   'email' — the Slack profile email matched one active LIVO member
--   'admin' — an admin assigned this Slack user to the member in LIVO's Slack
--             settings (slack-actions-config, action "bind")
-- slack-interact trusts an 'admin' binding instead of comparing emails.
-- Members cannot write Slack binding rows (livo_guard_slack_binding from
-- 20261002_slack_actions.sql), so only the server sets this column. Rows that
-- existed before it have NULL and are never treated as admin-assigned.
--
-- Idempotent (re-runnable): part of the merged schema on fresh installs, and
-- applied by the installer's upgrade step on existing installs.
-- ============================================================================

ALTER TABLE public.external_account_bindings ADD COLUMN IF NOT EXISTS verified_by text;

ALTER TABLE public.external_account_bindings DROP CONSTRAINT IF EXISTS external_account_bindings_verified_by_check;
ALTER TABLE public.external_account_bindings ADD CONSTRAINT external_account_bindings_verified_by_check
  CHECK (verified_by IS NULL OR verified_by IN ('email', 'admin'));
