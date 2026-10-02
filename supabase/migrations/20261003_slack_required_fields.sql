-- Standard fields already present in the Slack modal must not force the web form.
-- Keep custom required fields and server-side due-date validation enforced.
CREATE OR REPLACE FUNCTION public.livo_slack_commit(p_request_id text, p_kind text, p_fields jsonb, p_source jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  actor text := public.current_member_id();
  binding public.external_account_bindings%ROWTYPE;
  card public.tasks%ROWTYPE;
  project public.projects%ROWTYPE;
  state public.statuses%ROWTYPE;
  saved jsonb;
  required jsonb;
  stamp text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  task_id_new text := 't_' || gen_random_uuid()::text;
  comment_id_new text;
  number_next bigint;
  active_sprint uuid;
  target record;
  mentions text[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_fields->'mentioned_ids','[]'::jsonb)));
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-slack-feature'));
  IF NOT public.livo_slack_enabled() OR NOT public.livo_slack_session() THEN
    RAISE EXCEPTION 'Slack actions disabled or account unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO STRICT binding FROM public.external_account_bindings
    WHERE id::text=auth.jwt()->>'livo_slack_binding' AND member_id=actor AND is_verified;
  IF binding.platform_team_id IS DISTINCT FROM p_source->>'team' THEN
    RAISE EXCEPTION 'Slack team mismatch' USING ERRCODE='42501';
  END IF;
  IF p_request_id IS NULL OR length(p_request_id)>250 OR length(p_request_id)<5 OR p_kind NOT IN ('create','comment') THEN
    RAISE EXCEPTION 'Invalid Slack request' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-slack-request:' || p_request_id));
  SELECT action_payload INTO saved FROM public.external_action_logs
    WHERE slack_request_id=p_request_id AND member_id=actor;
  IF FOUND THEN RETURN saved || jsonb_build_object('duplicate',true); END IF;

  IF p_kind='create' THEN
    SELECT value INTO required FROM public.system_settings WHERE key='required_fields';
    IF EXISTS (SELECT 1 FROM jsonb_each(COALESCE(required,'{}'::jsonb)) e
      WHERE e.value='true'::jsonb AND e.key NOT IN ('title','project','status','priority','dueDate','assignee','requirement')) THEN
      RAISE EXCEPTION 'Additional required fields must be filled in the web app' USING ERRCODE='23514';
    END IF;
    IF NULLIF(trim(p_fields->>'title'),'') IS NULL OR length(p_fields->>'title')>200 OR
      NULLIF(p_fields->>'assignee_id','') IS NULL OR length(COALESCE(p_fields->>'description',''))>3000 OR
      (required->'priority'='true'::jsonb AND NULLIF(p_fields->>'priority','') IS NULL) OR
      (required->'dueDate'='true'::jsonb AND NULLIF(p_fields->>'due_date','') IS NULL) OR
      (required->'requirement'='true'::jsonb AND NULLIF(trim(p_fields->>'preview'),'') IS NULL) THEN
      RAISE EXCEPTION 'Required fields are missing' USING ERRCODE='23514';
    END IF;
    SELECT * INTO STRICT project FROM public.projects WHERE id=p_fields->>'project_id' AND NOT is_archived;
    SELECT * INTO STRICT state FROM public.statuses WHERE id=p_fields->>'status_id';
    IF NOT EXISTS (SELECT 1 FROM public.members WHERE id=p_fields->>'assignee_id' AND is_active) THEN
      RAISE EXCEPTION 'Assignee is unavailable' USING ERRCODE='23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('livo-task-number:' || project.id));
    SELECT COALESCE(MAX((substring(task_key from '([0-9]+)$'))::bigint),0)+1 INTO number_next
      FROM public.tasks WHERE project_id=project.id;
    SELECT id INTO active_sprint FROM public.sprints WHERE is_active ORDER BY started_at DESC LIMIT 1;
    INSERT INTO public.tasks(id,task_key,project_id,title,status_id,priority,creator_id,assignee_id,due_date,
      started_at,completed_at,sort_order,created_at,comment_count,sprint_id)
    VALUES (task_id_new,project.key || '-' || number_next,project.id,trim(p_fields->>'title'),state.id,
      (p_fields->>'priority')::public.task_priority,actor,p_fields->>'assignee_id',NULLIF(p_fields->>'due_date',''),
      CASE WHEN state.auto_start THEN stamp END,CASE WHEN state.auto_done THEN stamp END,0,stamp,0,active_sprint)
    ON CONFLICT (id) DO NOTHING RETURNING * INTO card;
    INSERT INTO public.task_specs(id,task_id,background,requirement,notes)
      VALUES ('ts_' || gen_random_uuid()::text,card.id,'',COALESCE(p_fields->>'content',''),'') ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.status_logs(id,task_id,from_status_id,to_status_id,changed_by,changed_at)
      VALUES ('sl_' || gen_random_uuid()::text,card.id,NULL,state.id,actor,stamp) ON CONFLICT (id) DO NOTHING;
    IF NULLIF(p_source->>'channel','') IS NOT NULL AND NULLIF(p_source->>'thread','') IS NOT NULL THEN
      INSERT INTO public.slack_thread_mappings(slack_channel_id,slack_thread_ts,slack_team_id,task_id,notification_type)
        VALUES (p_source->>'channel',p_source->>'thread',p_source->>'team',card.id,'task_created')
        ON CONFLICT (slack_channel_id,slack_thread_ts) DO NOTHING;
    END IF;
  ELSE
    IF NULLIF(trim(p_fields->>'preview'),'') IS NULL OR length(p_fields->>'text')>3000 THEN
      RAISE EXCEPTION 'Comment is empty or too long' USING ERRCODE='23514';
    END IF;
    SELECT * INTO STRICT card FROM public.tasks WHERE id=p_fields->>'task_id' FOR UPDATE;
    comment_id_new := 'c_' || gen_random_uuid()::text;
    INSERT INTO public.comments(id,task_id,user_id,content,created_at,source)
      VALUES (comment_id_new,card.id,actor,p_fields->>'content',stamp,'slack') ON CONFLICT (id) DO NOTHING;
    UPDATE public.tasks SET comment_count=comment_count+1 WHERE id=card.id RETURNING * INTO card;
    FOR target IN
      SELECT m.id, CASE WHEN m.id=ANY(mentions) THEN 'mention' ELSE 'comment' END AS kind, m.name
      FROM public.members m WHERE m.is_active AND m.id<>actor
        AND (m.id=ANY(mentions) OR m.id=card.assignee_id OR m.id=card.reviewer_id)
    LOOP
      INSERT INTO public.notifications(recipient_id,sender_id,type,task_id,content)
        VALUES (target.id,actor,target.kind,card.id,left(p_fields->>'preview',100)) ON CONFLICT (id) DO NOTHING;
      IF target.kind='mention' THEN
        INSERT INTO public.activity_logs(user_id,action,task_id,task_key,detail)
          VALUES (actor,'mention',card.id,card.task_key,'[Slack] @' || target.name) ON CONFLICT (id) DO NOTHING;
      END IF;
    END LOOP;
  END IF;
  INSERT INTO public.activity_logs(user_id,action,task_id,task_key,detail)
    VALUES (actor,CASE WHEN p_kind='create' THEN 'create_task' ELSE 'add_comment' END,card.id,card.task_key,
      '[Slack] ' || left(CASE WHEN p_kind='create' THEN card.title ELSE p_fields->>'preview' END,200)) ON CONFLICT (id) DO NOTHING;
  saved := jsonb_build_object('kind',p_kind,'task',to_jsonb(card),'comment_id',comment_id_new,
    'preview',p_fields->>'preview','mentioned_ids',to_jsonb(mentions),'duplicate',false);
  INSERT INTO public.external_action_logs(member_id,binding_id,platform,action_type,target_task_id,action_payload,
    platform_message_id,slack_request_id)
    VALUES (actor,binding.id,'slack',CASE WHEN p_kind='create' THEN 'slash_command' ELSE 'comment_add' END,
      card.id,saved,p_source->>'thread',p_request_id) ON CONFLICT (slack_request_id) WHERE slack_request_id IS NOT NULL DO NOTHING;
  RETURN saved;
END;
$$;
