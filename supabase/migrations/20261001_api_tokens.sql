-- ============================================================================
-- Migration: 20261001_api_tokens.sql
-- Personal API keys (personal access tokens, PAT) for the self-host
-- (Docker/Supabase) build — parity with the Cloudflare build's api_tokens
-- table (worker/schema.sql).
--
-- The table itself was laid down ahead of the feature in
-- 20260714_features_base.sql; the api-tokens edge function (docker/volumes/
-- functions/api-tokens) now uses it: the plain key (livo_pat_…) is shown
-- exactly once on creation and only its sha256 is stored here. A script
-- trades the key for a short-lived login JWT of the bound member
-- (POST /functions/v1/api-tokens/exchange) and then works through PostgREST
-- under the normal RLS.
--
-- This migration completes the table for every install:
--   * creates it where 20260714_features_base.sql never ran (same definition);
--   * server-only access: RLS on with ZERO policies, plus the table privileges
--     revoked from anon / authenticated — only the service role (edge
--     functions) can read or write it;
--   * an index for the per-member lookups.
-- created_by is a members.id, or 'service_role' for keys created with the
-- service-role key.
--
-- Idempotent (re-runnable): part of the merged schema on fresh installs, and
-- applied by the installer's upgrade step on existing installs.
-- ============================================================================

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

CREATE INDEX IF NOT EXISTS idx_api_tokens_member_id ON public.api_tokens (member_id);

ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: anon / authenticated get nothing.
REVOKE ALL ON TABLE public.api_tokens FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_tokens TO service_role;
