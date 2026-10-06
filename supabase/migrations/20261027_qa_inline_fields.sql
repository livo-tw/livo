-- QA metadata edits preserve the complete workflow and evidence snapshot.
-- This repeatable service-only RPC retains identity, CAS, workspace and receipt guards.
CREATE OR REPLACE FUNCTION public.livo_qa_commit(p_auth_id uuid,p_issue_id text,p_command_id text,
  p_payload_hash text,p_expected_version integer,p_kind text,p_data jsonb,p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE prior_source_channel text:=current_setting('livo.qa_slack_channel',true); prior_source_team text:=current_setting('livo.qa_slack_team',true); actor text; actor_role text; existing public.qa_issues%ROWTYPE; receipt public.qa_commands%ROWTYPE; result jsonb; allowed boolean; coordinator boolean; h jsonb; previous_h jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  actor:=public.livo_qa_live_actor(p_auth_id,p_event->'slackIdentity');
  SELECT role::text INTO actor_role FROM public.members WHERE id=actor;
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
    IF p_data->>'id' IS DISTINCT FROM p_issue_id OR p_data->>'workspaceId'<>'default'
      OR p_data->>'reporterId' IS DISTINCT FROM actor OR (p_data->>'version')::integer<>1 THEN
      RAISE EXCEPTION 'invalid_issue' USING ERRCODE='22023'; END IF;
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
        WHEN 'record_deployment' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id
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
      IF p_event->>'type'='update_fields' THEN
        IF (p_data-ARRAY['projectId','assigneeId','qaOwnerId','severity','priority','dueDate','version','updatedAt'])
          IS DISTINCT FROM (existing.data-ARRAY['projectId','assigneeId','qaOwnerId','severity','priority','dueDate','version','updatedAt']) THEN
          RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
        IF jsonb_typeof(p_data->'severity') IS DISTINCT FROM 'string' OR p_data->>'severity' NOT IN ('untriaged','low','medium','high')
          OR jsonb_typeof(p_data->'priority') IS DISTINCT FROM 'number' OR p_data->>'priority' !~ '^[1-5]$'
          OR NOT p_data ?& ARRAY['projectId','assigneeId','qaOwnerId','severity','priority','dueDate']
          OR EXISTS(SELECT 1 FROM unnest(ARRAY['assigneeId','qaOwnerId']) field
            WHERE jsonb_typeof(p_data->field) NOT IN ('null','string')
              OR (p_data->>field IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.members WHERE id=p_data->>field AND is_active=true))) THEN
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
          PERFORM 1 FROM public.members WHERE id=h->>'nextOwnerId' AND is_active FOR SHARE;
          IF NOT FOUND THEN RAISE EXCEPTION 'qa_member_unavailable' USING ERRCODE='22023'; END IF;
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
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'targets') target
          WHERE NOT COALESCE((target->>'environment')=ANY(public.livo_deployment_environment_values()),false)) THEN
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
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) TO service_role;
