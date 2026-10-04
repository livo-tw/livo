-- Edit conflicts must not be raised as SQLSTATE 40001.
--
-- The command, planning, knowledge, QA and release functions report a stale
-- version or a concurrent change with RAISE ... USING ERRCODE='40001'
-- (serialization_failure). PostgREST retries a transaction that fails with 40001,
-- and these conflicts are deterministic, so it retried the same call about a
-- thousand times a second and never answered, even after the browser gave up.
-- Each such request held a database connection: a few ordinary edit conflicts
-- (two people saving the same page, a stale task deadline) exhausted PostgREST's
-- pool and the whole app stopped responding until the rest container restarted.
--
-- PTxyz is PostgREST's code for "answer with HTTP xyz": PT409 returns 409 at once.
-- This rewrites every function in schema public that raises 40001 (69 RAISE
-- statements in 18 functions at the time of writing) to raise PT409 instead, with
-- the same message, so callers that read the message (approval_conflict,
-- work_conflict, planning_conflict, knowledge_conflict ...) are unchanged; the
-- Edge Functions treat PT409 like a conflict. CREATE OR REPLACE keeps each
-- function's owner, grants, security and search_path.
-- New migrations must raise PT409 for conflicts (src/test/releaseUpgrades.test.ts).
-- Repeatable: a second run finds nothing to rewrite; no row is touched.
DO $livo_conflicts$
DECLARE
  fn record;
  def text;
  fixed text;
BEGIN
  FOR fn IN
    SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.prosrc ~ $re$ERRCODE\s*=\s*'40001'$re$
  LOOP
    def := pg_get_functiondef(fn.oid);
    fixed := regexp_replace(def, $re$ERRCODE(\s*)=(\s*)'40001'$re$, $re$ERRCODE\1=\2'PT409'$re$, 'g');
    IF fixed IS DISTINCT FROM def THEN
      EXECUTE fixed;
    END IF;
  END LOOP;
END
$livo_conflicts$;
