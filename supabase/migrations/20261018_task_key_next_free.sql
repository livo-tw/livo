-- Task creation could be blocked for good after a task moved to another project.
--
-- A moved task keeps its key (ABC-12 stays ABC-12 in project XYZ), but the key
-- generators (web app, task-work subtasks, Slack, knowledge workflow) take the
-- highest number among the tasks still in the project. Project ABC then hands
-- out ABC-12 again, kb_task_key_guard (20261010_knowledge_workflow.sql) refuses
-- the duplicate key, and every retry computes the same number.
--
-- On INSERT the guard now takes the next free number for the same prefix instead
-- of failing; callers read the stored key back (RETURNING / re-select). Renaming
-- a task to a key that is already taken (UPDATE) is still refused, and keys
-- without a numeric suffix keep the old check. Existing keys are not changed.
-- Repeatable: CREATE OR REPLACE; no row is touched.
CREATE OR REPLACE FUNCTION public.kb_task_key_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  prefix text;
  next_number bigint;
BEGIN
  IF TG_OP='UPDATE' AND NEW.task_key IS NOT DISTINCT FROM OLD.task_key THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('task-key:'||NEW.task_key));
  IF EXISTS(SELECT 1 FROM public.tasks WHERE task_key=NEW.task_key AND id<>NEW.id) THEN
    prefix:=substring(NEW.task_key from '^(.*)-[0-9]+$');
    IF TG_OP='UPDATE' OR prefix IS NULL THEN
      RAISE EXCEPTION 'kb_workflow_task_key_conflict' USING ERRCODE='23505';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('task-key-prefix:'||prefix));
    SELECT COALESCE(max(substring(task_key from '-([0-9]+)$')::bigint),0)+1 INTO next_number
      FROM public.tasks WHERE substring(task_key from '^(.*)-[0-9]+$')=prefix;
    NEW.task_key:=prefix||'-'||next_number;
    PERFORM pg_advisory_xact_lock(hashtext('task-key:'||NEW.task_key));
  END IF;
  RETURN NEW;
END; $$;
