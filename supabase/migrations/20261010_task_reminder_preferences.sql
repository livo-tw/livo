-- Personal automatic reminders and explicit deadline provenance. Old deadlines
-- keep an unknown kind; this migration never invents a commitment or reason.
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS due_date_kind text;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS due_date_version integer NOT NULL DEFAULT 0;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS due_date_change_reason text;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS due_date_changed_by text;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='tasks_due_date_kind_check' AND conrelid='public.tasks'::regclass) THEN
    ALTER TABLE public.tasks ADD CONSTRAINT tasks_due_date_kind_check CHECK(due_date_kind IS NULL OR due_date_kind IN ('estimated','committed'));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='tasks_due_date_version_check' AND conrelid='public.tasks'::regclass) THEN
    ALTER TABLE public.tasks ADD CONSTRAINT tasks_due_date_version_check CHECK(due_date_version>=0);
  END IF;
END; $$;
CREATE TABLE IF NOT EXISTS public.task_deadline_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  actor_id text, previous_due_date text, next_due_date text, previous_kind text, next_kind text,
  reason text, version integer NOT NULL CHECK(version>0), changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(task_id,version)
);
ALTER TABLE public.task_deadline_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.task_deadline_history FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.task_deadline_history TO authenticated;
GRANT ALL ON public.task_deadline_history TO service_role;
DROP POLICY IF EXISTS task_deadline_history_read ON public.task_deadline_history;
CREATE POLICY task_deadline_history_read ON public.task_deadline_history FOR SELECT TO authenticated
  USING(EXISTS(SELECT 1 FROM public.tasks t WHERE t.id=task_id));

CREATE TABLE IF NOT EXISTS public.task_reminder_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id text NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES public.members(id) ON DELETE CASCADE, snoozed_until timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version>0), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(task_id,member_id)
);
ALTER TABLE public.task_reminder_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.task_reminder_preferences FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.task_reminder_preferences TO authenticated;
GRANT ALL ON public.task_reminder_preferences TO service_role;
DROP POLICY IF EXISTS task_reminder_own_read ON public.task_reminder_preferences;
CREATE POLICY task_reminder_own_read ON public.task_reminder_preferences FOR SELECT TO authenticated
  USING(member_id=public.current_member_id() AND EXISTS(SELECT 1 FROM public.tasks t WHERE t.id=task_id));
DROP POLICY IF EXISTS task_reminder_own_insert ON public.task_reminder_preferences;
CREATE POLICY task_reminder_own_insert ON public.task_reminder_preferences FOR INSERT TO authenticated
  WITH CHECK(member_id=public.current_member_id() AND EXISTS(SELECT 1 FROM public.tasks t WHERE t.id=task_id));
DROP POLICY IF EXISTS task_reminder_own_update ON public.task_reminder_preferences;
CREATE POLICY task_reminder_own_update ON public.task_reminder_preferences FOR UPDATE TO authenticated
  USING(member_id=public.current_member_id())
  WITH CHECK(member_id=public.current_member_id() AND EXISTS(SELECT 1 FROM public.tasks t WHERE t.id=task_id));

-- PostgREST verifies the bearer JWT before invoking these functions. Slack JWTs
-- also need their current signed binding/team/user tuple; no body actor is used.
CREATE OR REPLACE FUNCTION public.livo_task_planning_actor()
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor text; claims jsonb:=auth.jwt(); binding public.external_account_bindings%ROWTYPE;
BEGIN
  SELECT id INTO actor FROM public.members WHERE auth_id=auth.uid() AND is_active FOR SHARE;
  IF actor IS NULL OR (SELECT count(*) FROM public.members WHERE auth_id=auth.uid() AND is_active)<>1 THEN
    RAISE EXCEPTION 'planning_forbidden' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(claims) k WHERE k LIKE 'livo_slack_%') THEN
    IF COALESCE(claims->>'livo_slack_binding','')='' OR COALESCE(claims->>'livo_slack_team','') !~ '^T[A-Z0-9]+$'
      OR COALESCE(claims->>'livo_slack_user','') !~ '^[UW][A-Z0-9]+$' THEN
      RAISE EXCEPTION 'planning_forbidden' USING ERRCODE='42501';
    END IF;
    SELECT * INTO binding FROM public.external_account_bindings WHERE id::text=claims->>'livo_slack_binding' FOR SHARE;
    IF NOT FOUND OR binding.member_id IS DISTINCT FROM actor OR binding.platform IS DISTINCT FROM 'slack'
      OR binding.is_verified IS DISTINCT FROM true OR binding.verified_by IS NULL OR binding.verified_by NOT IN ('email','admin')
      OR binding.platform_team_id IS DISTINCT FROM claims->>'livo_slack_team'
      OR binding.platform_user_id IS DISTINCT FROM claims->>'livo_slack_user' THEN
      RAISE EXCEPTION 'planning_forbidden' USING ERRCODE='42501';
    END IF;
    IF (SELECT count(*) FROM public.external_account_bindings WHERE platform='slack'
      AND platform_team_id=binding.platform_team_id AND platform_user_id=binding.platform_user_id)<>1 THEN
      RAISE EXCEPTION 'planning_forbidden' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN actor;
END; $$;
REVOKE ALL ON FUNCTION public.livo_task_planning_actor() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.livo_task_planning_actor() TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.livo_task_deadline_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor text; why text;
BEGIN
  NEW.due_date:=NULLIF(NEW.due_date,'');
  IF TG_OP='INSERT' AND NEW.due_date IS NULL AND NEW.due_date_kind IS NOT NULL THEN
    RAISE EXCEPTION 'planning_date_required' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.due_date IS NOT NULL AND (NEW.due_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR to_char(NEW.due_date::date,'YYYY-MM-DD')<>NEW.due_date) THEN
    RAISE EXCEPTION 'planning_invalid_date' USING ERRCODE='22023';
  END IF;
  IF NEW.due_date IS NULL THEN NEW.due_date_kind:=NULL; END IF;
  IF TG_OP='INSERT' THEN
    NEW.due_date_version:=0; NEW.due_date_change_reason:=NULL; NEW.due_date_changed_by:=NULL;
    RETURN NEW;
  END IF;
  IF NULLIF(OLD.due_date,'') IS NOT DISTINCT FROM NEW.due_date AND OLD.due_date_kind IS NOT DISTINCT FROM NEW.due_date_kind THEN
    NEW.due_date_version:=OLD.due_date_version; NEW.due_date_change_reason:=NULL; NEW.due_date_changed_by:=NULL;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-task-planning-import'));
  IF NEW.due_date IS NULL AND EXISTS(SELECT 1 FROM public.system_settings WHERE key='required_fields' AND value->'dueDate'='true'::jsonb) THEN
    RAISE EXCEPTION 'planning_date_required' USING ERRCODE='23514';
  END IF;
  IF NEW.due_date IS NOT NULL AND (NEW.due_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR to_char(NEW.due_date::date,'YYYY-MM-DD')<>NEW.due_date) THEN
    RAISE EXCEPTION 'planning_invalid_date' USING ERRCODE='22023';
  END IF;
  why:=NULLIF(btrim(NEW.due_date_change_reason),'');
  IF length(COALESCE(why,''))>2000 THEN RAISE EXCEPTION 'planning_invalid_reason' USING ERRCODE='22023'; END IF;
  IF OLD.due_date_kind='committed' AND NULLIF(OLD.due_date,'') IS NOT NULL
    AND (NEW.due_date IS NULL OR NEW.due_date>OLD.due_date) AND why IS NULL THEN
    RAISE EXCEPTION 'planning_reason_required' USING ERRCODE='23514';
  END IF;
  -- auth.uid() is retained inside a trigger. Privileged imports without a real
  -- member deliberately record NULL instead of attributing work to a colleague.
  IF auth.uid() IS NOT NULL THEN actor:=public.livo_task_planning_actor(); END IF;
  NEW.due_date_version:=OLD.due_date_version+1;
  INSERT INTO public.task_deadline_history(task_id,actor_id,previous_due_date,next_due_date,previous_kind,next_kind,reason,version)
    VALUES(OLD.id,actor,NULLIF(OLD.due_date,''),NEW.due_date,OLD.due_date_kind,NEW.due_date_kind,why,NEW.due_date_version)
    ON CONFLICT(task_id,version) DO NOTHING;
  IF NOT FOUND THEN RAISE EXCEPTION 'planning_conflict' USING ERRCODE='40001'; END IF;
  NEW.due_date_change_reason:=NULL; NEW.due_date_changed_by:=NULL;
  RETURN NEW;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RAISE EXCEPTION 'planning_invalid_date' USING ERRCODE='22023';
END; $$;
DROP TRIGGER IF EXISTS livo_task_deadline_guard ON public.tasks;
CREATE TRIGGER livo_task_deadline_guard BEFORE INSERT OR UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.livo_task_deadline_guard();

CREATE OR REPLACE FUNCTION public.livo_task_reminder_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-task-planning-import'));
  IF current_user NOT IN ('service_role','postgres','supabase_admin') AND NEW.member_id IS DISTINCT FROM public.livo_task_planning_actor() THEN
    RAISE EXCEPTION 'planning_forbidden' USING ERRCODE='42501';
  END IF;
  IF current_user NOT IN ('service_role','postgres','supabase_admin') AND NOT EXISTS(
    SELECT 1 FROM public.tasks t JOIN public.projects p ON p.id=t.project_id WHERE t.id=NEW.task_id AND NOT p.is_archived) THEN
    RAISE EXCEPTION 'planning_unavailable' USING ERRCODE='P0002';
  END IF;
  IF NEW.snoozed_until IS NOT NULL AND (NEW.snoozed_until<=clock_timestamp() OR NEW.snoozed_until>clock_timestamp()+interval '366 days') THEN
    RAISE EXCEPTION 'planning_invalid_pause' USING ERRCODE='22023';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.task_id<>OLD.task_id OR NEW.member_id<>OLD.member_id OR NEW.version<>OLD.version+1) THEN
    RAISE EXCEPTION 'planning_conflict' USING ERRCODE='40001';
  END IF;
  IF TG_OP='INSERT' AND NEW.version<>1 THEN RAISE EXCEPTION 'planning_conflict' USING ERRCODE='40001'; END IF;
  NEW.updated_at:=clock_timestamp(); RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS livo_task_reminder_guard ON public.task_reminder_preferences;
CREATE TRIGGER livo_task_reminder_guard BEFORE INSERT OR UPDATE ON public.task_reminder_preferences FOR EACH ROW EXECUTE FUNCTION public.livo_task_reminder_guard();

-- Archive/delete and commands serialize on a project-scoped advisory lock.
-- This trigger returns no content and is not a callable SECURITY DEFINER API.
CREATE OR REPLACE FUNCTION public.livo_task_planning_project_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-task-planning-project:'||OLD.id));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.livo_task_planning_project_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_task_planning_project_guard ON public.projects;
CREATE TRIGGER livo_task_planning_project_guard BEFORE UPDATE OF is_archived OR DELETE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.livo_task_planning_project_guard();

CREATE OR REPLACE FUNCTION public.livo_set_task_reminder(p_task_id text,p_until timestamptz,p_expected_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor text:=public.livo_task_planning_actor(); saved public.task_reminder_preferences%ROWTYPE; project_id text;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version<0 THEN RAISE EXCEPTION 'planning_invalid_input' USING ERRCODE='22023'; END IF;
  SELECT t.project_id INTO project_id FROM public.tasks t WHERE t.id=p_task_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'planning_unavailable' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.projects p WHERE p.id=project_id AND NOT p.is_archived;
  IF NOT FOUND THEN RAISE EXCEPTION 'planning_unavailable' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-task-planning-project:'||project_id));
  PERFORM 1 FROM public.projects p WHERE p.id=project_id AND NOT p.is_archived;
  IF NOT FOUND THEN RAISE EXCEPTION 'planning_unavailable' USING ERRCODE='P0002'; END IF;
  IF p_expected_version>0 AND NOT EXISTS(SELECT 1 FROM public.task_reminder_preferences WHERE task_id=p_task_id AND member_id=actor) THEN
    RAISE EXCEPTION 'planning_conflict' USING ERRCODE='40001';
  END IF;
  INSERT INTO public.task_reminder_preferences(task_id,member_id,snoozed_until) VALUES(p_task_id,actor,p_until)
    ON CONFLICT(task_id,member_id) DO UPDATE SET snoozed_until=EXCLUDED.snoozed_until,version=task_reminder_preferences.version+1
    WHERE task_reminder_preferences.version=p_expected_version RETURNING * INTO saved;
  IF NOT FOUND THEN RAISE EXCEPTION 'planning_conflict' USING ERRCODE='40001'; END IF;
  RETURN to_jsonb(saved);
END; $$;
REVOKE ALL ON FUNCTION public.livo_set_task_reminder(text,timestamptz,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.livo_set_task_reminder(text,timestamptz,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.livo_set_task_deadline(p_task_id text,p_expected_version integer,p_due_date text,p_kind text,p_reason text DEFAULT NULL,
  p_change_start boolean DEFAULT false,p_expected_started_at text DEFAULT NULL,p_started_at text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor text:=public.livo_task_planning_actor(); card public.tasks%ROWTYPE;
BEGIN
  SELECT t.* INTO card FROM public.tasks t WHERE t.id=p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'planning_unavailable' USING ERRCODE='P0002'; END IF;
  -- A separate statement after acquiring the task lock gets a fresh snapshot;
  -- serialize with archive/delete before repeating its RLS visibility check.
  PERFORM 1 FROM public.projects p WHERE p.id=card.project_id AND NOT p.is_archived;
  IF NOT FOUND THEN RAISE EXCEPTION 'planning_unavailable' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-task-planning-project:'||card.project_id));
  PERFORM 1 FROM public.projects p WHERE p.id=card.project_id AND NOT p.is_archived;
  IF NOT FOUND THEN RAISE EXCEPTION 'planning_unavailable' USING ERRCODE='P0002'; END IF;
  IF p_expected_version IS DISTINCT FROM card.due_date_version THEN RAISE EXCEPTION 'planning_conflict' USING ERRCODE='40001'; END IF;
  IF p_change_start IS NULL THEN RAISE EXCEPTION 'planning_invalid_input' USING ERRCODE='22023'; END IF;
  IF p_change_start AND NULLIF(card.started_at,'') IS DISTINCT FROM NULLIF(p_expected_started_at,'') THEN
    RAISE EXCEPTION 'planning_conflict' USING ERRCODE='40001';
  END IF;
  IF p_change_start AND NULLIF(p_started_at,'') IS NOT NULL AND (p_started_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR to_char(p_started_at::date,'YYYY-MM-DD')<>p_started_at) THEN RAISE EXCEPTION 'planning_invalid_date' USING ERRCODE='22023'; END IF;
  IF p_kind IS NOT NULL AND p_kind NOT IN ('estimated','committed') THEN RAISE EXCEPTION 'planning_invalid_kind' USING ERRCODE='22023'; END IF;
  IF NULLIF(p_due_date,'') IS NULL AND p_kind IS NOT NULL THEN RAISE EXCEPTION 'planning_date_required' USING ERRCODE='22023'; END IF;
  UPDATE public.tasks SET due_date=NULLIF(p_due_date,''),due_date_kind=p_kind,due_date_change_reason=p_reason,
    started_at=CASE WHEN p_change_start THEN NULLIF(p_started_at,'') ELSE started_at END WHERE id=p_task_id RETURNING * INTO card;
  RETURN jsonb_build_object('id',card.id,'due_date',card.due_date,'due_date_kind',card.due_date_kind,'due_date_version',card.due_date_version,'started_at',card.started_at);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'planning_invalid_date' USING ERRCODE='22023';
END; $$;
REVOKE ALL ON FUNCTION public.livo_set_task_deadline(text,integer,text,text,text,boolean,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.livo_set_task_deadline(text,integer,text,text,text,boolean,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.livo_task_reminder_paused(p_task text,p_member text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
  SELECT EXISTS(SELECT 1 FROM public.task_reminder_preferences WHERE task_id=p_task AND member_id=p_member AND snoozed_until>now())
$$;
REVOKE ALL ON FUNCTION public.livo_task_reminder_paused(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.livo_task_reminder_paused(text,text) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public.livo_suppress_paused_due_notification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN
  IF NEW.type='due_soon' AND public.livo_task_reminder_paused(NEW.task_id,NEW.recipient_id) THEN RETURN NULL; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS livo_suppress_paused_due_notification ON public.notifications;
CREATE TRIGGER livo_suppress_paused_due_notification BEFORE INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.livo_suppress_paused_due_notification();

-- Personal due-date digest only. Full work reports and responsibility events
-- deliberately keep every task, including tasks whose owner paused reminders.
CREATE OR REPLACE FUNCTION public.livo_slack_weekly_tasks(p_member text,p_week date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('taskId',t.id,'taskKey',t.task_key,'taskTitle',t.title,
    'projectId',p.id,'lineId',p.line_id,'projectName',p.name,'dueDate',t.due_date,'role',COALESCE(h.role,'assignee')) ORDER BY t.due_date,t.task_key),'[]'::jsonb)
  FROM public.tasks t JOIN public.projects p ON p.id=t.project_id AND NOT p.is_archived
  JOIN public.statuses s ON s.id=t.status_id AND NOT s.is_done
  JOIN public.system_settings cfg ON cfg.key='slack_delivery'
  CROSS JOIN LATERAL (SELECT public.livo_slack_handoff_role(t.status_id,cfg.value) AS role) h
  WHERE public.livo_slack_dm_allowed(cfg.value,p_member)
    AND EXISTS(SELECT 1 FROM public.members WHERE id=p_member AND is_active)
    AND EXISTS(SELECT 1 FROM public.livo_slack_delivery_channels(t.project_id))
    AND CASE WHEN h.role='reviewer' THEN t.reviewer_id ELSE t.assignee_id END=p_member
    AND COALESCE(t.completed_at,'')='' AND lower(s.name) NOT IN ('取消','已取消','cancelled','canceled')
    AND t.due_date ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    AND t.due_date<=to_char(p_week+6,'YYYY-MM-DD') AND extract(isodow FROM p_week)=1
    AND NOT public.livo_task_reminder_paused(t.id,p_member)
$$;
REVOKE ALL ON FUNCTION public.livo_slack_weekly_tasks(text,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_slack_weekly_tasks(text,date) TO service_role;

-- Import replaces tasks wholesale; preserve planning evidence unless a proper
-- full database restore is used. The lock is shared by all planning mutations.
-- When merging with the approval slice, keep BOTH approval and planning guards.
CREATE OR REPLACE FUNCTION public.livo_jira_clear_tasks()
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE prior_silent text; removed bigint;
BEGIN
  IF current_user<>'service_role' THEN RAISE EXCEPTION 'planning_forbidden' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-approval-feature'));
  PERFORM pg_advisory_xact_lock(hashtext('livo-task-planning-import'));
  IF EXISTS(SELECT 1 FROM public.approval_requests WHERE status='pending')
    OR EXISTS(SELECT 1 FROM public.tasks WHERE current_approval_id IS NOT NULL OR approval_status IS NOT NULL) THEN
    RAISE EXCEPTION 'approval_pending' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.task_deadline_history) OR EXISTS(SELECT 1 FROM public.task_reminder_preferences) THEN
    RAISE EXCEPTION 'planning_history_requires_restore' USING ERRCODE='23514';
  END IF;
  prior_silent:=current_setting('livo.slack_silent',true);
  PERFORM set_config('livo.slack_silent','true',true);
  DELETE FROM public.comments;
  DELETE FROM public.task_checks;
  DELETE FROM public.task_todos;
  DELETE FROM public.task_specs;
  DELETE FROM public.task_deployments;
  DELETE FROM public.task_attachments;
  DELETE FROM public.status_logs;
  DELETE FROM public.notifications;
  DELETE FROM public.tasks;
  GET DIAGNOSTICS removed=ROW_COUNT;
  DELETE FROM public.sprints;
  PERFORM set_config('livo.slack_silent',COALESCE(prior_silent,''),true);
  RETURN jsonb_build_object('cleared',true,'tasks',removed);
END; $$;
REVOKE ALL ON FUNCTION public.livo_jira_clear_tasks() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_jira_clear_tasks() TO service_role;
