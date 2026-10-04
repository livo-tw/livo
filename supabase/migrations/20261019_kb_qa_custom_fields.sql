-- "Report and link Bug" from a knowledge page keeps the QA custom fields.
--
-- kb_workflow builds the new issue's data itself and left customFields out, so
-- livo_qa_commit validated an empty set. On a team with a required QA custom
-- field the command always failed with qa_custom_field_required, and optional
-- values typed in the form were dropped. The form already sends them; this passes
-- input->'customFields' through, and livo_qa_commit validates them against the
-- team's fields as it does for any other new bug.
--
-- Only the expression that builds the issue data changes. It is rewritten in place
-- like 20261019_conflicts_not_retried.sql, so the function keeps its owner,
-- grants and PT409 conflict codes.
-- Repeatable: a second run finds customFields already there; no row is touched.
DO $livo_kb_qa$
DECLARE
  fn regprocedure := to_regprocedure('public.kb_workflow(jsonb)');
  def text;
  fixed text;
BEGIN
  IF fn IS NULL THEN
    RETURN;
  END IF;
  def := pg_get_functiondef(fn);
  IF position($s$'customFields'$s$ IN def) > 0 THEN
    RETURN;
  END IF;
  fixed := replace(def, $s$'targets','[]'::jsonb,$s$,
    $s$'customFields',COALESCE(NULLIF(input->'customFields','null'::jsonb),'{}'::jsonb),'targets','[]'::jsonb,$s$);
  IF fixed = def THEN
    RAISE WARNING 'kb_workflow was changed locally; QA custom fields from knowledge pages are not passed through';
    RETURN;
  END IF;
  EXECUTE fixed;
END
$livo_kb_qa$;
