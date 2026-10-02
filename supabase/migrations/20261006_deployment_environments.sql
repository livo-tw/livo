-- One ordered environment list for task deployments and QA. Missing settings
-- keep the original five choices; removing a choice never rewrites history.
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='task_deployments'
      AND column_name='environment' AND udt_name='deploy_environment') THEN
    ALTER TABLE public.task_deployments ALTER COLUMN environment TYPE text USING environment::text;
  END IF;
END;
$migration$;

-- The same full validation applies to new writes and settings that already
-- existed before this upgrade. Invalid existing data must never grant choices.
CREATE OR REPLACE FUNCTION public.livo_deployment_environment_settings_valid(configured jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE item jsonb; label text; seen text[]:=ARRAY[]::text[];
  -- ECMAScript trim whitespace, matching the shared client/server validator.
  trim_chars text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF jsonb_typeof(configured) IS DISTINCT FROM 'object'
    OR configured->'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(configured->'values') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(configured))<>2
    OR jsonb_array_length(configured->'values') NOT BETWEEN 1 AND 30 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(configured->'values') LOOP
    label:=item#>>'{}';
    IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR length(label) NOT BETWEEN 1 AND 120
      OR label IS DISTINCT FROM btrim(label,trim_chars)
      OR label ~ U&'[\0001-\001F\007F]' OR label=ANY(seen) THEN RETURN false; END IF;
    seen:=array_append(seen,label);
  END LOOP;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_deployment_environment_settings_valid(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.livo_deployment_environment_settings_valid(jsonb) TO authenticated,service_role;

-- VOLATILE gives a fresh READ COMMITTED snapshot after a writer waits on the
-- shared advisory lock. A STABLE lookup could still see the pre-lock setting.
CREATE OR REPLACE FUNCTION public.livo_deployment_environment_values()
RETURNS text[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE configured jsonb;
BEGIN
  SELECT value INTO configured FROM public.system_settings WHERE key='deployment_environments';
  IF NOT FOUND THEN RETURN ARRAY['Dev','QA','Stage','Live Staging','Prod']::text[]; END IF;
  IF NOT public.livo_deployment_environment_settings_valid(configured) THEN RETURN ARRAY[]::text[]; END IF;
  RETURN ARRAY(SELECT jsonb_array_elements_text(configured->'values'));
END;
$$;
REVOKE ALL ON FUNCTION public.livo_deployment_environment_values() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.livo_deployment_environment_values() TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.livo_guard_deployment_environment_setting()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE protected_row boolean;
BEGIN
  protected_row:=(TG_OP<>'DELETE' AND NEW.key='deployment_environments')
    OR (TG_OP<>'INSERT' AND OLD.key='deployment_environments');
  IF NOT COALESCE(protected_row,false) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  -- QA commits already hold this lock. Settings, task writes and QA writes
  -- therefore use the same ordering without introducing another lock cycle.
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  -- Never treat a missing JWT as an authorization bypass. Only the real
  -- service DB role or a superuser SQL maintenance session has that access.
  IF current_user<>'service_role'
    AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT (current_user='authenticated' AND EXISTS(
      SELECT 1 FROM public.members WHERE id=public.current_member_id()
        AND auth_id=auth.uid() AND is_active=true AND role::text IN ('admin','super_admin')
    )) THEN
    RAISE EXCEPTION 'deployment_environment_settings_forbidden' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND OLD.key='deployment_environments' AND NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'deployment_environment_setting_key_immutable' USING ERRCODE='22023';
  END IF;
  IF NOT public.livo_deployment_environment_settings_valid(NEW.value) THEN
    RAISE EXCEPTION 'invalid_deployment_environments' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS livo_guard_deployment_environment_setting ON public.system_settings;
CREATE TRIGGER livo_guard_deployment_environment_setting BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.livo_guard_deployment_environment_setting();

CREATE OR REPLACE FUNCTION public.livo_guard_task_deployment_environment()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  -- Retain the original row when an environment is retired. Moving that row
  -- to another task or changing its identity must pass current validation.
  IF TG_OP='UPDATE' AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.task_id IS NOT DISTINCT FROM OLD.task_id
    AND NEW.environment IS NOT DISTINCT FROM OLD.environment THEN RETURN NEW; END IF;
  IF NOT COALESCE(NEW.environment=ANY(public.livo_deployment_environment_values()),false) THEN
    RAISE EXCEPTION 'deployment_environment_unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS livo_guard_task_deployment_environment ON public.task_deployments;
CREATE TRIGGER livo_guard_task_deployment_environment BEFORE INSERT OR UPDATE ON public.task_deployments
FOR EACH ROW EXECUTE FUNCTION public.livo_guard_task_deployment_environment();

-- The old UI deleted/reinserted deployments. Updating the original row now
-- preserves retired environments, while INSERT/DELETE keep their role floor.
DROP POLICY IF EXISTS livo_task_deployments_update_active ON public.task_deployments;
CREATE POLICY livo_task_deployments_update_active ON public.task_deployments FOR UPDATE TO authenticated
USING (EXISTS(SELECT 1 FROM public.members WHERE id=public.current_member_id() AND auth_id=auth.uid() AND is_active=true))
WITH CHECK (EXISTS(SELECT 1 FROM public.members WHERE id=public.current_member_id() AND auth_id=auth.uid() AND is_active=true));

-- Keep the QA command contract and service-role grant; only add environment
-- checks inside its existing atomic feature lock. Restore stays unchanged.
CREATE OR REPLACE FUNCTION public.livo_qa_commit(p_auth_id uuid,p_issue_id text,p_command_id text,
  p_payload_hash text,p_expected_version integer,p_kind text,p_data jsonb,p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor text; actor_role text; existing public.qa_issues%ROWTYPE; receipt public.qa_commands%ROWTYPE; result jsonb; allowed boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  SELECT id,role::text INTO actor,actor_role FROM public.members WHERE auth_id=p_auth_id AND is_active=true LIMIT 1;
  IF actor IS NULL THEN RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
  IF length(p_command_id) NOT BETWEEN 8 AND 200 OR length(p_payload_hash)<>64 THEN
    RAISE EXCEPTION 'invalid_command' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-command:'||p_command_id));
  SELECT * INTO receipt FROM public.qa_commands WHERE id=p_command_id AND workspace_id='default';
  IF FOUND THEN
    IF receipt.actor_id<>actor OR receipt.issue_id<>p_issue_id OR receipt.payload_hash<>p_payload_hash THEN
      RAISE EXCEPTION 'command_id_reused' USING ERRCODE='23505'; END IF;
    RETURN receipt.response;
  END IF;
  SELECT * INTO existing FROM public.qa_issues WHERE id=p_issue_id AND workspace_id='default' FOR UPDATE;
  IF p_kind IN ('create','command') THEN
    IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_data->>'projectId' AND NOT is_archived) THEN
      RAISE EXCEPTION 'invalid_issue: project unavailable' USING ERRCODE='22023'; END IF;
    IF p_event->>'type' IN ('triage','submit_fix') AND
      (NOT EXISTS(SELECT 1 FROM public.members WHERE id=p_data->>'assigneeId' AND is_active=true)
       OR NOT EXISTS(SELECT 1 FROM public.members WHERE id=p_data->>'qaOwnerId' AND is_active=true)) THEN
      RAISE EXCEPTION 'invalid_issue: member unavailable' USING ERRCODE='22023'; END IF;
    IF p_event->>'type'='link_tasks' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_data->'taskIds') t
      WHERE NOT EXISTS(SELECT 1 FROM public.tasks WHERE id=t AND project_id=p_data->>'projectId')) THEN
      RAISE EXCEPTION 'invalid_issue: task unavailable' USING ERRCODE='22023'; END IF;
    IF p_data->>'resolution'='duplicate' AND NOT EXISTS(SELECT 1 FROM public.qa_issues
      WHERE id=p_data->>'duplicateOfId' AND id<>p_issue_id AND workspace_id='default') THEN
      RAISE EXCEPTION 'invalid_issue: duplicate unavailable' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_kind='create' THEN
    IF FOUND THEN RAISE EXCEPTION 'issue_exists' USING ERRCODE='23505'; END IF;
    IF NOT COALESCE((p_data->>'observedEnvironment')=ANY(public.livo_deployment_environment_values()),false) THEN
      RAISE EXCEPTION 'qa_invalid_environment' USING ERRCODE='22023'; END IF;
    IF p_data->>'id' IS DISTINCT FROM p_issue_id OR p_data->>'workspaceId'<>'default'
      OR p_data->>'reporterId' IS DISTINCT FROM actor OR (p_data->>'version')::integer<>1 THEN
      RAISE EXCEPTION 'invalid_issue' USING ERRCODE='22023'; END IF;
    INSERT INTO public.qa_issues(id,project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data)
      VALUES(p_issue_id,p_data->>'projectId',p_data->>'state',p_data->>'assigneeId',p_data->>'qaOwnerId',actor,
        p_data->>'title',1,(p_data->>'updatedAt')::timestamptz,p_data);
    result:=p_data;
  ELSE
    IF NOT FOUND THEN RAISE EXCEPTION 'issue_not_found' USING ERRCODE='P0002'; END IF;
    IF p_kind='command' THEN
      IF existing.version<>p_expected_version THEN RAISE EXCEPTION 'version_conflict' USING ERRCODE='40001'; END IF;
      allowed:=actor_role IN ('admin','super_admin') OR CASE p_event->>'type'
        WHEN 'triage' THEN actor=existing.qa_owner_id
        WHEN 'record_verification' THEN actor=existing.qa_owner_id
        WHEN 'close' THEN actor=existing.qa_owner_id
        WHEN 'start_fix' THEN actor=existing.assignee_id
        WHEN 'submit_fix' THEN actor=existing.assignee_id
        WHEN 'record_deployment' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id
        WHEN 'link_tasks' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id
        WHEN 'edit' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id
        WHEN 'hold' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id
        WHEN 'reopen' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id
        ELSE false END;
      IF NOT COALESCE(allowed,false) THEN RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
      IF p_data->>'id' IS DISTINCT FROM p_issue_id OR p_data->>'workspaceId'<>'default'
        OR p_data->>'reporterId' IS DISTINCT FROM existing.reporter_id
        OR (p_data->>'version')::integer<>existing.version+1 THEN
        RAISE EXCEPTION 'invalid_issue' USING ERRCODE='22023'; END IF;
      -- The command receipt is checked first, so an already committed request
      -- remains replayable after a choice is retired. Unchanged legacy values
      -- and non-environment commands keep the issue's exact historical text.
      IF p_event->>'type'='edit'
        AND p_data->>'observedEnvironment' IS DISTINCT FROM existing.data->>'observedEnvironment'
        AND NOT COALESCE((p_data->>'observedEnvironment')=ANY(public.livo_deployment_environment_values()),false) THEN
        RAISE EXCEPTION 'qa_invalid_environment' USING ERRCODE='22023';
      END IF;
      IF p_event->>'type'='submit_fix' THEN
        IF jsonb_typeof(p_data->'targets') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'qa_invalid_environment' USING ERRCODE='22023'; END IF;
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'targets') target
          WHERE NOT COALESCE((target->>'environment')=ANY(public.livo_deployment_environment_values()),false)) THEN
          RAISE EXCEPTION 'qa_invalid_environment' USING ERRCODE='22023'; END IF;
      END IF;
      UPDATE public.qa_issues SET state=p_data->>'state',assignee_id=p_data->>'assigneeId',
        qa_owner_id=p_data->>'qaOwnerId',title=p_data->>'title',version=(p_data->>'version')::integer,
        updated_at=(p_data->>'updatedAt')::timestamptz,data=p_data WHERE id=p_issue_id AND workspace_id='default';
      result:=p_data;
    ELSIF p_kind='comment' THEN
      INSERT INTO public.qa_comments(id,issue_id,actor_id,body,created_at)
        VALUES(p_data->>'id',p_issue_id,actor,p_data->>'body',(p_data->>'createdAt')::timestamptz);
      result:=p_data;
    ELSE RAISE EXCEPTION 'invalid_command' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_kind<>'comment' THEN
    INSERT INTO public.qa_events(id,issue_id,actor_id,type,detail,version,created_at)
      VALUES(p_event->>'id',p_issue_id,actor,p_event->>'type',COALESCE(p_event->>'detail',''),
        (p_data->>'version')::integer,(p_data->>'updatedAt')::timestamptz);
  END IF;
  INSERT INTO public.qa_commands(id,issue_id,actor_id,payload_hash,response)
    VALUES(p_command_id,p_issue_id,actor,p_payload_hash,result);
  INSERT INTO public.notifications(recipient_id,sender_id,type,task_id,content)
    SELECT m.id,actor,'qa_update',null,jsonb_build_object('kind','qa','issueId',p_issue_id,
      'title',CASE WHEN p_kind='comment' THEN existing.title ELSE p_data->>'title' END,'event',p_event->>'type')::text
    FROM public.members m WHERE m.is_active=true AND m.id<>actor
      AND m.id IN (SELECT jsonb_array_elements_text(COALESCE(p_event->'recipients','[]'::jsonb)));
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
