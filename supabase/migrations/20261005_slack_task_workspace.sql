-- Slack task edits use the member's RLS permissions and an optimistic snapshot.
-- This upgrade is additive: no feature switch, binding, route or DM is enabled.
CREATE OR REPLACE FUNCTION public.livo_slack_update(
  p_request_id text, p_task_id text, p_expected jsonb, p_changes jsonb, p_source jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE
  actor text := public.current_member_id();
  binding public.external_account_bindings%ROWTYPE;
  card public.tasks%ROWTYPE;
  previous public.tasks%ROWTYPE;
  state public.statuses%ROWTYPE;
  old_state public.statuses%ROWTYPE;
  saved jsonb; snapshot jsonb; next_values jsonb; fingerprint jsonb;
  old_log public.external_action_logs%ROWTYPE;
  audit_id uuid;
  field text; before_label text; after_label text; action_name text;
  changed jsonb := '{}'::jsonb;
  required jsonb;
  fields text[] := ARRAY['status_id','assignee_id','reviewer_id','due_date','priority'];
  stamp text := to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  -- Match the feature-setting trigger lock order; a disable cannot race a write.
  PERFORM pg_advisory_xact_lock(hashtext('livo-approval-feature'));
  PERFORM pg_advisory_xact_lock(hashtext('livo-slack-feature'));
  IF NOT public.livo_slack_enabled() OR NOT public.livo_slack_session() THEN
    RAISE EXCEPTION 'slack_session_unavailable' USING ERRCODE='42501';
  END IF;
  SELECT b.* INTO binding FROM public.external_account_bindings b
    JOIN public.members m ON m.id=b.member_id
    WHERE b.id::text=auth.jwt()->>'livo_slack_binding' AND b.member_id=actor
      AND b.platform='slack' AND b.is_verified AND m.is_active AND m.auth_id=auth.uid()
    FOR SHARE OF b,m;
  IF NOT FOUND OR binding.platform_team_id IS DISTINCT FROM p_source->>'team' THEN
    RAISE EXCEPTION 'slack_session_unavailable' USING ERRCODE='42501';
  END IF;
  IF p_request_id IS NULL OR length(p_request_id) NOT BETWEEN 5 AND 250 OR NULLIF(p_task_id,'') IS NULL
    OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' OR jsonb_typeof(p_changes) IS DISTINCT FROM 'object'
    OR NOT p_expected ?& fields OR p_changes='{}'::jsonb
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE NOT k=ANY(fields))
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_expected) k WHERE NOT k=ANY(fields))
    OR EXISTS(SELECT 1 FROM jsonb_each(p_changes) e WHERE jsonb_typeof(e.value) NOT IN ('string','null'))
    OR EXISTS(SELECT 1 FROM jsonb_each(p_expected) e WHERE jsonb_typeof(e.value) NOT IN ('string','null')) THEN
    RAISE EXCEPTION 'slack_update_invalid' USING ERRCODE='22023';
  END IF;
  fingerprint := jsonb_build_object('task_id',p_task_id,'expected',p_expected,'changes',p_changes,
    'team',p_source->>'team','channel',p_source->>'channel');
  PERFORM pg_advisory_xact_lock(hashtext('livo-slack-request:' || p_request_id));
  SELECT * INTO old_log FROM public.external_action_logs WHERE slack_request_id=p_request_id;
  IF FOUND THEN
    IF old_log.member_id IS DISTINCT FROM actor OR old_log.binding_id IS DISTINCT FROM binding.id
      OR old_log.action_payload->'request' IS DISTINCT FROM fingerprint THEN
      RAISE EXCEPTION 'slack_request_conflict' USING ERRCODE='22023';
    END IF;
    -- A replay must not reveal a task that is no longer visible to this member.
    IF NOT EXISTS(SELECT 1 FROM public.tasks WHERE id=p_task_id) THEN
      RAISE EXCEPTION 'slack_task_unavailable' USING ERRCODE='42501';
    END IF;
    RETURN old_log.action_payload || jsonb_build_object('duplicate',true);
  END IF;

  SELECT * INTO card FROM public.tasks WHERE id=p_task_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.projects WHERE id=card.project_id AND NOT is_archived) THEN
    RAISE EXCEPTION 'slack_task_unavailable' USING ERRCODE='42501';
  END IF;
  previous := card;
  -- Match the Slack form's nullable snapshot for legacy empty text values.
  snapshot := jsonb_build_object('status_id',card.status_id,'assignee_id',NULLIF(card.assignee_id,''),
    'reviewer_id',NULLIF(card.reviewer_id,''),'due_date',NULLIF(card.due_date,''),'priority',card.priority);
  IF snapshot IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'slack_task_conflict' USING ERRCODE='40001';
  END IF;
  next_values := snapshot || p_changes;
  IF NULLIF(next_values->>'status_id','') IS NULL OR next_values->>'priority' IS NULL
    OR next_values->>'priority' NOT IN ('highest','high','medium','low','lowest')
    OR next_values->>'assignee_id'='' OR next_values->>'reviewer_id'='' OR next_values->>'due_date'='' THEN
    RAISE EXCEPTION 'slack_update_invalid' USING ERRCODE='22023';
  END IF;
  SELECT value INTO required FROM public.system_settings WHERE key='required_fields';
  IF (required->'assignee'='true'::jsonb AND next_values->>'assignee_id' IS NULL)
    OR (required->'reviewer'='true'::jsonb AND next_values->>'reviewer_id' IS NULL)
    OR (required->'dueDate'='true'::jsonb AND next_values->>'due_date' IS NULL) THEN
    RAISE EXCEPTION 'slack_required_field' USING ERRCODE='23514';
  END IF;
  FOREACH field IN ARRAY ARRAY['assignee_id','reviewer_id'] LOOP
    IF next_values->>field IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM public.members WHERE id=next_values->>field AND is_active
    ) THEN RAISE EXCEPTION 'slack_member_unavailable' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF next_values->>'due_date' IS NOT NULL THEN
    IF next_values->>'due_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'slack_invalid_date' USING ERRCODE='22023';
    END IF;
    BEGIN
      PERFORM (next_values->>'due_date')::date;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      RAISE EXCEPTION 'slack_invalid_date' USING ERRCODE='22023';
    END;
  END IF;
  SELECT * INTO state FROM public.statuses WHERE id=next_values->>'status_id';
  IF NOT FOUND THEN RAISE EXCEPTION 'slack_status_unavailable' USING ERRCODE='23514'; END IF;
  IF state.id IS DISTINCT FROM card.status_id THEN
    IF EXISTS(SELECT 1 FROM public.status_transition_rules r WHERE r.target_status_id=state.id
      AND NOT EXISTS(SELECT 1 FROM public.status_logs l WHERE l.task_id=card.id AND l.to_status_id=r.required_status_id)) THEN
      RAISE EXCEPTION 'slack_transition_prerequisite' USING ERRCODE='23514';
    END IF;
    IF public.livo_approvals_enabled() AND (card.requires_approval OR card.approval_status='pending_approval'
      OR card.current_approval_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.approval_requests
        WHERE task_id=card.id AND status='pending')
      OR EXISTS(SELECT 1 FROM public.approval_rules WHERE is_active
        AND (project_id IS NULL OR project_id=card.project_id) AND from_status=card.status_id AND to_status=state.id)) THEN
      RAISE EXCEPTION 'slack_approval_required' USING ERRCODE='23514';
    END IF;
  END IF;

  FOREACH field IN ARRAY fields LOOP
    IF snapshot->field IS DISTINCT FROM next_values->field THEN
      changed := changed || jsonb_build_object(field,jsonb_build_object('before',snapshot->field,'after',next_values->field));
    END IF;
  END LOOP;
  IF changed<>'{}'::jsonb THEN
    SELECT * INTO old_state FROM public.statuses WHERE id=card.status_id;
    UPDATE public.tasks SET status_id=state.id,assignee_id=next_values->>'assignee_id',reviewer_id=next_values->>'reviewer_id',
      due_date=next_values->>'due_date',priority=(next_values->>'priority')::public.task_priority,
      started_at=CASE WHEN state.id IS DISTINCT FROM previous.status_id AND state.auto_start AND started_at IS NULL THEN stamp ELSE started_at END,
      completed_at=CASE WHEN state.id IS DISTINCT FROM previous.status_id AND state.is_done AND NOT old_state.is_done THEN stamp
        WHEN state.id IS DISTINCT FROM previous.status_id AND NOT state.is_done AND old_state.is_done THEN NULL ELSE completed_at END
      WHERE id=p_task_id RETURNING * INTO card;
    IF NOT FOUND THEN RAISE EXCEPTION 'slack_task_unavailable' USING ERRCODE='42501'; END IF;
    IF card.status_id IS DISTINCT FROM previous.status_id THEN
      INSERT INTO public.status_logs(id,task_id,from_status_id,to_status_id,changed_by,changed_at)
        VALUES('sl_' || gen_random_uuid()::text,card.id,previous.status_id,card.status_id,actor,stamp) ON CONFLICT(id) DO NOTHING;
    END IF;
    FOREACH field IN ARRAY fields LOOP
      IF NOT changed ? field THEN CONTINUE; END IF;
      before_label := snapshot->>field; after_label := next_values->>field;
      IF field='status_id' THEN
        before_label := old_state.name; after_label := state.name;
      ELSIF field IN ('assignee_id','reviewer_id') THEN
        SELECT name INTO before_label FROM public.members WHERE id=before_label;
        SELECT name INTO after_label FROM public.members WHERE id=after_label;
      END IF;
      action_name := CASE field WHEN 'status_id' THEN 'update_status' WHEN 'assignee_id' THEN 'update_assignee'
        WHEN 'reviewer_id' THEN 'update_reviewer' WHEN 'due_date' THEN 'update_due_date' ELSE 'update_priority' END;
      INSERT INTO public.activity_logs(user_id,action,task_id,task_key,detail)
        VALUES(actor,action_name,card.id,card.task_key,'[Slack] ' || COALESCE(before_label,'—') || ' → ' || COALESCE(after_label,'—'))
        ON CONFLICT(id) DO NOTHING;
    END LOOP;
  END IF;
  saved := jsonb_build_object('kind','update','task',to_jsonb(card),'changes',changed,'request',fingerprint,
    'unchanged',changed='{}'::jsonb,'duplicate',false);
  INSERT INTO public.external_action_logs(member_id,binding_id,platform,action_type,target_task_id,action_payload,
    platform_message_id,slack_request_id)
    VALUES(actor,binding.id,'slack','slash_command',card.id,saved,p_source->>'thread',p_request_id)
    ON CONFLICT(slack_request_id) WHERE slack_request_id IS NOT NULL DO NOTHING RETURNING id INTO audit_id;
  IF audit_id IS NULL THEN RAISE EXCEPTION 'slack_request_conflict' USING ERRCODE='22023'; END IF;
  RETURN saved;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_slack_update(text,text,jsonb,jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.livo_slack_update(text,text,jsonb,jsonb,jsonb) TO authenticated;
