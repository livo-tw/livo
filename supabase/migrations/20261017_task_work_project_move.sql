-- A parent task that has subtasks could not be moved to another project on Docker:
-- livo_task_work_task_guard (20261011_task_work_commands.sql) refused the parent
-- while its subtasks were still in the old project, and refused each subtask while
-- the parent was not yet in the new one, so no order worked. The web app offers the
-- project change on every card.
--
-- Moving a parent now moves its subtasks with it in the same statement, so a
-- subtask's project still always equals its parent's. Moving a subtask on its own
-- is still refused (work_invalid_parent), and a subtask whose key already exists in
-- the target project rolls the whole move back (work_conflict).
-- Repeatable: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before CREATE TRIGGER.
CREATE OR REPLACE FUNCTION public.livo_task_work_task_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE parent public.tasks%ROWTYPE; assigned boolean; reviewing boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.assignee_revision<>0 OR NEW.reviewer_revision<>0 OR NEW.assignee_acknowledged_at IS NOT NULL OR NEW.reviewer_acknowledged_at IS NOT NULL THEN
      RAISE EXCEPTION 'work_forbidden' USING ERRCODE='42501';
    END IF;
  ELSE
    assigned:=NEW.assignee_id IS DISTINCT FROM OLD.assignee_id;
    reviewing:=NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id;
    IF NEW.assignee_revision<>OLD.assignee_revision OR NEW.reviewer_revision<>OLD.reviewer_revision THEN
      RAISE EXCEPTION 'work_forbidden' USING ERRCODE='42501';
    END IF;
    IF (NEW.assignee_acknowledged_at IS DISTINCT FROM OLD.assignee_acknowledged_at
      OR NEW.reviewer_acknowledged_at IS DISTINCT FROM OLD.reviewer_acknowledged_at) AND NOT EXISTS(
      SELECT 1 FROM public.task_work_contexts c WHERE c.task_id=OLD.id AND c.operation='acknowledge'
      AND ((c.actor_id=OLD.assignee_id AND NEW.reviewer_acknowledged_at IS NOT DISTINCT FROM OLD.reviewer_acknowledged_at)
        OR (c.actor_id=OLD.reviewer_id AND NEW.assignee_acknowledged_at IS NOT DISTINCT FROM OLD.assignee_acknowledged_at))) THEN
      RAISE EXCEPTION 'work_forbidden' USING ERRCODE='42501';
    END IF;
    IF assigned THEN NEW.assignee_revision:=OLD.assignee_revision+1; NEW.assignee_acknowledged_at:=NULL; END IF;
    IF reviewing THEN NEW.reviewer_revision:=OLD.reviewer_revision+1; NEW.reviewer_acknowledged_at:=NULL; END IF;
  END IF;
  IF TG_OP='INSERT' OR NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    PERFORM pg_advisory_xact_lock(hashtext('livo-task-work-graph'));
    IF NEW.parent_task_id IS NOT NULL THEN
      SELECT * INTO parent FROM public.tasks WHERE id=NEW.parent_task_id FOR SHARE;
      IF NOT FOUND OR parent.id=NEW.id OR parent.parent_task_id IS NOT NULL OR parent.project_id<>NEW.project_id
        OR EXISTS(SELECT 1 FROM public.tasks WHERE parent_task_id=NEW.id) THEN
        RAISE EXCEPTION 'work_invalid_parent' USING ERRCODE='23514';
      END IF;
    END IF;
    -- A parent changing project takes its subtasks along (livo_task_work_move_subtasks,
    -- same statement); otherwise subtasks must already share the parent's project.
    IF (TG_OP='INSERT' OR NEW.project_id IS NOT DISTINCT FROM OLD.project_id)
      AND EXISTS(SELECT 1 FROM public.tasks WHERE parent_task_id=NEW.id AND project_id<>NEW.project_id) THEN
      RAISE EXCEPTION 'work_invalid_parent' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='INSERT' OR NEW.task_key IS DISTINCT FROM OLD.task_key OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    PERFORM pg_advisory_xact_lock(hashtext('livo-task-number:'||NEW.project_id));
    IF EXISTS(SELECT 1 FROM public.tasks WHERE project_id=NEW.project_id AND task_key=NEW.task_key AND id<>NEW.id) THEN
      RAISE EXCEPTION 'work_conflict' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.livo_task_work_task_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_task_work_task_guard ON public.tasks;
CREATE TRIGGER livo_task_work_task_guard BEFORE INSERT OR UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.livo_task_work_task_guard();

-- AFTER the parent row is written, so each subtask's guard sees the parent in its
-- new project. Runs as the owner like the guard: permission to move the parent card
-- is permission to move its subtasks, and none may be left behind by RLS.
CREATE OR REPLACE FUNCTION public.livo_task_work_move_subtasks()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE public.tasks SET project_id=NEW.project_id
    WHERE parent_task_id=NEW.id AND project_id IS DISTINCT FROM NEW.project_id;
  RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION public.livo_task_work_move_subtasks() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_task_work_move_subtasks ON public.tasks;
CREATE TRIGGER livo_task_work_move_subtasks AFTER UPDATE ON public.tasks FOR EACH ROW
  WHEN (OLD.project_id IS DISTINCT FROM NEW.project_id AND NEW.parent_task_id IS NULL)
  EXECUTE FUNCTION public.livo_task_work_move_subtasks();
