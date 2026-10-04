-- Field locks are taken and released only by the member's own session.
--
-- acquire_field_lock, release_field_lock and release_all_locks
-- (20260326100000) are SECURITY DEFINER, executable by PUBLIC, and trust the
-- p_member_id and p_ttl_seconds they are given. With only the anon key from the
-- browser bundle, anyone could release other people's locks or lock a task
-- field in someone else's name for years; revoking anon's table access
-- (20261018_revoke_anon_table_access.sql) did not cover these functions.
-- Knowledge-page keys were already guarded by kb_lock_guard; task fields were not.
--
-- Now the caller must be an active member and p_member_id must be that member;
-- otherwise the call fails with field_lock_forbidden. The lock lasts at most
-- 300 seconds; the app renews every few seconds with a 15-second TTL. The service
-- role (no auth.uid()) keeps its access. The bodies are otherwise unchanged.
-- Repeatable: CREATE OR REPLACE; no row is touched.
CREATE OR REPLACE FUNCTION public.livo_field_lock_caller(p_member_id text)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL AND COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN;
  END IF;
  IF p_member_id IS NULL OR NOT public.livo_is_active_member()
     OR p_member_id IS DISTINCT FROM public.current_member_id() THEN
    RAISE EXCEPTION 'field_lock_forbidden' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_field_lock_caller(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.livo_field_lock_caller(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.acquire_field_lock(
  p_lock_key     TEXT,
  p_member_id    TEXT,
  p_ttl_seconds  INT DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing RECORD;
  v_ttl INT := LEAST(GREATEST(COALESCE(p_ttl_seconds, 30), 1), 300);
BEGIN
  PERFORM public.livo_field_lock_caller(p_member_id);
  DELETE FROM public.field_locks
  WHERE lock_key = p_lock_key AND expires_at < now();

  SELECT locked_by, expires_at INTO v_existing
  FROM public.field_locks
  WHERE lock_key = p_lock_key;

  IF FOUND THEN
    IF v_existing.locked_by = p_member_id THEN
      UPDATE public.field_locks
      SET expires_at = now() + (v_ttl || ' seconds')::interval
      WHERE lock_key = p_lock_key;
      RETURN jsonb_build_object('acquired', true);
    ELSE
      RETURN jsonb_build_object('acquired', false, 'locked_by', v_existing.locked_by);
    END IF;
  ELSE
    INSERT INTO public.field_locks (lock_key, locked_by, expires_at)
    VALUES (p_lock_key, p_member_id, now() + (v_ttl || ' seconds')::interval);
    RETURN jsonb_build_object('acquired', true);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_field_lock(
  p_lock_key   TEXT,
  p_member_id  TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM public.livo_field_lock_caller(p_member_id);
  DELETE FROM public.field_locks
  WHERE lock_key = p_lock_key AND locked_by = p_member_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_all_locks(
  p_member_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM public.livo_field_lock_caller(p_member_id);
  DELETE FROM public.field_locks
  WHERE locked_by = p_member_id;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_field_lock(text, text, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.release_field_lock(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.release_all_locks(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acquire_field_lock(text, text, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_field_lock(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_all_locks(text) TO authenticated, service_role;
