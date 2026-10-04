-- Approval decision policy (product decision, 2026-10):
--  * A requester never approves, returns or rejects their own request, whatever
--    their role (admin and super_admin included). The request waits for another
--    approver or is withdrawn; the requester is not notified to approve it.
--  * Anyone who may edit a task can turn "requires approval" on; only an active
--    admin or super_admin may turn it off.
-- Replaces livo_approval_command from 20261009_atomic_approval_commands.sql with
-- only those checks added. Idempotent; no data is changed.
-- It also fixes the two role-step comparisons: members.role is the
-- app_member_role enum, so it is cast to text before it is compared with
-- step->>'approver_role'. The 20261009 version failed every submit and decision
-- with "operator does not exist: app_member_role = text".
CREATE OR REPLACE FUNCTION public.livo_approval_command(p_auth_id uuid,p_command jsonb,p_payload_hash text,p_slack_identity jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE
  actor public.members%ROWTYPE; card public.tasks%ROWTYPE; previous public.tasks%ROWTYPE;
  req public.approval_requests%ROWTYPE; rule public.approval_rules%ROWTYPE;
  old_state public.statuses%ROWTYPE; new_state public.statuses%ROWTYPE;
  receipt public.approval_command_receipts%ROWTYPE; project public.projects%ROWTYPE;
  slack_binding public.external_account_bindings%ROWTYPE;
  op text:=p_command->>'operation'; cid text:=p_command->>'commandId'; tid text;
  steps jsonb; step jsonb; live_steps jsonb; expected jsonb; result jsonb; body jsonb; cfg jsonb;
  recipients text[]:=ARRAY[]::text[]; approvers text[]:=ARRAY[]::text[]; recipient text; channel text;
  event_id uuid:=gen_random_uuid(); event_key text; event_type text; prior_silent text;
  stamp text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
  IF current_user<>'service_role' THEN RAISE EXCEPTION 'approval_forbidden' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR cid IS NULL OR length(cid) NOT BETWEEN 8 AND 200
    OR cid ~ '[[:space:][:cntrl:]]' OR p_payload_hash IS NULL OR p_payload_hash !~ '^[a-f0-9]{64}$'
    OR op IS NULL OR op NOT IN ('submit','approve','reject','return','withdraw','set_requirement') THEN
    RAISE EXCEPTION 'approval_invalid_input' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-approval-feature'));
  SELECT * INTO actor FROM public.members WHERE auth_id=p_auth_id AND is_active FOR SHARE;
  IF NOT FOUND OR (SELECT count(*) FROM public.members WHERE auth_id=p_auth_id AND is_active)<>1 THEN
    RAISE EXCEPTION 'approval_forbidden' USING ERRCODE='42501';
  END IF;
  -- The adapter supplies this only from a JWT already verified by GoTrue. Lock
  -- the live binding before either a write or receipt readback, so revocation,
  -- reassignment or a Slack account replacement invalidates the old token.
  IF p_slack_identity IS NOT NULL THEN
    IF jsonb_typeof(p_slack_identity) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'approval_forbidden' USING ERRCODE='42501';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(p_slack_identity))<>3
      OR jsonb_typeof(p_slack_identity->'bindingId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_slack_identity->'teamId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_slack_identity->'userId') IS DISTINCT FROM 'string'
      OR COALESCE(p_slack_identity->>'bindingId','') !~ '^[a-zA-Z0-9_-]{1,200}$'
      OR COALESCE(p_slack_identity->>'teamId','') !~ '^T[A-Z0-9]+$'
      OR COALESCE(p_slack_identity->>'userId','') !~ '^[UW][A-Z0-9]+$' THEN
      RAISE EXCEPTION 'approval_forbidden' USING ERRCODE='42501';
    END IF;
    SELECT * INTO slack_binding FROM public.external_account_bindings
      WHERE id::text=p_slack_identity->>'bindingId' FOR SHARE;
    IF NOT FOUND OR slack_binding.member_id IS DISTINCT FROM actor.id
      OR slack_binding.platform IS DISTINCT FROM 'slack'
      OR slack_binding.is_verified IS DISTINCT FROM true
      OR slack_binding.verified_by IS NULL OR slack_binding.verified_by NOT IN ('email','admin')
      OR slack_binding.platform_team_id IS DISTINCT FROM p_slack_identity->>'teamId'
      OR slack_binding.platform_user_id IS DISTINCT FROM p_slack_identity->>'userId'
      OR (SELECT count(*) FROM public.external_account_bindings WHERE platform='slack'
        AND platform_team_id=p_slack_identity->>'teamId' AND platform_user_id=p_slack_identity->>'userId')<>1 THEN
      RAISE EXCEPTION 'approval_forbidden' USING ERRCODE='42501';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-approval-command:'||cid));
  SELECT * INTO receipt FROM public.approval_command_receipts WHERE command_id=cid;
  IF FOUND THEN
    IF receipt.actor_id<>actor.id OR receipt.payload_hash<>p_payload_hash OR receipt.command<>p_command THEN
      RAISE EXCEPTION 'approval_command_reused' USING ERRCODE='40001';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.tasks t JOIN public.projects p ON p.id=t.project_id
      WHERE t.id=receipt.result->'task'->>'id' AND (NOT p.is_archived OR op='withdraw')) THEN
      RAISE EXCEPTION 'approval_unavailable' USING ERRCODE='P0002';
    END IF;
    RETURN receipt.result||jsonb_build_object('replayed',true);
  END IF;
  IF op NOT IN ('withdraw','set_requirement') AND NOT public.livo_approvals_enabled() THEN
    RAISE EXCEPTION 'approval_disabled' USING ERRCODE='42501';
  END IF;
  IF op IN ('submit','set_requirement') THEN tid:=p_command->>'taskId';
  ELSE
    BEGIN SELECT task_id INTO tid FROM public.approval_requests WHERE id=(p_command->>'requestId')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'approval_invalid_input' USING ERRCODE='22023'; END;
  END IF;
  SELECT * INTO card FROM public.tasks WHERE id=tid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'approval_unavailable' USING ERRCODE='P0002'; END IF;
  previous:=card;
  SELECT * INTO project FROM public.projects WHERE id=card.project_id FOR SHARE;
  IF NOT FOUND OR (project.is_archived AND op<>'withdraw') THEN
    RAISE EXCEPTION 'approval_unavailable' USING ERRCODE='P0002';
  END IF;
  SELECT * INTO old_state FROM public.statuses WHERE id=card.status_id;
  prior_silent:=current_setting('livo.slack_silent',true);
  -- One semantic event per command: avoid ordinary status/notification capture
  -- duplicating the explicit approval event below. This flag grants no access.
  PERFORM set_config('livo.slack_silent','true',true);
  IF op='set_requirement' THEN
    IF jsonb_typeof(p_command->'enabled') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(p_command->'expectedRequiresApproval') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'approval_invalid_input' USING ERRCODE='22023';
    END IF;
    -- Anyone who may edit the task can require approval; only a live administrator may remove it.
    IF p_command->'enabled'<>'true'::jsonb AND actor.role NOT IN ('admin','super_admin') THEN
      RAISE EXCEPTION 'approval_requirement_admin_only' USING ERRCODE='42501';
    END IF;
    IF card.requires_approval IS DISTINCT FROM (p_command->>'expectedRequiresApproval')::boolean THEN
      RAISE EXCEPTION 'approval_conflict' USING ERRCODE='40001';
    END IF;
    IF card.current_approval_id IS NOT NULL OR card.approval_status IS NOT NULL
      OR EXISTS(SELECT 1 FROM public.approval_requests WHERE task_id=tid AND status='pending') THEN
      RAISE EXCEPTION 'approval_pending' USING ERRCODE='40001';
    END IF;
    UPDATE public.tasks SET requires_approval=(p_command->>'enabled')::boolean WHERE id=tid RETURNING * INTO card;
    event_type:='requirement_changed';
  ELSIF op='submit' THEN
    expected:=jsonb_build_object('statusId',card.status_id,'requiresApproval',card.requires_approval,
      'currentApprovalId',card.current_approval_id,'approvalStatus',card.approval_status);
    IF expected IS DISTINCT FROM p_command->'expected' THEN RAISE EXCEPTION 'approval_conflict' USING ERRCODE='40001'; END IF;
    IF jsonb_typeof(p_command->'enableRequirement') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'approval_invalid_input' USING ERRCODE='22023';
    END IF;
    IF card.current_approval_id IS NOT NULL OR card.approval_status IS NOT NULL
      OR EXISTS(SELECT 1 FROM public.approval_requests WHERE task_id=tid AND status='pending') THEN
      RAISE EXCEPTION 'approval_pending' USING ERRCODE='40001';
    END IF;
    SELECT * INTO new_state FROM public.statuses WHERE id=p_command->>'toStatusId';
    IF NOT FOUND OR new_state.id=card.status_id THEN RAISE EXCEPTION 'approval_invalid_transition' USING ERRCODE='23514'; END IF;
    IF (SELECT count(*) FROM public.approval_rules WHERE is_active AND project_id=card.project_id
      AND from_status=card.status_id AND to_status=new_state.id)>1 THEN RAISE EXCEPTION 'approval_ambiguous_rule' USING ERRCODE='23514'; END IF;
    SELECT * INTO rule FROM public.approval_rules WHERE is_active AND project_id=card.project_id
      AND from_status=card.status_id AND to_status=new_state.id FOR SHARE;
    IF rule.id::text IS DISTINCT FROM p_command->>'expectedRuleId' THEN RAISE EXCEPTION 'approval_conflict' USING ERRCODE='40001'; END IF;
    IF rule.id IS NULL AND NOT card.requires_approval AND p_command->'enableRequirement'<>'true'::jsonb THEN
      RAISE EXCEPTION 'approval_not_required' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM public.status_transition_rules r WHERE r.target_status_id=new_state.id AND NOT EXISTS(
      SELECT 1 FROM public.status_logs l WHERE l.task_id=tid AND l.to_status_id=r.required_status_id)) THEN
      RAISE EXCEPTION 'approval_transition_prerequisite' USING ERRCODE='23514';
    END IF;
    IF rule.id IS NULL THEN steps:='[{"step_order":1,"approver_type":"role","approver_role":"admin","approver_user_id":null}]'::jsonb;
    ELSE SELECT jsonb_agg(to_jsonb(s) ORDER BY step_order) INTO steps FROM public.approval_rule_steps s WHERE rule_id=rule.id; END IF;
    IF steps IS NULL OR jsonb_array_length(steps) NOT BETWEEN 1 AND 100 OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(steps) WITH ORDINALITY e(value,n) WHERE (value->>'step_order')::integer IS DISTINCT FROM n OR NOT COALESCE((
        (value->>'approver_type'='role' AND value->>'approver_role' IN ('member','admin','super_admin') AND value->>'approver_user_id' IS NULL) OR
        (value->>'approver_type'='user' AND NULLIF(value->>'approver_user_id','') IS NOT NULL AND value->>'approver_role' IS NULL
          AND EXISTS(SELECT 1 FROM public.members WHERE id=value->>'approver_user_id' AND is_active))),false)) THEN
      RAISE EXCEPTION 'approval_invalid_steps' USING ERRCODE='23514';
    END IF;
    INSERT INTO public.approval_requests(task_id,rule_id,requested_by,from_status,to_status,steps_snapshot,rule_snapshot)
      VALUES(tid,rule.id,actor.id,card.status_id,new_state.id,steps,CASE WHEN rule.id IS NOT NULL THEN to_jsonb(rule) END)
      ON CONFLICT(id) DO NOTHING RETURNING * INTO req;
    UPDATE public.tasks SET requires_approval=requires_approval OR (p_command->>'enableRequirement')::boolean,
      approval_status='pending_approval',current_approval_id=req.id WHERE id=tid RETURNING * INTO card;
    event_type:='requested';
  ELSE
    SELECT * INTO req FROM public.approval_requests WHERE id=(p_command->>'requestId')::uuid FOR UPDATE;
    IF req.status<>'pending' OR req.version IS DISTINCT FROM (p_command->>'expectedVersion')::integer
      OR (op<>'withdraw' AND req.current_step IS DISTINCT FROM (p_command->>'expectedStep')::integer) THEN
      RAISE EXCEPTION 'approval_conflict' USING ERRCODE='40001';
    END IF;
    IF op='withdraw' THEN
      IF actor.id<>req.requested_by AND actor.role NOT IN ('admin','super_admin') THEN
        RAISE EXCEPTION 'approval_forbidden' USING ERRCODE='42501';
      END IF;
      UPDATE public.approval_requests SET status='cancelled',version=version+1,completed_at=now() WHERE id=req.id RETURNING * INTO req;
      UPDATE public.tasks SET approval_status=NULL,current_approval_id=NULL WHERE id=tid AND current_approval_id=req.id;
      SELECT * INTO card FROM public.tasks WHERE id=tid;
      event_type:='withdrawn';
    ELSE
      IF card.current_approval_id IS DISTINCT FROM req.id OR card.approval_status IS DISTINCT FROM 'pending_approval'
        OR card.status_id IS DISTINCT FROM req.from_status THEN RAISE EXCEPTION 'approval_conflict' USING ERRCODE='40001'; END IF;
      -- A requester never decides their own request, whatever their role. It waits
      -- for another approver or is withdrawn.
      IF req.requested_by=actor.id THEN
        RAISE EXCEPTION 'approval_self_decision_forbidden' USING ERRCODE='42501';
      END IF;
      steps:=req.steps_snapshot;
      IF jsonb_typeof(steps) IS DISTINCT FROM 'array' OR jsonb_array_length(steps) NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'approval_legacy_snapshot' USING ERRCODE='23514';
      END IF;
      IF req.rule_id IS NOT NULL THEN
        SELECT * INTO rule FROM public.approval_rules WHERE id=req.rule_id FOR SHARE;
        SELECT jsonb_agg(to_jsonb(s) ORDER BY step_order) INTO live_steps FROM public.approval_rule_steps s WHERE rule_id=req.rule_id;
        IF to_jsonb(rule) IS DISTINCT FROM req.rule_snapshot OR live_steps IS DISTINCT FROM steps THEN
          RAISE EXCEPTION 'approval_rule_changed' USING ERRCODE='40001';
        END IF;
      END IF;
      step:=steps->(req.current_step-1);
      IF step->>'step_order' IS DISTINCT FROM req.current_step::text OR NOT COALESCE(
        CASE WHEN req.rule_id IS NULL THEN req.current_step=1 AND actor.role IN ('admin','super_admin')
          WHEN step->>'approver_type'='user' THEN step->>'approver_user_id'=actor.id
          WHEN step->>'approver_type'='role' THEN step->>'approver_role'=actor.role::text ELSE false END,false) THEN
        RAISE EXCEPTION 'approval_forbidden' USING ERRCODE='42501';
      END IF;
      IF length(COALESCE(p_command->>'comment',''))>4000 THEN RAISE EXCEPTION 'approval_invalid_input' USING ERRCODE='22023'; END IF;
      INSERT INTO public.approval_actions(request_id,step_order,action_by,action,comment)
        VALUES(req.id,req.current_step,actor.id,op,NULLIF(btrim(p_command->>'comment'),'')) ON CONFLICT(id) DO NOTHING;
      IF op='approve' AND req.current_step<jsonb_array_length(steps) THEN
        UPDATE public.approval_requests SET current_step=current_step+1,version=version+1 WHERE id=req.id RETURNING * INTO req;
        event_type:='step_approved';
      ELSE
        IF op='approve' THEN
          SELECT * INTO new_state FROM public.statuses WHERE id=req.to_status;
          IF NOT FOUND THEN RAISE EXCEPTION 'approval_invalid_transition' USING ERRCODE='23514'; END IF;
          IF EXISTS(SELECT 1 FROM public.status_transition_rules r WHERE r.target_status_id=new_state.id AND NOT EXISTS(
            SELECT 1 FROM public.status_logs l WHERE l.task_id=tid AND l.to_status_id=r.required_status_id)) THEN
            RAISE EXCEPTION 'approval_transition_prerequisite' USING ERRCODE='23514';
          END IF;
          UPDATE public.tasks SET status_id=new_state.id,approval_status=NULL,current_approval_id=NULL,
            started_at=CASE WHEN new_state.auto_start AND started_at IS NULL THEN stamp ELSE started_at END,
            completed_at=CASE WHEN new_state.is_done AND NOT old_state.is_done THEN stamp
              WHEN NOT new_state.is_done AND old_state.is_done THEN NULL ELSE completed_at END WHERE id=tid RETURNING * INTO card;
          INSERT INTO public.status_logs(id,task_id,from_status_id,to_status_id,changed_by,changed_at)
            VALUES('sl_'||gen_random_uuid()::text,tid,previous.status_id,card.status_id,actor.id,stamp) ON CONFLICT(id) DO NOTHING;
        ELSE
          UPDATE public.tasks SET approval_status=NULL,current_approval_id=NULL WHERE id=tid RETURNING * INTO card;
        END IF;
        UPDATE public.approval_requests SET status=CASE op WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'returned' END,
          version=version+1,completed_at=now() WHERE id=req.id RETURNING * INTO req;
        event_type:=req.status;
      END IF;
    END IF;
  END IF;
  INSERT INTO public.activity_logs(id,user_id,action,task_id,task_key,detail)
    VALUES(event_id,actor.id,'approval_'||event_type,tid,card.task_key,
      jsonb_build_object('requestId',req.id,'version',req.version,'step',req.current_step,'from',previous.status_id,'to',card.status_id)::text)
    ON CONFLICT(id) DO NOTHING;
  IF req.id IS NOT NULL AND op<>'withdraw' THEN
    IF req.status='pending' THEN
      step:=req.steps_snapshot->(req.current_step-1);
      SELECT COALESCE(array_agg(id),ARRAY[]::text[]) INTO approvers FROM public.members WHERE is_active AND id<>req.requested_by AND
        (CASE WHEN req.rule_id IS NULL THEN role IN ('admin','super_admin')
          WHEN step->>'approver_type'='user' THEN id=step->>'approver_user_id'
          ELSE role::text=step->>'approver_role' END);
    END IF;
    recipients:=approvers;
    IF req.status<>'pending' THEN recipients:=ARRAY[req.requested_by]; END IF;
    recipients:=array_remove(recipients,actor.id);
    FOR recipient IN SELECT DISTINCT unnest(recipients) LOOP
      IF NOT EXISTS(SELECT 1 FROM public.members WHERE id=recipient AND is_active) THEN CONTINUE; END IF;
      INSERT INTO public.notifications(recipient_id,sender_id,type,task_id,content)
        VALUES(recipient,actor.id,CASE WHEN recipient=ANY(approvers) THEN 'approval_requested' ELSE 'approval_completed' END,
          tid,card.task_key||' - '||card.title||' ['||event_type||']') ON CONFLICT(id) DO NOTHING;
    END LOOP;
    SELECT value INTO cfg FROM public.system_settings WHERE key='slack_delivery';
    IF cfg->'enabled'='true'::jsonb AND COALESCE(cfg->>'teamId','') ~ '^T[A-Z0-9]+$' THEN
      body:=jsonb_build_object('kind','approval','taskKey',card.task_key,'taskTitle',card.title,'priority',card.priority,
        'projectName',project.name,'projectKey',project.key,'projectId',project.id,'lineId',project.line_id,'actorName',actor.name,
        'approval',jsonb_build_object('operation',op,'eventType',event_type,'requestId',req.id,'version',req.version,
          'currentStep',req.current_step,'status',req.status,'fromStatusName',(SELECT name FROM public.statuses WHERE id=req.from_status),
          'toStatusName',(SELECT name FROM public.statuses WHERE id=req.to_status)));
      event_key:='approval:'||req.id::text||':v'||req.version::text;
      FOR channel IN SELECT channel_id FROM public.livo_slack_delivery_channels(card.project_id) LOOP
        INSERT INTO public.slack_delivery_outbox(event_key,team_id,task_id,target_type,target_id,payload)
          VALUES(event_key,cfg->>'teamId',tid,'channel',channel,body) ON CONFLICT DO NOTHING;
      END LOOP;
      IF cfg->'dmEnabled'='true'::jsonb AND EXISTS(SELECT 1 FROM public.livo_slack_delivery_channels(card.project_id)) THEN
        FOR recipient IN SELECT DISTINCT unnest(recipients) LOOP
          IF NOT public.livo_slack_dm_allowed(cfg,recipient) THEN CONTINUE; END IF;
          INSERT INTO public.slack_delivery_outbox(event_key,team_id,task_id,target_type,target_id,payload)
            VALUES(event_key,cfg->>'teamId',tid,'member',recipient,body||jsonb_build_object('approvalRecipient',
              CASE WHEN recipient=ANY(approvers) THEN 'approver' ELSE 'requester' END)) ON CONFLICT DO NOTHING;
        END LOOP;
      END IF;
    END IF;
  END IF;
  PERFORM set_config('livo.slack_silent',COALESCE(prior_silent,''),true);
  result:=jsonb_build_object('commandId',cid,'replayed',false,'eventId',event_id,'request',CASE WHEN req.id IS NOT NULL THEN to_jsonb(req) END,
    'task',jsonb_build_object('id',card.id,'status_id',card.status_id,'requires_approval',card.requires_approval,
      'approval_status',card.approval_status,'current_approval_id',card.current_approval_id,'started_at',card.started_at,'completed_at',card.completed_at));
  INSERT INTO public.approval_command_receipts(command_id,actor_id,payload_hash,command,result)
    VALUES(cid,actor.id,p_payload_hash,p_command,result) ON CONFLICT(command_id) DO NOTHING;
  RETURN result;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE EXCEPTION 'approval_invalid_input' USING ERRCODE='22023';
END;
$$;
REVOKE ALL ON FUNCTION public.livo_approval_command(uuid,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_approval_command(uuid,jsonb,text,jsonb) TO service_role;
