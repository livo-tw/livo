-- Optional project coordination and versioned QA handoffs. No state-machine replacement.
CREATE TABLE IF NOT EXISTS public.qa_project_coordination (
 id text PRIMARY KEY REFERENCES public.projects(id), workspace_id text NOT NULL DEFAULT 'default' CHECK(workspace_id='default'),
 coordinator_id text REFERENCES public.members(id), version integer NOT NULL CHECK(version>0), updated_by text NOT NULL REFERENCES public.members(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.qa_coordination_commands (
 id text PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default' CHECK(workspace_id='default'), project_id text NOT NULL REFERENCES public.projects(id),
 actor_id text NOT NULL REFERENCES public.members(id), payload_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.qa_project_coordination ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qa_coordination_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.qa_project_coordination,public.qa_coordination_commands FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.qa_project_coordination,public.qa_coordination_commands TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_live_actor(p_auth_id uuid,p_identity jsonb DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor public.members%ROWTYPE; binding public.external_account_bindings%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
 IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
 SELECT * INTO actor FROM public.members WHERE auth_id=p_auth_id AND is_active FOR SHARE;
 IF NOT FOUND OR (SELECT count(*) FROM public.members WHERE auth_id=p_auth_id AND is_active)<>1 THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
 IF p_identity IS NOT NULL AND p_identity<>'null'::jsonb THEN
  IF jsonb_typeof(p_identity) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_identity))<>3
    OR COALESCE(p_identity->>'bindingId','') !~ '^[a-zA-Z0-9_-]{1,200}$' OR COALESCE(p_identity->>'teamId','') !~ '^T[A-Z0-9]+$'
    OR COALESCE(p_identity->>'userId','') !~ '^[UW][A-Z0-9]+$' THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO binding FROM public.external_account_bindings WHERE id::text=p_identity->>'bindingId' FOR SHARE;
  IF NOT FOUND OR binding.member_id IS DISTINCT FROM actor.id OR binding.platform IS DISTINCT FROM 'slack'
    OR binding.is_verified IS DISTINCT FROM true OR binding.verified_by IS NULL OR binding.verified_by NOT IN('email','admin')
    OR binding.platform_team_id IS DISTINCT FROM p_identity->>'teamId' OR binding.platform_user_id IS DISTINCT FROM p_identity->>'userId'
    OR (SELECT count(*) FROM public.external_account_bindings WHERE platform='slack' AND platform_team_id=binding.platform_team_id AND platform_user_id=binding.platform_user_id)<>1
    THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-slack-feature'));
  IF NOT public.livo_slack_enabled() THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN actor.id;
END; $$;
REVOKE ALL ON FUNCTION public.livo_qa_live_actor(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_live_actor(uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_save_coordination(p_auth_id uuid,p_project_id text,p_coordinator_id text,p_expected_version integer,p_command_id text,p_payload_hash text,p_slack_identity jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor text; receipt public.qa_coordination_commands%ROWTYPE; current_version integer; result jsonb;
BEGIN
 actor:=public.livo_qa_live_actor(p_auth_id,p_slack_identity);
 IF NOT EXISTS(SELECT 1 FROM public.members WHERE id=actor AND role::text IN ('admin','super_admin')) THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.projects WHERE id=p_project_id AND NOT is_archived FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'qa_project_unavailable' USING ERRCODE='P0002'; END IF;
 IF p_expected_version IS NULL OR p_expected_version<0 OR p_command_id !~ '^[A-Za-z0-9][A-Za-z0-9_:-]{7,199}$' OR p_payload_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
 IF p_coordinator_id IS NOT NULL THEN
  PERFORM 1 FROM public.members WHERE id=p_coordinator_id AND is_active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qa_member_unavailable' USING ERRCODE='22023'; END IF;
 END IF;
 SELECT * INTO receipt FROM public.qa_coordination_commands WHERE id=p_command_id;
 IF FOUND THEN
  IF receipt.actor_id<>actor OR receipt.payload_hash<>p_payload_hash OR receipt.project_id<>p_project_id THEN RAISE EXCEPTION 'qa_command_id_reused' USING ERRCODE='23505'; END IF;
  RETURN receipt.response;
 END IF;
 SELECT version INTO current_version FROM public.qa_project_coordination WHERE id=p_project_id FOR UPDATE;
 IF COALESCE(current_version,0)<>p_expected_version THEN RAISE EXCEPTION 'qa_version_conflict' USING ERRCODE='40001'; END IF;
 result:=jsonb_build_object('projectId',p_project_id,'coordinatorId',p_coordinator_id,'version',p_expected_version+1);
 INSERT INTO public.qa_project_coordination(id,coordinator_id,version,updated_by) VALUES(p_project_id,p_coordinator_id,p_expected_version+1,actor)
 ON CONFLICT(id) DO UPDATE SET coordinator_id=EXCLUDED.coordinator_id,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp();
 INSERT INTO public.qa_coordination_commands(id,project_id,actor_id,payload_hash,response) VALUES(p_command_id,p_project_id,actor,p_payload_hash,result);
 RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.livo_qa_save_coordination(uuid,text,text,integer,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_save_coordination(uuid,text,text,integer,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_commit(p_auth_id uuid,p_issue_id text,p_command_id text,
  p_payload_hash text,p_expected_version integer,p_kind text,p_data jsonb,p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor text; actor_role text; existing public.qa_issues%ROWTYPE; receipt public.qa_commands%ROWTYPE; result jsonb; allowed boolean; coordinator boolean; h jsonb; previous_h jsonb;
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
    INSERT INTO public.qa_issues(id,project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data)
      VALUES(p_issue_id,p_data->>'projectId',p_data->>'state',p_data->>'assigneeId',p_data->>'qaOwnerId',actor,
        p_data->>'title',1,(p_data->>'updatedAt')::timestamptz,p_data);
    result:=p_data;
  ELSE
    IF NOT FOUND THEN RAISE EXCEPTION 'issue_not_found' USING ERRCODE='P0002'; END IF;
    IF p_kind='command' THEN
      IF existing.version<>p_expected_version THEN RAISE EXCEPTION 'version_conflict' USING ERRCODE='40001'; END IF;
      coordinator:=EXISTS(SELECT 1 FROM public.qa_project_coordination WHERE id=existing.project_id AND coordinator_id=actor);
      allowed:=CASE p_event->>'type'
        WHEN 'accept_handoff' THEN actor=existing.data->'handoff'->>'nextOwnerId' AND existing.data->'handoff'->>'acceptedAt' IS NULL AND existing.data->'handoff'->>'resolvedAt' IS NULL
        WHEN 'resolve_handoff' THEN (actor_role IN ('admin','super_admin') OR actor=existing.data->'handoff'->>'nextOwnerId') AND existing.data->'handoff'->>'resolvedAt' IS NULL
        ELSE actor_role IN ('admin','super_admin') OR CASE p_event->>'type'
        WHEN 'triage' THEN actor=existing.qa_owner_id OR coordinator
        WHEN 'record_verification' THEN actor=existing.qa_owner_id
        WHEN 'close' THEN actor=existing.qa_owner_id
        WHEN 'start_fix' THEN actor=existing.assignee_id
        WHEN 'submit_fix' THEN actor=existing.assignee_id
        WHEN 'record_deployment' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id
        WHEN 'link_tasks' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id
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
      IF p_data->>'projectId' IS DISTINCT FROM existing.project_id OR p_event->>'type' NOT IN
        ('edit','triage','start_fix','submit_fix','record_deployment','record_verification','close','reopen','hold','link_tasks','request_handoff','accept_handoff','resolve_handoff')
        OR (existing.state IN ('closed','dismissed') AND p_event->>'type'<>'reopen') THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
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
      AND (m.id IN (SELECT jsonb_array_elements_text(COALESCE(p_event->'recipients','[]'::jsonb)))
        OR (p_kind='create' AND m.id=(SELECT coordinator_id FROM public.qa_project_coordination WHERE id=p_data->>'projectId')));
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) TO service_role;


CREATE OR REPLACE FUNCTION public.livo_qa_restore(p_auth_id uuid,p_tables jsonb,p_validate_only boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE tab text; item jsonb; issue jsonb; person text; linked text; ref_project text;
  current_row jsonb; total integer:=0; incoming_version integer; inserted integer:=0; skipped integer:=0;
  conflicts jsonb:='[]'::jsonb; missing_assets jsonb:='[]'::jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.members WHERE auth_id=p_auth_id AND is_active=true AND role::text='super_admin') THEN
    RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_tables)<>'object' THEN RAISE EXCEPTION 'invalid_issue' USING ERRCODE='22023'; END IF;
  p_tables:=jsonb_build_object('qa_project_coordination','[]'::jsonb,'qa_coordination_commands','[]'::jsonb)||p_tables;
  -- Row casts validate SQL types even in validate-only mode, before any writes.
  FOREACH tab IN ARRAY ARRAY['qa_issues','qa_commands','qa_events','qa_comments','qa_uploads','qa_attachments','qa_slack_links','qa_project_coordination','qa_coordination_commands'] LOOP
    IF NOT p_tables ? tab OR jsonb_typeof(p_tables->tab)<>'array' OR jsonb_array_length(p_tables->tab)>100000 THEN
      RAISE EXCEPTION 'invalid_issue: incomplete QA backup' USING ERRCODE='22023'; END IF;
    EXECUTE format('SELECT count(*) FROM jsonb_populate_recordset(null::public.%I,$1)',tab) USING p_tables->tab;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_tables->tab) r WHERE jsonb_typeof(r)<>'object'
      OR r->>'workspace_id' IS DISTINCT FROM 'default' OR COALESCE(r->>'id','') !~ '^[A-Za-z0-9][A-Za-z0-9_:-]{0,199}$')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_tables->tab) r GROUP BY r->>'id' HAVING count(*)>1) THEN
      RAISE EXCEPTION 'invalid_issue' USING ERRCODE='22023'; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(p_tables->tab) LOOP
      EXECUTE format('SELECT to_jsonb(r) FROM jsonb_populate_record(null::public.%I,$1) r',tab) INTO item USING item;
      IF tab='qa_issues' THEN
        issue:=item->'data'; incoming_version:=(item->>'version')::integer;
        IF jsonb_typeof(issue) IS DISTINCT FROM 'object' OR issue->>'id' IS DISTINCT FROM item->>'id'
          OR issue->>'workspaceId' IS DISTINCT FROM 'default' OR incoming_version IS NULL OR incoming_version<1
          OR issue->>'version' IS DISTINCT FROM item->>'version'
          OR issue->>'projectId' IS DISTINCT FROM item->>'project_id'
          OR issue->>'state' IS DISTINCT FROM item->>'state'
          OR issue->>'reporterId' IS DISTINCT FROM item->>'reporter_id'
          OR issue->>'assigneeId' IS DISTINCT FROM item->>'assignee_id'
          OR issue->>'qaOwnerId' IS DISTINCT FROM item->>'qa_owner_id'
          OR issue->>'title' IS DISTINCT FROM item->>'title'
          OR COALESCE(issue->>'state','') NOT IN ('new','triaged','in_progress','verification','verified','failed','closed','dismissed')
          OR COALESCE(length(issue->>'title'),0) NOT BETWEEN 1 AND 200
          OR COALESCE(length(issue->>'actual'),0) NOT BETWEEN 1 AND 20000
          OR COALESCE(length(issue->>'observedEnvironment'),0) NOT BETWEEN 1 AND 120
          OR COALESCE(issue->>'severity','') NOT IN ('untriaged','low','medium','high')
          OR COALESCE((issue->>'priority')::integer,0) NOT BETWEEN 1 AND 5
          OR COALESCE((issue->>'fixCycle')::integer,-1)<0
          OR (issue->>'updatedAt')::timestamptz IS DISTINCT FROM (item->>'updated_at')::timestamptz
          OR issue->>'createdAt' IS NULL OR issue->>'updatedAt' IS NULL
          OR jsonb_typeof(issue->'targets') IS DISTINCT FROM 'array'
          OR jsonb_typeof(issue->'runs') IS DISTINCT FROM 'array'
          OR jsonb_typeof(issue->'taskIds') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'invalid_issue' USING ERRCODE='22023'; END IF;
        IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=item->>'project_id') AND NOT
          (p_validate_only AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_tables->'projects','[]'::jsonb)) p WHERE p->>'id'=item->>'project_id')) THEN
          RAISE EXCEPTION 'invalid_issue: project reference' USING ERRCODE='22023'; END IF;
        IF issue->>'reporterId' IS NULL THEN RAISE EXCEPTION 'invalid_issue: reporter' USING ERRCODE='22023'; END IF;
        FOREACH person IN ARRAY ARRAY[issue->>'reporterId',issue->>'assigneeId',issue->>'qaOwnerId'] LOOP
          IF person IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.members WHERE id=person) AND NOT
            (p_validate_only AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_tables->'members','[]'::jsonb)) m WHERE m->>'id'=person)) THEN
            RAISE EXCEPTION 'invalid_issue: member reference' USING ERRCODE='22023'; END IF;
        END LOOP;
        FOR linked IN SELECT jsonb_array_elements_text(issue->'taskIds') LOOP
          IF p_validate_only AND p_tables ? 'tasks' THEN
            SELECT t->>'project_id' INTO ref_project FROM jsonb_array_elements(p_tables->'tasks') t WHERE t->>'id'=linked LIMIT 1;
          ELSE SELECT project_id INTO ref_project FROM public.tasks WHERE id=linked; END IF;
          IF ref_project IS DISTINCT FROM item->>'project_id' THEN RAISE EXCEPTION 'invalid_issue: task reference' USING ERRCODE='22023'; END IF;
        END LOOP;
        SELECT to_jsonb(q) INTO current_row FROM public.qa_issues q WHERE id=item->>'id' AND workspace_id='default' FOR UPDATE;
      ELSIF tab IN ('qa_project_coordination','qa_coordination_commands') THEN
        ref_project:=CASE WHEN tab='qa_project_coordination' THEN item->>'id' ELSE item->>'project_id' END;
        IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=ref_project) THEN RAISE EXCEPTION 'invalid_issue: project reference' USING ERRCODE='22023'; END IF;
        FOREACH person IN ARRAY ARRAY[item->>'coordinator_id',item->>'updated_by',item->>'actor_id'] LOOP
          IF person IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.members WHERE id=person) THEN RAISE EXCEPTION 'invalid_issue: member reference' USING ERRCODE='22023'; END IF;
        END LOOP;
        IF (tab='qa_project_coordination' AND (COALESCE((item->>'version')::integer,0)<1 OR item->>'updated_by' IS NULL OR item->>'updated_at' IS NULL))
          OR (tab='qa_coordination_commands' AND (item->>'actor_id' IS NULL OR length(item->>'payload_hash')<>64 OR item->'response' IS NULL OR item->>'created_at' IS NULL)) THEN RAISE EXCEPTION 'invalid_issue' USING ERRCODE='22023'; END IF;
        EXECUTE format('SELECT to_jsonb(q) FROM public.%I q WHERE id=$1 AND workspace_id=''default''',tab) INTO current_row USING item->>'id';
      ELSE
        IF item->>'created_at' IS NULL OR item->>'issue_id' IS NULL THEN
          RAISE EXCEPTION 'invalid_issue: required fields' USING ERRCODE='22023'; END IF;
        IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_tables->'qa_issues') q WHERE q->>'id'=item->>'issue_id')
          AND NOT EXISTS(SELECT 1 FROM public.qa_issues WHERE id=item->>'issue_id' AND workspace_id='default') THEN
          RAISE EXCEPTION 'invalid_issue: issue reference' USING ERRCODE='22023'; END IF;
        person:=COALESCE(item->>'actor_id',item->>'uploaded_by');
        IF tab<>'qa_slack_links' AND (person IS NULL OR (NOT EXISTS(SELECT 1 FROM public.members WHERE id=person) AND NOT
          (p_validate_only AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_tables->'members','[]'::jsonb)) m WHERE m->>'id'=person)))) THEN
          RAISE EXCEPTION 'invalid_issue: member reference' USING ERRCODE='22023'; END IF;
        IF tab IN ('qa_uploads','qa_attachments') AND (item->>'storage_path' IS DISTINCT FROM
          'default/'||(item->>'issue_id')||'/'||(item->>'id') OR COALESCE((item->>'size')::bigint,0) NOT BETWEEN 1 AND 209715200
          OR COALESCE(item->>'mime_type','') NOT IN ('image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm','application/pdf','text/plain')
          OR COALESCE(length(item->>'file_name'),0) NOT BETWEEN 1 AND 255) THEN
          RAISE EXCEPTION 'invalid_issue: attachment' USING ERRCODE='22023'; END IF;
        IF tab='qa_comments' AND COALESCE(length(item->>'body'),0) NOT BETWEEN 1 AND 20000 THEN
          RAISE EXCEPTION 'invalid_issue: comment' USING ERRCODE='22023'; END IF;
        IF tab='qa_events' AND (COALESCE((item->>'version')::integer,0)<1 OR item->>'type' IS NULL OR item->>'detail' IS NULL) THEN
          RAISE EXCEPTION 'invalid_issue: event' USING ERRCODE='22023'; END IF;
        IF tab='qa_commands' AND (COALESCE(length(item->>'payload_hash'),0)<>64 OR item->'response' IS NULL) THEN
          RAISE EXCEPTION 'invalid_issue: receipt' USING ERRCODE='22023'; END IF;
        IF tab='qa_uploads' AND item->>'expires_at' IS NULL THEN RAISE EXCEPTION 'invalid_issue: upload' USING ERRCODE='22023'; END IF;
        IF tab='qa_slack_links' AND (COALESCE(item->>'team_id','')='' OR COALESCE(item->>'channel_id','')=''
          OR COALESCE(item->>'thread_ts','')='' OR COALESCE(item->>'card_ts','')='') THEN
          RAISE EXCEPTION 'invalid_issue: Slack link' USING ERRCODE='22023'; END IF;
        IF tab='qa_attachments' AND NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='qa-evidence'
          AND o.name=item->>'storage_path' AND (o.metadata->>'size')::bigint=(item->>'size')::bigint
          AND lower(o.metadata->>'mimetype')=item->>'mime_type') THEN
          missing_assets:=missing_assets||jsonb_build_array(item->>'id');
        END IF;
        EXECUTE format('SELECT to_jsonb(q) FROM public.%I q WHERE id=$1 AND workspace_id=''default''',tab) INTO current_row USING item->>'id';
      END IF;
      IF current_row IS NULL THEN inserted:=inserted+1;
      ELSIF current_row=item THEN skipped:=skipped+1;
      ELSE conflicts:=conflicts||jsonb_build_array(tab||':'||(item->>'id')); END IF;
      total:=total+1;
    END LOOP;
  END LOOP;
  IF NOT p_validate_only AND jsonb_array_length(conflicts)=0 AND jsonb_array_length(missing_assets)=0 THEN
    INSERT INTO public.qa_issues SELECT * FROM jsonb_populate_recordset(null::public.qa_issues,p_tables->'qa_issues')
      ON CONFLICT(id) DO NOTHING;
    FOREACH tab IN ARRAY ARRAY['qa_commands','qa_events','qa_comments','qa_uploads','qa_attachments','qa_slack_links','qa_project_coordination','qa_coordination_commands'] LOOP
      EXECUTE format('INSERT INTO public.%I SELECT * FROM jsonb_populate_recordset(null::public.%I,$1) ON CONFLICT(id) DO NOTHING',tab,tab) USING p_tables->tab;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('validateOnly',p_validate_only,'inserted',
    CASE WHEN NOT p_validate_only AND jsonb_array_length(conflicts)=0 AND jsonb_array_length(missing_assets)=0 THEN inserted ELSE 0 END,
    'skipped',skipped,'conflicts',conflicts,'missingAssets',missing_assets,'pending',inserted);
END;
$$;

CREATE OR REPLACE FUNCTION public.livo_jira_clear_tasks()
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE prior_silent text; removed bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF EXISTS(SELECT 1 FROM public.qa_issues WHERE jsonb_array_length(COALESCE(data->'taskIds','[]'::jsonb))>0) THEN
    RAISE EXCEPTION 'qa_task_links_require_restore' USING ERRCODE='23514'; END IF;
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
  PERFORM pg_advisory_xact_lock(hashtext('livo-task-work-graph'));
  IF EXISTS(SELECT 1 FROM public.task_work_events) OR EXISTS(SELECT 1 FROM public.task_work_receipts) THEN
    RAISE EXCEPTION 'work_history_requires_restore' USING ERRCODE='23514';
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
