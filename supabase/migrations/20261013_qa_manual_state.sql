-- Manual state changes use the same active participant permission as issue edits.
-- Preserve the final environment/receipt guards; the shared domain owns state and evidence semantics.
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
        WHEN 'set_state' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id
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
