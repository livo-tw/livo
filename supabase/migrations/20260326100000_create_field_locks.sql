-- ============================================================
-- field_locks: atomic field-level locking for collaborative editing
-- ============================================================

CREATE TABLE IF NOT EXISTS public.field_locks (
  lock_key   TEXT PRIMARY KEY,
  locked_by  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 seconds')
);

-- Index for fast cleanup of expired locks
CREATE INDEX IF NOT EXISTS idx_field_locks_expires ON public.field_locks (expires_at);
-- Index for fast "release all by member" operations
CREATE INDEX IF NOT EXISTS idx_field_locks_locked_by ON public.field_locks (locked_by);

-- Enable RLS but allow all authenticated users (locks are app-level, not row-level)
ALTER TABLE public.field_locks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read locks"
  ON public.field_locks FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert locks"
  ON public.field_locks FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update locks"
  ON public.field_locks FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete locks"
  ON public.field_locks FOR DELETE
  TO authenticated
  USING (true);

-- Also allow anon key (used by fetch+keepalive fallback on page close)
CREATE POLICY "Anon can read locks"
  ON public.field_locks FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "Anon can insert locks"
  ON public.field_locks FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "Anon can update locks"
  ON public.field_locks FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anon can delete locks"
  ON public.field_locks FOR DELETE
  TO anon
  USING (true);

-- Enable realtime for field_locks (so other clients see changes instantly)
ALTER PUBLICATION supabase_realtime ADD TABLE public.field_locks;

-- ============================================================
-- acquire_field_lock: atomically acquire or renew a lock
-- Returns JSON: { "acquired": true } or { "acquired": false, "locked_by": "member_id" }
-- ============================================================
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
BEGIN
  -- First, clean up any expired lock on this key
  DELETE FROM public.field_locks
  WHERE lock_key = p_lock_key AND expires_at < now();

  -- Check if a lock exists
  SELECT locked_by, expires_at INTO v_existing
  FROM public.field_locks
  WHERE lock_key = p_lock_key;

  IF FOUND THEN
    -- Lock exists
    IF v_existing.locked_by = p_member_id THEN
      -- Same user: renew the lock
      UPDATE public.field_locks
      SET expires_at = now() + (p_ttl_seconds || ' seconds')::interval
      WHERE lock_key = p_lock_key;
      RETURN jsonb_build_object('acquired', true);
    ELSE
      -- Different user holds the lock
      RETURN jsonb_build_object('acquired', false, 'locked_by', v_existing.locked_by);
    END IF;
  ELSE
    -- No lock: insert new one
    INSERT INTO public.field_locks (lock_key, locked_by, expires_at)
    VALUES (p_lock_key, p_member_id, now() + (p_ttl_seconds || ' seconds')::interval);
    RETURN jsonb_build_object('acquired', true);
  END IF;
END;
$$;

-- ============================================================
-- release_field_lock: release a specific lock held by a member
-- ============================================================
CREATE OR REPLACE FUNCTION public.release_field_lock(
  p_lock_key   TEXT,
  p_member_id  TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.field_locks
  WHERE lock_key = p_lock_key AND locked_by = p_member_id;
END;
$$;

-- ============================================================
-- release_all_locks: release ALL locks held by a member
-- (used on page close / unmount)
-- ============================================================
CREATE OR REPLACE FUNCTION public.release_all_locks(
  p_member_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.field_locks
  WHERE locked_by = p_member_id;
END;
$$;
