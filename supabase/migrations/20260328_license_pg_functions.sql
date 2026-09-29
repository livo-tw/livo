-- ============================================================
-- Migration: License functions (open-source edition)
-- ============================================================
-- LIVO is open source (AGPL-3.0) and has no license keys: every feature is
-- available. These functions keep the RPC names the app and the edge
-- functions call (check_license / activate_license / reset_license), so
-- existing callers keep working, and simply report "everything unlocked".

CREATE OR REPLACE FUNCTION check_license()
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'valid', true,
    'tier', 'professional',
    'email', null,
    'expires_at', null,
    'is_perpetual', true,
    'is_expired', false,
    'installation_bound', false
  );
$$;

CREATE OR REPLACE FUNCTION activate_license(license_key text)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'valid', false,
    'error', 'not_required',
    'message', '開源版不需要授權金鑰，所有功能都已開放。'
  );
$$;

CREATE OR REPLACE FUNCTION reset_license(reset_code text)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'success', false,
    'error', 'not_required',
    'message', '開源版不需要授權金鑰，所有功能都已開放。'
  );
$$;

GRANT EXECUTE ON FUNCTION activate_license(text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION check_license() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION reset_license(text) TO authenticated, anon;
