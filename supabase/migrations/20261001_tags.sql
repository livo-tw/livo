-- ============================================================================
-- Migration: 20261001_tags.sql
-- Task tags for the self-host (Docker/Supabase) build — parity with the
-- Cloudflare build's tags / task_tags tables (worker/schema.sql).
--
-- The frontend has always read and written these two tables (tag picker in the
-- create-task form and the task sidebar, list filters, realtime refresh), but
-- no Postgres migration ever created them: they existed only in the original
-- hosted project and in D1. On a Docker install every tag action failed
-- ("relation public.tags does not exist"). 20260713_permission_floor.sql
-- already lists both tables in its matrix and skips them when absent; this
-- migration creates them with the same floor:
--   tags      insert: any member   update: none   delete: any member
--   task_tags insert: any member   update: none   delete: any member
-- Reads are open to every signed-in member, like the other task tables.
--
-- Idempotent (re-runnable): part of the merged schema on fresh installs, and
-- applied by the installer's upgrade step on existing installs.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tags (
  id    text PRIMARY KEY DEFAULT ('tag_' || gen_random_uuid()::text),
  name  text NOT NULL,
  color text NOT NULL DEFAULT '#6B778C'
);

CREATE TABLE IF NOT EXISTS public.task_tags (
  id      text PRIMARY KEY DEFAULT ('tt_' || gen_random_uuid()::text),
  task_id text NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  tag_id  text NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_tags_task ON public.task_tags (task_id);
CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON public.task_tags (tag_id);

ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_tags ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE ON TABLE public.tags TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.task_tags TO authenticated;
GRANT ALL ON TABLE public.tags TO service_role;
GRANT ALL ON TABLE public.task_tags TO service_role;

DROP POLICY IF EXISTS "pf_tags_read" ON public.tags;
CREATE POLICY "pf_tags_read" ON public.tags
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "pf_tags_insert" ON public.tags;
CREATE POLICY "pf_tags_insert" ON public.tags
  FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "pf_tags_delete" ON public.tags;
CREATE POLICY "pf_tags_delete" ON public.tags
  FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "pf_task_tags_read" ON public.task_tags;
CREATE POLICY "pf_task_tags_read" ON public.task_tags
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "pf_task_tags_insert" ON public.task_tags;
CREATE POLICY "pf_task_tags_insert" ON public.task_tags
  FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "pf_task_tags_delete" ON public.task_tags;
CREATE POLICY "pf_task_tags_delete" ON public.task_tags
  FOR DELETE TO authenticated USING (true);

-- Realtime: the frontend refreshes tags on postgres_changes (useConfigSubs).
DO $livo$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.tags; EXCEPTION WHEN duplicate_object THEN NULL; END $livo$;
DO $livo$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.task_tags; EXCEPTION WHEN duplicate_object THEN NULL; END $livo$;
