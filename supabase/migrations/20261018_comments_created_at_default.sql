-- The baseline default for comments.created_at (20260308173019_*.sql) is
-- to_char(now(), 'YYYY-MM-DDTHH24:MI:SSZ'): the unquoted T makes "TH" a format
-- pattern, so an insert without created_at stored text like
-- '2026-10-04THH24:17:08Z' that no date parser reads. Every writer in the app
-- sends created_at today, so no stored row is affected; this makes the default a
-- real UTC ISO-8601 timestamp for any future writer.
-- Repeatable: SET DEFAULT again is a no-op; no row is touched.
ALTER TABLE public.comments
  ALTER COLUMN created_at SET DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
