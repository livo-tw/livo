-- Project approval rules on Docker.
--
-- 1. Rules could not be created. 20260402_smart_notification_fix_rls.sql made
--    approval_rules.from_status/to_status foreign keys to statuses(name), but the
--    app, the submit command and Slack all store and compare status ids, so every
--    insert from the rule editor failed with fk_approval_rules_from_status.
--    The keys now point at statuses(id). NOT VALID: any legacy row that holds a
--    status name stays (it never matched a transition anyway) and the upgrade
--    cannot fail on it; new and changed rows are checked.
--    (A matching rule stays advisory for a task that does not require approval:
--    the board offers "change directly" or "submit for approval", as on Cloud.)
-- 2. Moving a parent card moved its subtasks even when one had a pending approval
--    (livo_task_work_move_subtasks runs as the owner, so the per-row approval guard
--    does not apply). It now refuses the move (approval_pending), as Cloud does.
-- Repeatable: DROP CONSTRAINT IF EXISTS before ADD, CREATE OR REPLACE; no row is touched.
ALTER TABLE public.approval_rules DROP CONSTRAINT IF EXISTS fk_approval_rules_from_status;
ALTER TABLE public.approval_rules DROP CONSTRAINT IF EXISTS fk_approval_rules_to_status;
ALTER TABLE public.approval_rules DROP CONSTRAINT IF EXISTS fk_approval_rules_from_status_id;
ALTER TABLE public.approval_rules ADD CONSTRAINT fk_approval_rules_from_status_id
  FOREIGN KEY (from_status) REFERENCES public.statuses(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.approval_rules DROP CONSTRAINT IF EXISTS fk_approval_rules_to_status_id;
ALTER TABLE public.approval_rules ADD CONSTRAINT fk_approval_rules_to_status_id
  FOREIGN KEY (to_status) REFERENCES public.statuses(id) ON DELETE CASCADE NOT VALID;

CREATE OR REPLACE FUNCTION public.livo_task_work_move_subtasks()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.tasks t JOIN public.approval_requests r ON r.task_id=t.id AND r.status='pending'
      WHERE t.parent_task_id=NEW.id AND t.project_id IS DISTINCT FROM NEW.project_id) THEN
    RAISE EXCEPTION 'approval_pending' USING ERRCODE='42501';
  END IF;
  UPDATE public.tasks SET project_id=NEW.project_id
    WHERE parent_task_id=NEW.id AND project_id IS DISTINCT FROM NEW.project_id;
  RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION public.livo_task_work_move_subtasks() FROM PUBLIC,anon,authenticated;
