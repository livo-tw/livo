-- Personal delivery uses recipient RLS rather than Slack channel membership.
-- Existing task routes, weekly opt-in and delivery receipts retain their contracts.

CREATE OR REPLACE FUNCTION public.livo_slack_capture_delivery()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  cfg jsonb; card public.tasks%ROWTYPE; project public.projects%ROWTYPE;
  actor text := public.current_member_id(); actor_name text; event_key text; kind text;
  changes jsonb := '[]'::jsonb; field text; label text; before_value text; after_value text;
  body jsonb; source_channel text; channel text; enabled_types text[]; event_types text[] := ARRAY[]::text[];
  assigned boolean := false; reviewed boolean := false; status_changed boolean := false;
  recipient text; rules jsonb; handoff text; status_name text;
BEGIN
  SELECT value INTO cfg FROM public.system_settings WHERE key='slack_delivery';
  IF cfg->'enabled' IS DISTINCT FROM 'true'::jsonb OR COALESCE(cfg->>'teamId','') !~ '^T[A-Z0-9]+$'
    OR current_setting('livo.slack_silent',true)='true' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='tasks' THEN
    card := NEW;
    IF TG_OP='INSERT' THEN
      kind := 'created'; event_key := 'task:' || NEW.id || ':created';
      actor := COALESCE(actor,NEW.creator_id); event_types := ARRAY['task_created'];
      assigned := NEW.assignee_id IS NOT NULL; reviewed := NEW.reviewer_id IS NOT NULL;
      status_changed := true;
    ELSE
      kind := 'updated'; event_key := 'task:' || NEW.id || ':' || gen_random_uuid()::text;
      assigned := NEW.assignee_id IS NOT NULL AND NEW.assignee_id IS DISTINCT FROM OLD.assignee_id;
      reviewed := NEW.reviewer_id IS NOT NULL AND NEW.reviewer_id IS DISTINCT FROM OLD.reviewer_id;
      status_changed := NEW.status_id IS DISTINCT FROM OLD.status_id;
      FOREACH field IN ARRAY ARRAY['status_id','assignee_id','reviewer_id','priority','due_date','title'] LOOP
        IF to_jsonb(OLD)->field IS NOT DISTINCT FROM to_jsonb(NEW)->field THEN CONTINUE; END IF;
        before_value := to_jsonb(OLD)->>field; after_value := to_jsonb(NEW)->>field;
        label := CASE field WHEN 'status_id' THEN '狀態' WHEN 'assignee_id' THEN '經辦人'
          WHEN 'reviewer_id' THEN '驗收人' WHEN 'priority' THEN '優先級' WHEN 'due_date' THEN '到期日' ELSE '標題' END;
        IF field='status_id' THEN
          SELECT name INTO before_value FROM public.statuses WHERE id=before_value;
          SELECT name INTO after_value FROM public.statuses WHERE id=after_value;
        ELSIF field IN ('assignee_id','reviewer_id') THEN
          SELECT name INTO before_value FROM public.members WHERE id=before_value;
          SELECT name INTO after_value FROM public.members WHERE id=after_value;
        END IF;
        changes := changes || jsonb_build_array(jsonb_build_object('field',field,'label',label,'before',before_value,'after',after_value));
        event_types := array_append(event_types,CASE field WHEN 'status_id' THEN 'status_changed'
          WHEN 'assignee_id' THEN 'assignee_changed' WHEN 'priority' THEN 'priority_changed' ELSE 'task_updated' END);
      END LOOP;
      IF jsonb_array_length(changes)=0 THEN RETURN NEW; END IF;
    END IF;
  ELSE
    SELECT * INTO card FROM public.tasks WHERE id=NEW.task_id;
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='comments' THEN
      kind := 'comment'; actor := NEW.user_id;
      event_key := 'comment:' || NEW.id; event_types := ARRAY['comment_added'];
      IF NEW.source='slack' AND public.livo_slack_session() THEN
        source_channel := auth.jwt()->'livo_slack_source'->>'channel';
      END IF;
    ELSE
      -- The task trigger owns these Slack events. Legacy UI notifications stay
      -- available in-app but cannot enqueue a second personal Slack message.
      IF NEW.type IN ('assign','review','status_changed')
        OR NOT public.livo_slack_dm_allowed(cfg,NEW.recipient_id)
        OR (NEW.recipient_id=NEW.sender_id AND NEW.type<>'due_soon') THEN RETURN NEW; END IF;
      kind := 'personal'; actor := NEW.sender_id; event_key := 'notification:' || NEW.id;
    END IF;
  END IF;
  SELECT * INTO project FROM public.projects WHERE id=card.project_id AND NOT is_archived;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT task_notify_types INTO enabled_types FROM public.backup_settings LIMIT 1;
  enabled_types := COALESCE(enabled_types,ARRAY['task_created','status_changed','assignee_changed','priority_changed','comment_added','task_updated']);
  SELECT name INTO actor_name FROM public.members WHERE id=actor;
  body := jsonb_build_object('kind',kind,'taskKey',card.task_key,'taskTitle',card.title,
    'projectId',project.id,'lineId',project.line_id,'projectKey',project.key,'projectName',project.name,
    'actorId',actor,'actorName',COALESCE(actor_name,'系統'),'priority',card.priority,'dueDate',card.due_date,
    'assigneeName',(SELECT name FROM public.members WHERE id=card.assignee_id),
    'changes',changes,'sourceChannelId',source_channel);
  IF kind IN ('comment','personal') THEN body := body || jsonb_build_object('content',left(NEW.content,10000)); END IF;
  IF kind='personal' THEN
    body := body || jsonb_build_object('reason',NEW.type);
    INSERT INTO public.slack_delivery_outbox(event_key,team_id,task_id,target_type,target_id,payload)
      VALUES(event_key,cfg->>'teamId',card.id,'member',NEW.recipient_id,body) ON CONFLICT DO NOTHING;
  ELSE
    IF event_types && enabled_types THEN
      FOR channel IN SELECT channel_id FROM public.livo_slack_delivery_channels(card.project_id) LOOP
        IF channel IS NOT DISTINCT FROM source_channel THEN CONTINUE; END IF;
        INSERT INTO public.slack_delivery_outbox(event_key,team_id,task_id,target_type,target_id,payload)
          VALUES(event_key,cfg->>'teamId',card.id,'channel',channel,body) ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;
    IF TG_TABLE_NAME='tasks' THEN
      handoff := public.livo_slack_handoff_role(card.status_id,cfg);
      SELECT name INTO status_name FROM public.statuses WHERE id=card.status_id;
      FOR recipient IN SELECT DISTINCT m FROM unnest(ARRAY[card.assignee_id,card.reviewer_id]) m WHERE m IS NOT NULL LOOP
        IF NOT public.livo_slack_dm_allowed(cfg,recipient) THEN CONTINUE; END IF;
        rules := '[]'::jsonb;
        IF assigned AND recipient=card.assignee_id THEN
          rules := rules || jsonb_build_array(jsonb_build_object('code','assigned','role','assignee'));
        END IF;
        IF reviewed AND recipient=card.reviewer_id THEN
          rules := rules || jsonb_build_array(jsonb_build_object('code','reviewer_assigned','role','reviewer'));
        END IF;
        IF status_changed AND ((handoff='assignee' AND recipient=card.assignee_id) OR (handoff='reviewer' AND recipient=card.reviewer_id)) THEN
          rules := rules || jsonb_build_array(jsonb_build_object('code','handoff','role',handoff,'statusId',card.status_id,'statusName',status_name));
        ELSIF status_changed AND kind='updated' AND handoff IS NULL AND recipient IS DISTINCT FROM actor THEN
          -- Preserve ordinary status alerts, once per person even with two roles.
          IF recipient=card.assignee_id THEN
            rules := rules || jsonb_build_array(jsonb_build_object('code','status_changed','role','assignee','statusId',card.status_id));
          END IF;
          IF recipient=card.reviewer_id THEN
            rules := rules || jsonb_build_array(jsonb_build_object('code','status_changed','role','reviewer','statusId',card.status_id));
          END IF;
        END IF;
        IF jsonb_array_length(rules)>0 THEN
          INSERT INTO public.slack_delivery_outbox(event_key,team_id,task_id,target_type,target_id,payload)
            VALUES(event_key,cfg->>'teamId',card.id,'member',recipient,
              body || jsonb_build_object('kind','personal','eventKind',kind,'recipientRules',rules)) ON CONFLICT DO NOTHING;
        END IF;
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_slack_capture_delivery() FROM PUBLIC,anon,authenticated;

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
    AND CASE WHEN h.role='reviewer' THEN t.reviewer_id ELSE t.assignee_id END=p_member
    AND COALESCE(t.completed_at,'')='' AND lower(s.name) NOT IN ('取消','已取消','cancelled','canceled')
    AND t.due_date ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    AND t.due_date<=to_char(p_week+6,'YYYY-MM-DD') AND extract(isodow FROM p_week)=1
    AND NOT public.livo_task_reminder_paused(t.id,p_member)
$$;
REVOKE ALL ON FUNCTION public.livo_slack_weekly_tasks(text,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_slack_weekly_tasks(text,date) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_slack_finish_delivery(p_id bigint,p_owner uuid,p_status text,
  p_channel text DEFAULT NULL,p_message_ts text DEFAULT NULL,p_thread_ts text DEFAULT NULL,
  p_error text DEFAULT NULL,p_delay_seconds integer DEFAULT 0)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE job public.slack_delivery_outbox%ROWTYPE;
BEGIN
  SELECT * INTO job FROM public.slack_delivery_outbox WHERE id=p_id AND status='sending' AND lease_owner=p_owner
    AND lease_expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_status NOT IN ('sent','pending','review','failed','skipped') THEN RAISE EXCEPTION 'Invalid delivery result'; END IF;
  IF p_status='sent' THEN
    IF COALESCE(p_channel,'') !~ '^[CDG][A-Z0-9]+$' OR COALESCE(p_message_ts,'') !~ '^[0-9]+\.[0-9]+$'
      OR COALESCE(p_thread_ts,'') !~ '^[0-9]+\.[0-9]+$' THEN RAISE EXCEPTION 'Missing Slack receipt'; END IF;
    IF job.payload->>'recordType'='qa' THEN
      IF job.target_type='channel' AND job.task_id='qa:'||(job.payload->>'issueId')
        AND EXISTS(SELECT 1 FROM public.qa_issues WHERE id=job.payload->>'issueId' AND workspace_id='default') THEN
        INSERT INTO public.qa_slack_links(id,issue_id,team_id,channel_id,thread_ts,card_ts)
          VALUES('delivery-qa:'||md5(job.team_id||':'||p_channel||':'||p_thread_ts),job.payload->>'issueId',
            job.team_id,p_channel,p_thread_ts,p_thread_ts)
          ON CONFLICT(team_id,channel_id,thread_ts) DO NOTHING;
      END IF;
    ELSIF EXISTS(SELECT 1 FROM public.tasks WHERE id=job.task_id) THEN
      INSERT INTO public.slack_thread_mappings(slack_team_id,slack_channel_id,slack_thread_ts,task_id,notification_type)
        VALUES(job.team_id,p_channel,p_thread_ts,job.task_id,'delivery')
        ON CONFLICT(slack_channel_id,slack_thread_ts) DO NOTHING;
    END IF;
  END IF;
  UPDATE public.slack_delivery_outbox SET status=p_status,slack_channel_id=p_channel,slack_message_ts=p_message_ts,
    last_error=left(p_error,100),available_at=clock_timestamp()+make_interval(secs=>greatest(0,least(p_delay_seconds,86400))),
    sent_at=CASE WHEN p_status='sent' THEN clock_timestamp() END,lease_owner=NULL,lease_expires_at=NULL
    WHERE id=p_id AND lease_owner=p_owner;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_slack_finish_delivery(bigint,uuid,text,text,text,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_slack_finish_delivery(bigint,uuid,text,text,text,text,text,integer) TO service_role;
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
      IF p_data->>'projectId' IS DISTINCT FROM existing.project_id OR p_event->>'type' NOT IN
        ('set_state','edit','triage','start_fix','submit_fix','record_deployment','record_verification','close','reopen','hold','link_tasks','request_handoff','accept_handoff','resolve_handoff')
        OR (existing.state IN ('closed','dismissed') AND p_event->>'type' NOT IN ('reopen','set_state')) THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
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
  PERFORM set_config('livo.qa_slack_channel',COALESCE(prior_source_channel,''),true);
  PERFORM set_config('livo.qa_slack_team',COALESCE(prior_source_team,''),true);
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) TO service_role;

-- Separate opt-in routes; an ordinary task route never subscribes a channel to QA.
CREATE OR REPLACE FUNCTION public.livo_slack_qa_channels(p_project text)
RETURNS TABLE(channel_id text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT DISTINCT r->>'channelId'
  FROM public.system_settings s
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.value->'qaRoutes')='array'
    THEN s.value->'qaRoutes' ELSE '[]'::jsonb END) r
  JOIN public.projects p ON p.id=p_project AND NOT p.is_archived
  WHERE s.key='slack_delivery' AND s.value->'enabled'='true'::jsonb
    AND s.value->>'teamId' ~ '^T[A-Z0-9]+$' AND r->>'channelId' ~ '^[CG][A-Z0-9]+$'
    AND COALESCE(r->'enabled','true'::jsonb)='true'::jsonb
    AND ((r->>'projectId')=p.id OR (r->>'lineId')=p.line_id)
$$;
REVOKE ALL ON FUNCTION public.livo_slack_qa_channels(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_slack_qa_channels(text) TO service_role;

-- Capture after the business row, in the same transaction. Restore stays silent.
CREATE OR REPLACE FUNCTION public.livo_slack_capture_qa_delivery()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE cfg jsonb; issue public.qa_issues%ROWTYPE; body jsonb; item jsonb;
  event_type text; event_key text; detail text; actor text; channel text; source_channel text;
  current_xid xid := pg_current_xact_id()::xid;
BEGIN
  SELECT value INTO cfg FROM public.system_settings WHERE key='slack_delivery';
  IF cfg->'enabled' IS DISTINCT FROM 'true'::jsonb OR COALESCE(cfg->>'teamId','') !~ '^T[A-Z0-9]+$'
    OR current_setting('livo.slack_silent',true)='true'
    OR NOT public.livo_qa_enabled()
    OR NOT EXISTS(SELECT 1 FROM public.system_settings WHERE key='feature_toggles' AND value->'slackActions'='true'::jsonb) THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='notifications' THEN
    IF NEW.type<>'qa_update' OR NEW.recipient_id=NEW.sender_id OR NOT public.livo_slack_dm_allowed(cfg,NEW.recipient_id) THEN RETURN NEW; END IF;
    BEGIN item:=NEW.content::jsonb; EXCEPTION WHEN invalid_text_representation THEN RETURN NEW; END;
    IF item->>'kind' IS DISTINCT FROM 'qa' THEN RETURN NEW; END IF;
    SELECT * INTO issue FROM public.qa_issues WHERE id=item->>'issueId' AND workspace_id='default';
    IF NOT FOUND THEN RETURN NEW; END IF;
    actor:=NEW.sender_id; event_type:=item->>'event'; event_key:='qa-notification:'||NEW.id;
    -- In-app notices are writable by members. Only a committed QA action/comment
    -- from this same transaction can cause an outbound personal QA notice.
    IF event_type='comment' THEN
      SELECT c.body INTO detail FROM public.qa_comments c WHERE c.issue_id=issue.id AND c.actor_id=actor AND c.xmin=current_xid ORDER BY c.created_at DESC,c.id DESC LIMIT 1;
    ELSE
      SELECT e.detail INTO detail FROM public.qa_events e WHERE e.issue_id=issue.id AND e.actor_id=actor AND e.type=event_type AND e.version=issue.version AND e.xmin=current_xid ORDER BY e.created_at DESC,e.id DESC LIMIT 1;
    END IF;
    IF NOT FOUND THEN RETURN NEW; END IF;
  ELSE
    SELECT * INTO issue FROM public.qa_issues WHERE id=NEW.issue_id AND workspace_id='default';
    IF NOT FOUND THEN RETURN NEW; END IF;
    actor:=NEW.actor_id;
    IF TG_TABLE_NAME='qa_events' THEN event_type:=NEW.type; detail:=NEW.detail; event_key:='qa-event:'||NEW.id;
    ELSE event_type:='comment'; detail:=NEW.body; event_key:='qa-comment:'||NEW.id; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=issue.project_id AND NOT is_archived) THEN RETURN NEW; END IF;
  IF public.livo_slack_session() THEN source_channel:=auth.jwt()->'livo_slack_source'->>'channel'; END IF;
  IF current_setting('livo.qa_slack_team',true)=cfg->>'teamId' THEN source_channel:=NULLIF(current_setting('livo.qa_slack_channel',true),''); END IF;
  body:=jsonb_build_object('recordType','qa','kind','qa','issueId',issue.id,'projectId',issue.project_id,
    'eventType',event_type,'actorId',actor,'detail',left(COALESCE(detail,''),2000),'sourceChannelId',source_channel);
  IF TG_TABLE_NAME='notifications' THEN
    INSERT INTO public.slack_delivery_outbox(event_key,team_id,task_id,target_type,target_id,payload)
      VALUES(event_key,cfg->>'teamId','qa:'||issue.id,'member',NEW.recipient_id,body) ON CONFLICT DO NOTHING;
  ELSE
    FOR channel IN SELECT channel_id FROM public.livo_slack_qa_channels(issue.project_id) LOOP
      IF channel IS DISTINCT FROM source_channel THEN
        INSERT INTO public.slack_delivery_outbox(event_key,team_id,task_id,target_type,target_id,payload)
          VALUES(event_key,cfg->>'teamId','qa:'||issue.id,'channel',channel,body) ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_slack_capture_qa_delivery() FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE TRIGGER livo_slack_capture_qa_events AFTER INSERT ON public.qa_events
  FOR EACH ROW EXECUTE FUNCTION public.livo_slack_capture_qa_delivery();
CREATE OR REPLACE TRIGGER livo_slack_capture_qa_comments AFTER INSERT ON public.qa_comments
  FOR EACH ROW EXECUTE FUNCTION public.livo_slack_capture_qa_delivery();
CREATE OR REPLACE TRIGGER livo_slack_capture_qa_personal AFTER INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.livo_slack_capture_qa_delivery();

CREATE OR REPLACE FUNCTION public.livo_slack_delete_qa_delivery()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  DELETE FROM public.slack_delivery_outbox WHERE task_id='qa:'||OLD.id AND payload->>'recordType'='qa';
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_slack_delete_qa_delivery() FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE TRIGGER livo_slack_delete_qa_delivery AFTER DELETE ON public.qa_issues
  FOR EACH ROW EXECUTE FUNCTION public.livo_slack_delete_qa_delivery();
