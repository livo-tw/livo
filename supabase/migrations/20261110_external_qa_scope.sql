-- External QA shares the QA domain without becoming an ordinary workspace member.
CREATE TABLE IF NOT EXISTS public.external_qa_accounts (
  id text PRIMARY KEY CHECK (id ~ '^eqa-[A-Za-z0-9_-]{4,96}$'),
  auth_id uuid NOT NULL UNIQUE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.external_qa_project_grants (
  account_id text NOT NULL REFERENCES public.external_qa_accounts(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, project_id)
);
CREATE INDEX IF NOT EXISTS external_qa_grants_project_idx ON public.external_qa_project_grants(project_id, account_id);

ALTER TABLE public.external_qa_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_qa_project_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.external_qa_accounts, public.external_qa_project_grants FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.external_qa_accounts, public.external_qa_project_grants TO service_role;

-- The same GoTrue login must not become a normal member through activation,
-- import, invitation, or reassignment. Serialize both directions of the check.
CREATE OR REPLACE FUNCTION public.livo_qa_identity_separation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('livo-qa-actor:' || NEW.id, 0));
  IF NEW.auth_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('livo-qa-login:' || NEW.auth_id::text, 0));
  END IF;
  IF TG_TABLE_NAME = 'members' THEN
    IF EXISTS (SELECT 1 FROM public.external_qa_accounts a WHERE a.id=NEW.id OR a.auth_id=NEW.auth_id) THEN
      RAISE EXCEPTION 'qa_external_identity_conflict' USING ERRCODE='42501';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.members m WHERE m.id=NEW.id OR m.auth_id=NEW.auth_id) THEN
    RAISE EXCEPTION 'qa_external_identity_conflict' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_identity_separation() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_qa_identity_separation ON public.members;
CREATE TRIGGER livo_qa_identity_separation BEFORE INSERT OR UPDATE OF id,auth_id ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.livo_qa_identity_separation();
DROP TRIGGER IF EXISTS livo_qa_identity_separation ON public.external_qa_accounts;
CREATE TRIGGER livo_qa_identity_separation BEFORE INSERT OR UPDATE OF id,auth_id ON public.external_qa_accounts
  FOR EACH ROW EXECUTE FUNCTION public.livo_qa_identity_separation();

CREATE OR REPLACE FUNCTION public.livo_qa_scoped_actor(p_auth_id uuid,p_identity jsonb DEFAULT NULL)
RETURNS TABLE (actor_id text,is_external boolean)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE account public.external_qa_accounts%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  SELECT a.* INTO account FROM public.external_qa_accounts a WHERE a.auth_id=p_auth_id FOR SHARE;
  IF FOUND THEN
    IF NOT account.is_active OR (p_identity IS NOT NULL AND p_identity<>'null'::jsonb) THEN
      RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501';
    END IF;
    RETURN QUERY SELECT account.id,true;
  ELSE
    RETURN QUERY SELECT public.livo_qa_live_actor(p_auth_id,p_identity),false;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.livo_qa_lock_external_project(p_actor text,p_project_id text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.external_qa_project_grants g
    WHERE g.account_id=p_actor AND g.project_id=p_project_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.livo_qa_external_roster(p_project_id text)
RETURNS TABLE(id text,name text,avatar text,color text,job_title text,is_active boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
  WITH participants(id) AS (
    SELECT unnest(ARRAY[q.assignee_id,q.qa_owner_id,q.reporter_id,q.data->'handoff'->>'nextOwnerId',
      q.data->'handoff'->>'requestedBy',q.data->'handoff'->>'acceptedBy',q.data->'handoff'->>'resolvedBy'])
    FROM public.qa_issues q WHERE q.workspace_id='default' AND q.project_id=p_project_id
    UNION
    SELECT c.coordinator_id FROM public.qa_project_coordination c WHERE c.id=p_project_id
  )
  SELECT m.id,m.name,m.avatar,m.color,m.job_title,m.is_active
  FROM public.members m JOIN participants p ON p.id=m.id
  UNION ALL
  SELECT a.id,a.name,''::text,''::text,''::text,a.is_active
  FROM public.external_qa_accounts a JOIN public.external_qa_project_grants g ON g.account_id=a.id
  WHERE g.project_id=p_project_id AND a.is_active;
$$;

CREATE OR REPLACE FUNCTION public.livo_qa_person_available(p_project_id text,p_person text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.members m WHERE m.id=p_person AND m.is_active FOR SHARE;
  IF FOUND THEN RETURN true; END IF;
  PERFORM 1 FROM public.external_qa_accounts a JOIN public.external_qa_project_grants g ON g.account_id=a.id
    WHERE a.id=p_person AND a.is_active AND g.project_id=p_project_id FOR SHARE OF a,g;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.livo_qa_scoped_actor(uuid,jsonb),public.livo_qa_lock_external_project(text,text),
  public.livo_qa_external_roster(text),public.livo_qa_person_available(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_scoped_actor(uuid,jsonb),public.livo_qa_lock_external_project(text,text),
  public.livo_qa_external_roster(text),public.livo_qa_person_available(text,text) TO service_role;

-- A QA response may reference ordinary work only by IDs in its own project.
-- Strip provider import identifiers from the external projection.
CREATE OR REPLACE FUNCTION public.livo_qa_external_issue_data(p_data jsonb,p_project_id text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
  SELECT (p_data - 'legacySource') || jsonb_build_object('projectId',p_project_id,'taskIds',COALESCE((
    SELECT jsonb_agg(v.task_id ORDER BY v.position)
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_data->'taskIds')='array' THEN p_data->'taskIds' ELSE '[]'::jsonb END)
      WITH ORDINALITY AS v(task_id,position)
    JOIN public.tasks t ON t.id=v.task_id AND t.project_id=p_project_id
  ),'[]'::jsonb),'duplicateOfId',(
    SELECT q.id FROM public.qa_issues q
    WHERE q.id=p_data->>'duplicateOfId' AND q.project_id=p_project_id AND q.workspace_id='default'
  ));
$$;
REVOKE ALL ON FUNCTION public.livo_qa_external_issue_data(jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_external_issue_data(jsonb,text) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_commit(p_auth_id uuid,p_issue_id text,p_command_id text,
  p_payload_hash text,p_expected_version integer,p_kind text,p_data jsonb,p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE prior_source_channel text:=current_setting('livo.qa_slack_channel',true); prior_source_team text:=current_setting('livo.qa_slack_team',true); actor text; actor_role text; is_external boolean; scope_project text; existing public.qa_issues%ROWTYPE; receipt public.qa_commands%ROWTYPE; result jsonb; allowed boolean; coordinator boolean; h jsonb; previous_h jsonb; run jsonb; target jsonb; passed boolean; expected_state text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  SELECT s.actor_id,s.is_external INTO actor,is_external FROM public.livo_qa_scoped_actor(p_auth_id,p_event->'slackIdentity') s;
  IF is_external THEN
    actor_role:='member';
    SELECT q.project_id INTO scope_project FROM public.qa_issues q WHERE q.id=p_issue_id AND q.workspace_id='default';
    -- This lock and grant check precede the command receipt. A move or revoke
    -- must not make an earlier successful command replayable across scope.
    IF p_kind='create' THEN
      PERFORM public.livo_qa_lock_external_project(actor,p_data->>'projectId');
      IF scope_project IS NOT NULL THEN PERFORM public.livo_qa_lock_external_project(actor,scope_project); END IF;
    ELSE
      PERFORM public.livo_qa_lock_external_project(actor,scope_project);
    END IF;
    IF p_kind='command' AND p_data->>'projectId' IS DISTINCT FROM scope_project THEN
      PERFORM public.livo_qa_lock_external_project(actor,p_data->>'projectId');
    END IF;
  ELSE
    SELECT role::text INTO actor_role FROM public.members WHERE id=actor;
  END IF;
  IF actor IS NULL THEN RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
  IF length(p_command_id) NOT BETWEEN 8 AND 200 OR length(p_payload_hash)<>64 THEN
    RAISE EXCEPTION 'invalid_command' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-command:'||p_command_id));
  SELECT * INTO receipt FROM public.qa_commands WHERE id=p_command_id AND workspace_id='default';
  IF FOUND THEN
    IF receipt.actor_id<>actor OR receipt.issue_id<>p_issue_id OR receipt.payload_hash<>p_payload_hash THEN
      RAISE EXCEPTION 'command_id_reused' USING ERRCODE='23505'; END IF;
    IF is_external AND receipt.response ? 'projectId' THEN
      PERFORM public.livo_qa_lock_external_project(actor,receipt.response->>'projectId');
      RETURN public.livo_qa_external_issue_data(receipt.response,receipt.response->>'projectId');
    END IF;
    RETURN receipt.response;
  END IF;
  -- Lock the project before the aggregate; archive cannot commit midway.
  PERFORM 1 FROM public.projects WHERE id=CASE WHEN p_kind='create' THEN p_data->>'projectId'
    ELSE (SELECT project_id FROM public.qa_issues WHERE id=p_issue_id AND workspace_id='default') END AND NOT is_archived FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qa_project_unavailable' USING ERRCODE='P0002'; END IF;
  -- This service-only RPC already verified the live Slack binding above. The
  -- source comes from the authenticated member JWT, never frontend metadata.
  PERFORM set_config('livo.qa_slack_channel',CASE WHEN p_event->'slackIdentity'->>'bindingId' IS NOT NULL
    AND COALESCE(p_event->'slackSource'->>'channel','') ~ '^[CDG][A-Z0-9]+$' THEN p_event->'slackSource'->>'channel' ELSE '' END,true);
  PERFORM set_config('livo.qa_slack_team',COALESCE(p_event->'slackIdentity'->>'teamId',''),true);
  SELECT * INTO existing FROM public.qa_issues WHERE id=p_issue_id AND workspace_id='default' FOR UPDATE;
  IF is_external AND p_kind<>'create' AND existing.project_id IS DISTINCT FROM scope_project THEN
    RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
  IF is_external AND (p_kind='create' OR (p_kind='command' AND p_event->>'type' IN ('triage','update_fields','submit_fix'))) AND EXISTS(
    SELECT 1 FROM unnest(ARRAY['assigneeId','qaOwnerId']) field
    WHERE p_data->>field IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM public.livo_qa_external_roster(p_data->>'projectId') r WHERE r.id=p_data->>field AND r.is_active)
  ) THEN RAISE EXCEPTION 'qa_member_unavailable' USING ERRCODE='22023'; END IF;
  IF p_kind IN ('create','command') THEN
    IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_data->>'projectId' AND NOT is_archived) THEN
      RAISE EXCEPTION 'invalid_issue: project unavailable' USING ERRCODE='22023'; END IF;
    IF p_event->>'type' IN ('triage','submit_fix') AND
      (NOT public.livo_qa_person_available(p_data->>'projectId',p_data->>'assigneeId')
       OR NOT public.livo_qa_person_available(p_data->>'projectId',p_data->>'qaOwnerId')) THEN
      RAISE EXCEPTION 'invalid_issue: member unavailable' USING ERRCODE='22023'; END IF;
    IF p_event->>'type'='link_tasks' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_data->'taskIds') t
      WHERE NOT EXISTS(SELECT 1 FROM public.tasks WHERE id=t AND project_id=p_data->>'projectId')) THEN
      RAISE EXCEPTION 'invalid_issue: task unavailable' USING ERRCODE='22023'; END IF;
    IF p_data->>'resolution'='duplicate' AND NOT EXISTS(SELECT 1 FROM public.qa_issues
      WHERE id=p_data->>'duplicateOfId' AND id<>p_issue_id AND workspace_id='default'
        AND (NOT is_external OR project_id=p_data->>'projectId')) THEN
      RAISE EXCEPTION 'invalid_issue: duplicate unavailable' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_kind='create' THEN
    IF FOUND THEN RAISE EXCEPTION 'issue_exists' USING ERRCODE='23505'; END IF;
    IF p_data->>'id' IS DISTINCT FROM p_issue_id OR p_data->>'workspaceId'<>'default'
      OR p_data->>'reporterId' IS DISTINCT FROM actor OR (p_data->>'version')::integer<>1 THEN
      RAISE EXCEPTION 'invalid_issue' USING ERRCODE='22023'; END IF;
    -- Initial settings are validated again in the commit transaction. Lock only
    -- selected active owners: concurrent deactivation cannot commit midway.
    -- Historical restore/import keeps its separate evidence-preserving contract.
    IF EXISTS(SELECT 1 FROM unnest(ARRAY['assigneeId','qaOwnerId']) field
      WHERE p_data->>field IS NOT NULL AND (jsonb_typeof(p_data->field) IS DISTINCT FROM 'string'
        OR p_data->>field !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$'
        OR NOT public.livo_qa_person_available(p_data->>'projectId',p_data->>field))) THEN
      RAISE EXCEPTION 'qa_member_unavailable' USING ERRCODE='22023'; END IF;
    IF jsonb_typeof(p_data->'priority') IS DISTINCT FROM 'number' OR p_data->>'priority' !~ '^[1-5]$' THEN
      RAISE EXCEPTION 'qa_invalid_priority' USING ERRCODE='22023'; END IF;
    IF p_data->>'dueDate' IS NOT NULL THEN
      IF jsonb_typeof(p_data->'dueDate') IS DISTINCT FROM 'string' OR p_data->>'dueDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'qa_invalid_date' USING ERRCODE='22023'; END IF;
      BEGIN
        IF to_char((p_data->>'dueDate')::date,'YYYY-MM-DD')<>p_data->>'dueDate' THEN
          RAISE EXCEPTION 'qa_invalid_date' USING ERRCODE='22023'; END IF;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
        RAISE EXCEPTION 'qa_invalid_date' USING ERRCODE='22023';
      END;
    END IF;
    IF NOT COALESCE((p_data->>'observedEnvironment')=ANY(public.livo_deployment_environment_values()),false) THEN
      RAISE EXCEPTION 'qa_invalid_environment' USING ERRCODE='22023'; END IF;
    PERFORM public.livo_qa_validate_custom_fields(COALESCE(p_data->'customFields','{}'::jsonb),'{}'::jsonb);
    INSERT INTO public.qa_issues(id,project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data)
      VALUES(p_issue_id,p_data->>'projectId',p_data->>'state',p_data->>'assigneeId',p_data->>'qaOwnerId',actor,
        p_data->>'title',1,(p_data->>'updatedAt')::timestamptz,p_data);
    result:=p_data;
  ELSE
    IF NOT FOUND THEN RAISE EXCEPTION 'issue_not_found' USING ERRCODE='P0002'; END IF;
    IF p_kind='command' THEN
      IF existing.version<>p_expected_version THEN RAISE EXCEPTION 'version_conflict' USING ERRCODE='PT409'; END IF;
      coordinator:=EXISTS(SELECT 1 FROM public.qa_project_coordination WHERE id=existing.project_id AND coordinator_id=actor);
      allowed:=CASE p_event->>'type'
        WHEN 'accept_handoff' THEN actor=existing.data->'handoff'->>'nextOwnerId' AND existing.data->'handoff'->>'acceptedAt' IS NULL AND existing.data->'handoff'->>'resolvedAt' IS NULL
        WHEN 'resolve_handoff' THEN (actor_role IN ('admin','super_admin') OR actor=existing.data->'handoff'->>'nextOwnerId') AND existing.data->'handoff'->>'resolvedAt' IS NULL
        ELSE actor_role IN ('admin','super_admin') OR CASE p_event->>'type'
        WHEN 'triage' THEN true
        WHEN 'update_fields' THEN true
        WHEN 'record_verification' THEN actor=existing.qa_owner_id
        WHEN 'close' THEN actor=existing.qa_owner_id
        WHEN 'start_fix' THEN actor=existing.assignee_id
        WHEN 'submit_fix' THEN actor=existing.assignee_id
        WHEN 'record_deployment' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR (NOT is_external AND public.livo_is_deployment_queue_operator(actor))
        WHEN 'link_tasks' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id
        WHEN 'set_state' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id
        WHEN 'edit' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id
        WHEN 'hold' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id OR coordinator
        WHEN 'request_handoff' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id OR coordinator
        WHEN 'reopen' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id
        ELSE false END END;
      IF NOT COALESCE(allowed,false) THEN RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
      IF p_data->>'id' IS DISTINCT FROM p_issue_id OR p_data->>'workspaceId'<>'default'
        OR p_data->>'reporterId' IS DISTINCT FROM existing.reporter_id
        OR (p_data->>'version')::integer<>existing.version+1 THEN
        RAISE EXCEPTION 'invalid_issue' USING ERRCODE='22023'; END IF;
      IF (p_data->>'projectId' IS DISTINCT FROM existing.project_id AND p_event->>'type'<>'update_fields') OR p_event->>'type' NOT IN
        ('set_state','update_fields','edit','triage','start_fix','submit_fix','record_deployment','record_verification','close','reopen','hold','link_tasks','request_handoff','accept_handoff','resolve_handoff')
        OR (existing.state IN ('closed','dismissed') AND p_event->>'type' NOT IN ('reopen','set_state','update_fields')) THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;

      IF p_event->>'type'='record_verification' THEN
        IF existing.state NOT IN ('verification','verified')
          OR (p_data-ARRAY['runs','state','resolution','resolutionReason','duplicateOfId','closedAt','closedBy','reopenedAt','version','updatedAt'])
            IS DISTINCT FROM (existing.data-ARRAY['runs','state','resolution','resolutionReason','duplicateOfId','closedAt','closedBy','reopenedAt','version','updatedAt'])
          OR jsonb_typeof(p_data->'runs') IS DISTINCT FROM 'array'
          OR jsonb_array_length(p_data->'runs')<>jsonb_array_length(existing.data->'runs')+1
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(existing.data->'runs') WITH ORDINALITY old(v,n)
            WHERE old.v IS DISTINCT FROM (p_data->'runs')->(old.n::integer-1)) THEN
          RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
        run:=(p_data->'runs')->(jsonb_array_length(p_data->'runs')-1);
        SELECT t INTO target FROM jsonb_array_elements(existing.data->'targets') t WHERE t->>'id'=run->>'targetId';
        IF target IS NULL OR jsonb_typeof(target->'deployedAt') IS DISTINCT FROM 'string' OR COALESCE(target->>'deployedAt','')='' THEN
          RAISE EXCEPTION 'qa_not_deployed' USING ERRCODE='22023'; END IF;
        IF run->>'fixCycle' IS DISTINCT FROM existing.data->>'fixCycle'
          OR run->>'build' IS DISTINCT FROM target->>'build' OR run->>'environment' IS DISTINCT FROM target->>'environment'
          OR run->>'component' IS DISTINCT FROM target->>'component' OR run->>'testerId' IS DISTINCT FROM actor
          OR NOT run ?& ARRAY['id','sequence','fixCycle','targetId','environment','component','build','result','note','testerId','createdAt']
          OR run->>'createdAt' IS DISTINCT FROM p_data->>'updatedAt' OR run->>'result' IS NULL OR run->>'result' NOT IN ('pass','fail','blocked')
          OR jsonb_typeof(run->'note') IS DISTINCT FROM 'string' OR length(run->>'note')>8000
          OR jsonb_typeof(run->'id') IS DISTINCT FROM 'string' OR run->>'id' !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$'
          OR (run->>'sequence')::integer IS DISTINCT FROM
            (SELECT COALESCE(max((v->>'sequence')::integer),0)+1 FROM jsonb_array_elements(existing.data->'runs') v) THEN
          RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
        passed:=public.livo_qa_required_targets_passed(p_data);
        expected_state:=CASE WHEN run->>'result'='fail' THEN 'failed'
          WHEN run->>'result'='pass' AND passed THEN 'closed' WHEN passed THEN 'verified' ELSE 'verification' END;
        IF p_data->>'state' IS DISTINCT FROM expected_state THEN
          RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
        IF expected_state='closed' THEN
          IF p_data->>'resolution' IS DISTINCT FROM 'fixed' OR p_data->>'resolutionReason' IS DISTINCT FROM ''
            OR p_data->>'duplicateOfId' IS NOT NULL OR p_data->>'closedAt' IS DISTINCT FROM p_data->>'updatedAt'
            OR p_data->>'closedBy' IS DISTINCT FROM actor
            OR p_data->'reopenedAt' IS DISTINCT FROM existing.data->'reopenedAt' THEN
            RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
        ELSIF (p_data-ARRAY['runs','state','reopenedAt','version','updatedAt'])
          IS DISTINCT FROM (existing.data-ARRAY['runs','state','reopenedAt','version','updatedAt'])
          OR (run->>'result'='fail' AND p_data->>'reopenedAt' IS DISTINCT FROM p_data->>'updatedAt')
          OR (run->>'result'<>'fail' AND p_data->'reopenedAt' IS DISTINCT FROM existing.data->'reopenedAt') THEN
          RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
      END IF;
      IF p_event->>'type'='record_deployment' THEN
        IF existing.state NOT IN ('verification','verified')
          OR (p_data-ARRAY['targets','version','updatedAt']) IS DISTINCT FROM (existing.data-ARRAY['targets','version','updatedAt'])
          OR jsonb_typeof(p_data->'targets') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
        IF jsonb_array_length(p_data->'targets')<>jsonb_array_length(existing.data->'targets') OR jsonb_array_length(p_data->'targets')<1
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'targets') WITH ORDINALITY n(value,ord)
            JOIN jsonb_array_elements(existing.data->'targets') WITH ORDINALITY o(value,ord) USING(ord)
            WHERE (n.value-ARRAY['deployedAt','deployedBy','deploymentEvidence']) IS DISTINCT FROM (o.value-ARRAY['deployedAt','deployedBy','deploymentEvidence']))
          OR (SELECT count(*) FROM jsonb_array_elements(p_data->'targets') WITH ORDINALITY n(value,ord)
            JOIN jsonb_array_elements(existing.data->'targets') WITH ORDINALITY o(value,ord) USING(ord) WHERE n.value IS DISTINCT FROM o.value)>1
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'targets') WITH ORDINALITY n(value,ord)
            JOIN jsonb_array_elements(existing.data->'targets') WITH ORDINALITY o(value,ord) USING(ord)
            WHERE n.value IS DISTINCT FROM o.value AND (jsonb_typeof(n.value->'deployedAt') IS DISTINCT FROM 'string'
              OR n.value->>'deployedAt' IS DISTINCT FROM p_data->>'updatedAt' OR n.value->>'deployedBy' IS DISTINCT FROM actor
              OR jsonb_typeof(n.value->'deploymentEvidence') IS DISTINCT FROM 'string' OR length(n.value->>'deploymentEvidence')>8000)) THEN
          RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
      END IF;
      IF p_event->>'type'='update_fields' THEN
        IF (p_data-ARRAY['projectId','assigneeId','qaOwnerId','severity','priority','dueDate','version','updatedAt'])
          IS DISTINCT FROM (existing.data-ARRAY['projectId','assigneeId','qaOwnerId','severity','priority','dueDate','version','updatedAt']) THEN
          RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
        IF jsonb_typeof(p_data->'severity') IS DISTINCT FROM 'string' OR p_data->>'severity' NOT IN ('untriaged','low','medium','high')
          OR jsonb_typeof(p_data->'priority') IS DISTINCT FROM 'number' OR p_data->>'priority' !~ '^[1-5]$'
          OR NOT p_data ?& ARRAY['projectId','assigneeId','qaOwnerId','severity','priority','dueDate']
          OR EXISTS(SELECT 1 FROM unnest(ARRAY['assigneeId','qaOwnerId']) field
            WHERE jsonb_typeof(p_data->field) NOT IN ('null','string')
              OR (p_data->>field IS NOT NULL AND NOT public.livo_qa_person_available(p_data->>'projectId',p_data->>field))) THEN
          RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
        IF p_data->>'dueDate' IS NOT NULL AND (p_data->>'dueDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          OR to_char((p_data->>'dueDate')::date,'YYYY-MM-DD')<>p_data->>'dueDate') THEN
          RAISE EXCEPTION 'qa_invalid_date' USING ERRCODE='22023'; END IF;
        PERFORM 1 FROM public.projects WHERE id=p_data->>'projectId' AND NOT is_archived FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'qa_project_unavailable' USING ERRCODE='22023'; END IF;
        IF p_data->>'projectId' IS DISTINCT FROM existing.project_id AND EXISTS(
          SELECT 1 FROM jsonb_array_elements_text(existing.data->'taskIds') task_id
          WHERE NOT EXISTS(SELECT 1 FROM public.tasks WHERE id=task_id AND project_id=p_data->>'projectId')) THEN
          RAISE EXCEPTION 'qa_task_unavailable' USING ERRCODE='22023'; END IF;
        IF p_data->>'projectId' IS DISTINCT FROM existing.project_id AND p_data->>'duplicateOfId' IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM public.qa_issues WHERE id=p_data->>'duplicateOfId' AND project_id=p_data->>'projectId' AND workspace_id='default') THEN
          RAISE EXCEPTION 'qa_duplicate_unavailable' USING ERRCODE='22023'; END IF;
      END IF;
      h:=p_data->'handoff'; previous_h:=existing.data->'handoff';
      IF p_event->>'type' IN ('request_handoff','accept_handoff','resolve_handoff') THEN
        IF (p_data-ARRAY['handoff','version','updatedAt']) IS DISTINCT FROM (existing.data-ARRAY['handoff','version','updatedAt'])
          OR jsonb_typeof(h) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
        IF p_event->>'type'='request_handoff' THEN
          IF NOT public.livo_qa_person_available(existing.project_id,h->>'nextOwnerId')
            OR (is_external AND NOT EXISTS(SELECT 1 FROM public.livo_qa_external_roster(existing.project_id) r
              WHERE r.id=h->>'nextOwnerId' AND r.is_active))
          THEN RAISE EXCEPTION 'qa_member_unavailable' USING ERRCODE='22023'; END IF;
          IF COALESCE(btrim(h->>'reason'),'')='' OR length(h->>'reason')>8000 OR length(h->>'externalDependency')>2000
            OR h->>'requestedBy' IS DISTINCT FROM actor OR h->>'requestedAt' IS DISTINCT FROM p_data->>'updatedAt'
            OR h->>'acceptedBy' IS NOT NULL OR h->>'acceptedAt' IS NOT NULL OR h->>'resolvedBy' IS NOT NULL OR h->>'resolvedAt' IS NOT NULL
            OR COALESCE(h->>'resolutionEvidence','!')<>'' OR COALESCE(h->>'id','')='' OR h->>'id'=previous_h->>'id' THEN RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
          IF h->>'replyBy' IS NOT NULL AND (h->>'replyBy' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
            OR to_char((h->>'replyBy')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>h->>'replyBy') THEN RAISE EXCEPTION 'qa_invalid_date' USING ERRCODE='22023'; END IF;
        ELSIF p_event->>'type'='accept_handoff' THEN
          IF (h-ARRAY['acceptedBy','acceptedAt']) IS DISTINCT FROM (previous_h-ARRAY['acceptedBy','acceptedAt'])
            OR h->>'acceptedBy' IS DISTINCT FROM actor OR h->>'acceptedAt' IS DISTINCT FROM p_data->>'updatedAt' THEN RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
        ELSE
          IF (h-ARRAY['resolvedBy','resolvedAt','resolutionEvidence']) IS DISTINCT FROM (previous_h-ARRAY['resolvedBy','resolvedAt','resolutionEvidence'])
            OR h->>'resolvedBy' IS DISTINCT FROM actor OR h->>'resolvedAt' IS DISTINCT FROM p_data->>'updatedAt'
            OR COALESCE(btrim(h->>'resolutionEvidence'),'')='' OR length(h->>'resolutionEvidence')>8000 THEN RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
        END IF;
      ELSIF h IS DISTINCT FROM previous_h THEN RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
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
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'targets') AS fix_target(value)
          WHERE NOT COALESCE((fix_target.value->>'environment')=ANY(public.livo_deployment_environment_values()),false)) THEN
          RAISE EXCEPTION 'qa_invalid_environment' USING ERRCODE='22023'; END IF;
      END IF;
      IF p_event->>'type'='edit' THEN
        PERFORM public.livo_qa_validate_custom_fields(COALESCE(p_data->'customFields','{}'::jsonb),
          COALESCE(existing.data->'customFields','{}'::jsonb));
      END IF;
      UPDATE public.qa_issues SET project_id=p_data->>'projectId',state=p_data->>'state',assignee_id=p_data->>'assigneeId',
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
      AND (m.id IN (SELECT jsonb_array_elements_text(COALESCE(p_event->'recipients','[]'::jsonb)))
        OR (p_kind='create' AND m.id=(SELECT coordinator_id FROM public.qa_project_coordination WHERE id=p_data->>'projectId')));
  PERFORM set_config('livo.qa_slack_channel',COALESCE(prior_source_channel,''),true);
  PERFORM set_config('livo.qa_slack_team',COALESCE(prior_source_team,''),true);
  IF is_external AND p_kind<>'comment' THEN
    RETURN public.livo_qa_external_issue_data(result,result->>'projectId');
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_delete(p_auth_id uuid,p_issue_id text,p_expected_version integer,p_identity jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor text; is_external boolean; actor_member public.members%ROWTYPE; existing public.qa_issues%ROWTYPE; paths jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  SELECT s.actor_id,s.is_external INTO actor,is_external FROM public.livo_qa_scoped_actor(p_auth_id,p_identity) s;
  IF actor IS NULL THEN RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
  SELECT * INTO actor_member FROM public.members WHERE id=actor;
  SELECT * INTO existing FROM public.qa_issues WHERE id=p_issue_id AND workspace_id='default' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'issue_not_found' USING ERRCODE='P0002'; END IF;
  IF is_external THEN PERFORM public.livo_qa_lock_external_project(actor,existing.project_id); END IF;
  IF p_expected_version IS NULL OR existing.version<>p_expected_version THEN
    RAISE EXCEPTION 'qa_version_conflict' USING ERRCODE='PT409'; END IF;
  IF NOT ((NOT is_external AND (actor_member.role::text IN ('admin','super_admin') OR actor_member.is_qa_admin IS TRUE))
    OR (existing.reporter_id=actor AND existing.state='new')) THEN
    RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(jsonb_agg(DISTINCT s.path),'[]'::jsonb) INTO paths FROM (
    SELECT storage_path AS path FROM public.qa_attachments WHERE issue_id=p_issue_id AND workspace_id='default'
    UNION SELECT storage_path FROM public.qa_uploads WHERE issue_id=p_issue_id AND workspace_id='default') s;
  INSERT INTO public.activity_logs(user_id,action,target_type,task_id,task_key,detail)
    VALUES(actor,'delete_qa_issue','qa',p_issue_id,'#'||right(p_issue_id,8),existing.title);
  DELETE FROM public.qa_slack_links WHERE issue_id=p_issue_id AND workspace_id='default';
  DELETE FROM public.qa_attachments WHERE issue_id=p_issue_id AND workspace_id='default';
  DELETE FROM public.qa_uploads WHERE issue_id=p_issue_id AND workspace_id='default';
  DELETE FROM public.qa_comments WHERE issue_id=p_issue_id AND workspace_id='default';
  DELETE FROM public.qa_events WHERE issue_id=p_issue_id AND workspace_id='default';
  DELETE FROM public.qa_commands WHERE issue_id=p_issue_id AND workspace_id='default';
  -- Bug notifications are JSON written by livo_qa_commit; anything else is left alone.
  DELETE FROM public.notifications WHERE type='qa_update' AND position(p_issue_id in content)>0
    AND public.livo_qa_notification_issue(content)=p_issue_id;
  DELETE FROM public.qa_issues WHERE id=p_issue_id AND workspace_id='default';
  RETURN jsonb_build_object('id',p_issue_id,'deleted',true,'paths',paths);
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_delete(uuid,text,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_delete(uuid,text,integer,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_finalize_upload(p_auth_id uuid,p_upload_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,storage AS $$
DECLARE actor text; is_external boolean; project text; u public.qa_uploads%ROWTYPE; obj storage.objects%ROWTYPE; a public.qa_attachments%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  SELECT s.actor_id,s.is_external INTO actor,is_external FROM public.livo_qa_scoped_actor(p_auth_id) s;
  IF actor IS NULL THEN RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
  SELECT * INTO u FROM public.qa_uploads WHERE id=p_upload_id AND workspace_id='default' FOR UPDATE;
  IF NOT FOUND OR u.actor_id<>actor THEN RAISE EXCEPTION 'upload_not_found' USING ERRCODE='P0002'; END IF;
  IF is_external THEN
    SELECT q.project_id INTO project FROM public.qa_issues q WHERE q.id=u.issue_id AND q.workspace_id='default' FOR SHARE;
    PERFORM public.livo_qa_lock_external_project(actor,project);
  END IF;
  SELECT * INTO a FROM public.qa_attachments WHERE id=u.id AND workspace_id='default';
  IF FOUND THEN RETURN to_jsonb(a); END IF;
  IF u.expires_at<now() THEN RAISE EXCEPTION 'upload_expired' USING ERRCODE='22023'; END IF;
  SELECT * INTO obj FROM storage.objects WHERE bucket_id='qa-evidence' AND name=u.storage_path FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'upload_incomplete' USING ERRCODE='22023'; END IF;
  IF COALESCE((obj.metadata->>'size')::bigint,-1)<>u.size
    OR lower(COALESCE(obj.metadata->>'mimetype',''))<>u.mime_type THEN
    RAISE EXCEPTION 'upload_metadata_mismatch' USING ERRCODE='22023'; END IF;
  INSERT INTO public.qa_attachments(id,issue_id,uploaded_by,file_name,mime_type,size,storage_path,created_at)
    VALUES(u.id,u.issue_id,actor,u.file_name,u.mime_type,u.size,u.storage_path,now()) RETURNING * INTO a;
  UPDATE public.qa_uploads SET completed_at=now() WHERE id=u.id AND workspace_id='default';
  RETURN to_jsonb(a);
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_finalize_upload(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_finalize_upload(uuid,text) TO service_role;

-- Reservation creation and issue-scope verification share one transaction.
CREATE OR REPLACE FUNCTION public.livo_qa_external_reserve_upload(p_auth_id uuid,p_issue_id text,p_upload_id text,
  p_name text,p_mime text,p_size bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE actor text; is_external boolean; project text; u public.qa_uploads%ROWTYPE;
BEGIN
  SELECT s.actor_id,s.is_external INTO actor,is_external FROM public.livo_qa_scoped_actor(p_auth_id) s;
  IF NOT is_external THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
  SELECT q.project_id INTO project FROM public.qa_issues q WHERE q.id=p_issue_id AND q.workspace_id='default' FOR SHARE;
  PERFORM public.livo_qa_lock_external_project(actor,project);
  INSERT INTO public.qa_uploads(id,issue_id,actor_id,file_name,mime_type,size,storage_path,created_at,expires_at)
    VALUES(p_upload_id,p_issue_id,actor,p_name,p_mime,p_size,'default/'||p_issue_id||'/'||p_upload_id,now(),now()+interval '2 hours')
    RETURNING * INTO u;
  RETURN to_jsonb(u);
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_external_reserve_upload(uuid,text,text,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_external_reserve_upload(uuid,text,text,text,text,bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_guard_qa_object()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,storage AS $$
BEGIN
  IF NEW.bucket_id='qa-evidence' THEN
    -- Storage may refresh access timestamps while serving an existing object.
    -- That does not grant permission to replace its bytes, path or metadata.
    IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['last_accessed_at','updated_at'])=
      (to_jsonb(OLD)-ARRAY['last_accessed_at','updated_at']) THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
    IF NOT public.livo_qa_enabled() OR NOT EXISTS(SELECT 1 FROM public.qa_uploads u
      JOIN public.qa_issues q ON q.id=u.issue_id AND q.workspace_id=u.workspace_id
      WHERE u.storage_path=NEW.name AND u.workspace_id='default' AND u.completed_at IS NULL AND u.expires_at>now()
        AND public.livo_qa_person_available(q.project_id,u.actor_id)) THEN
      RAISE EXCEPTION 'qa_upload_unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

SELECT public.livo_apply_active_member_gate();
NOTIFY pgrst, 'reload schema';
