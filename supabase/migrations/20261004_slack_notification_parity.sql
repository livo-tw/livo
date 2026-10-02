-- Capture responsibility changes in the same transaction as every task write.
-- No data backfill or automatic opt-in: existing dmEnabled and routes still apply.
CREATE OR REPLACE FUNCTION public.livo_slack_dm_allowed(p_config jsonb,p_member text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p_config->'enabled'='true'::jsonb AND p_config->'dmEnabled'='true'::jsonb
    AND p_member IS NOT NULL AND (NOT (p_config ? 'dmMemberIds')
      OR (jsonb_typeof(p_config->'dmMemberIds')='array' AND (p_config->'dmMemberIds') ? p_member)),false)
$$;
REVOKE ALL ON FUNCTION public.livo_slack_dm_allowed(jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_slack_dm_allowed(jsonb,text) TO service_role;

-- An explicit status-id mapping can override or disable a default handoff.
CREATE OR REPLACE FUNCTION public.livo_slack_handoff_role(p_status text,p_config jsonb)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT CASE WHEN p_config->'handoffRoles' ? p_status THEN
    CASE WHEN p_config->'handoffRoles'->>p_status IN ('assignee','reviewer') THEN p_config->'handoffRoles'->>p_status END
    ELSE CASE name WHEN '待驗收' THEN 'reviewer'
      WHEN '待討論確認' THEN 'assignee' WHEN '等待部署' THEN 'assignee' END END
  FROM public.statuses WHERE id=p_status
$$;
REVOKE ALL ON FUNCTION public.livo_slack_handoff_role(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_slack_handoff_role(text,jsonb) TO service_role;

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
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.livo_slack_delivery_channels(card.project_id)) THEN RETURN NEW; END IF;
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

-- Refresh report contents at send time so moved, completed or reassigned cards
-- cannot leak through a stale weekly snapshot. No cast of arbitrary due-date text.
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
$$;
REVOKE ALL ON FUNCTION public.livo_slack_weekly_tasks(text,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_slack_weekly_tasks(text,date) TO service_role;

-- Called by the existing minute delivery drain; one durable job per week/person.
CREATE OR REPLACE FUNCTION public.livo_slack_queue_weekly(p_now timestamptz DEFAULT clock_timestamp())
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE cfg jsonb; local_time timestamp := p_now AT TIME ZONE 'Asia/Taipei';
  week_start date := date_trunc('week',local_time)::date; recipient text; n integer := 0; added integer;
BEGIN
  SELECT value INTO cfg FROM public.system_settings WHERE key='slack_delivery';
  IF cfg->'weekly'->'enabled' IS DISTINCT FROM 'true'::jsonb OR cfg->'dmEnabled' IS DISTINCT FROM 'true'::jsonb
    OR COALESCE(cfg->>'teamId','') !~ '^T[A-Z0-9]+$' OR extract(isodow FROM local_time)<>1
    OR extract(hour FROM local_time)<9 THEN RETURN 0; END IF;
  -- An explicit start date prevents an upgrade from scheduling historical reports.
  IF COALESCE(cfg->'weekly'->>'startDate','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR to_char(week_start,'YYYY-MM-DD') < cfg->'weekly'->>'startDate' THEN RETURN 0; END IF;
  FOR recipient IN SELECT DISTINCT m.id FROM public.members m JOIN public.external_account_bindings b ON b.member_id=m.id
    WHERE m.is_active AND b.platform='slack' AND b.platform_team_id=cfg->>'teamId'
      AND b.is_verified AND b.verified_by IN ('email','admin') AND public.livo_slack_dm_allowed(cfg,m.id) LOOP
    IF EXISTS(SELECT 1 FROM public.slack_delivery_outbox WHERE event_key='weekly:'||week_start
      AND team_id=cfg->>'teamId' AND target_type='member' AND target_id=recipient) THEN CONTINUE; END IF;
    IF jsonb_array_length(public.livo_slack_weekly_tasks(recipient,week_start))=0 THEN CONTINUE; END IF;
    INSERT INTO public.slack_delivery_outbox(event_key,team_id,task_id,target_type,target_id,payload)
      VALUES('weekly:'||week_start,cfg->>'teamId','weekly:'||week_start||':'||recipient,'member',recipient,
        jsonb_build_object('kind','weekly','weekStart',week_start)) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS added = ROW_COUNT; n := n+added;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_slack_queue_weekly(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_slack_queue_weekly(timestamptz) TO service_role;

-- Reserve enough remaining lease time for the final bounded Slack post.
CREATE OR REPLACE FUNCTION public.livo_slack_delivery_lease_valid(p_id bigint,p_owner uuid)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(SELECT 1 FROM public.slack_delivery_outbox WHERE id=p_id AND status='sending'
    AND lease_owner=p_owner AND lease_expires_at>clock_timestamp()+interval '15 seconds')
$$;
REVOKE ALL ON FUNCTION public.livo_slack_delivery_lease_valid(bigint,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_slack_delivery_lease_valid(bigint,uuid) TO service_role;
