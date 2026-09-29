-- Fix: activity_logs.id missing a default on some legacy databases.
-- Type-aware: on a FRESH install the column is uuid (created with a default
-- already) — a hard-coded gen_random_uuid()::text default errors with
-- "column is of type uuid but default expression is of type text" and aborts
-- the whole merged-schema install. Legacy DBs that re-typed id to text get
-- the ::text default; uuid columns get the uuid default.
DO $$
DECLARE t text;
BEGIN
  SELECT data_type INTO t FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'activity_logs' AND column_name = 'id';
  IF t = 'uuid' THEN
    ALTER TABLE activity_logs ALTER COLUMN id SET DEFAULT gen_random_uuid();
  ELSIF t IS NOT NULL THEN
    ALTER TABLE activity_logs ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
  END IF;
END $$;
