-- Pending approvals are meant to refresh live (useApprovalRealtime.ts subscribes to
-- INSERT/UPDATE on approval_requests), but on Docker the table was never added to
-- the supabase_realtime publication, so other members only saw a new or decided
-- request after reloading.
--
-- Realtime delivers a change only to subscribers whose RLS lets them read the row.
-- approval_requests is readable by signed-in members only (approval_requests_select
-- TO authenticated), the same rows the REST API already returns to them, so
-- publishing it exposes nothing new. Writes remain command-only (20261009).
-- Repeatable; skipped on a database without the supabase_realtime publication, and
-- on one whose publication already covers the table (including FOR ALL TABLES).
DO $livo$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'approval_requests') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.approval_requests;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$livo$;
