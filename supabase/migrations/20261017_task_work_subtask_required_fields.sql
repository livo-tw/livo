-- Subtask creation from the web app failed on every install with the shipped
-- required_fields default ({"title":true,"project":true,"dueDate":true,...}):
-- create_subtask refused any required key other than dueDate/assignee/reviewer,
-- including title and project, which every subtask command always supplies.
-- Replaces livo_task_work_command (20261011_task_work_commands.sql) with that one
-- rule corrected; everything else in the function is unchanged. The web quick-create
-- now sends the parent's due date/assignee/reviewer for team-required fields.
-- Repeatable: CREATE OR REPLACE plus the same REVOKE/GRANT.
CREATE OR REPLACE FUNCTION public.livo_task_work_command(p_auth_id uuid,p_command jsonb,p_payload_hash text,p_slack_identity jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor public.members%ROWTYPE; binding public.external_account_bindings%ROWTYPE;
  card public.tasks%ROWTYPE; target public.tasks%ROWTYPE; project public.projects%ROWTYPE;
  receipt public.task_work_receipts%ROWTYPE; op text:=p_command->>'operation'; cid text:=p_command->>'commandId';
  tid text:=p_command->>'taskId'; item_table text; item_id text; value jsonb; previous jsonb; result jsonb; snapshot jsonb;
  removed text; next_number bigint; stamp timestamptz:=clock_timestamp(); eid uuid:=gen_random_uuid(); required jsonb;
BEGIN
  IF current_user<>'service_role' THEN RAISE EXCEPTION 'work_forbidden' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR COALESCE(cid,'') !~ '^[a-zA-Z0-9_-]{8,200}$'
    OR COALESCE(tid,'') !~ '^[a-zA-Z0-9_-]{1,200}$' OR COALESCE(p_payload_hash,'') !~ '^[a-f0-9]{64}$'
    OR op IS NULL OR op NOT IN('acknowledge','create_subtask','add_item','update_item','delete_item','add_dependency','remove_dependency') THEN
    RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-task-planning-import'));
  PERFORM pg_advisory_xact_lock(hashtext('livo-task-work-graph'));
  SELECT * INTO actor FROM public.members WHERE auth_id=p_auth_id AND is_active FOR SHARE;
  IF NOT FOUND OR (SELECT count(*) FROM public.members WHERE auth_id=p_auth_id AND is_active)<>1 THEN
    RAISE EXCEPTION 'work_forbidden' USING ERRCODE='42501';
  END IF;
  IF p_slack_identity IS NOT NULL THEN
    IF jsonb_typeof(p_slack_identity) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_slack_identity))<>3
      OR COALESCE(p_slack_identity->>'bindingId','') !~ '^[a-zA-Z0-9_-]{1,200}$'
      OR COALESCE(p_slack_identity->>'teamId','') !~ '^T[A-Z0-9]+$' OR COALESCE(p_slack_identity->>'userId','') !~ '^[UW][A-Z0-9]+$' THEN
      RAISE EXCEPTION 'work_forbidden' USING ERRCODE='42501';
    END IF;
    SELECT * INTO binding FROM public.external_account_bindings WHERE id::text=p_slack_identity->>'bindingId' FOR SHARE;
    IF NOT FOUND OR binding.member_id IS DISTINCT FROM actor.id OR binding.platform IS DISTINCT FROM 'slack'
      OR binding.is_verified IS DISTINCT FROM true OR binding.verified_by IS NULL OR binding.verified_by NOT IN('email','admin')
      OR binding.platform_team_id IS DISTINCT FROM p_slack_identity->>'teamId' OR binding.platform_user_id IS DISTINCT FROM p_slack_identity->>'userId'
      OR (SELECT count(*) FROM public.external_account_bindings WHERE platform='slack' AND platform_team_id=binding.platform_team_id AND platform_user_id=binding.platform_user_id)<>1 THEN
      RAISE EXCEPTION 'work_forbidden' USING ERRCODE='42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('livo-slack-feature'));
    IF NOT public.livo_slack_enabled() THEN RAISE EXCEPTION 'work_forbidden' USING ERRCODE='42501'; END IF;
  END IF;
  -- Lock the actual project before the task, and re-read after any wait. Service
  -- role locks preserve the existing all-active-member floor, without widening
  -- the project's admin-only UPDATE RLS just to acquire a lock.
  SELECT p.* INTO project FROM public.projects p JOIN public.tasks t ON t.project_id=p.id WHERE t.id=tid FOR SHARE OF p;
  IF NOT FOUND OR project.is_archived THEN RAISE EXCEPTION 'work_unavailable' USING ERRCODE='P0002'; END IF;
  SELECT * INTO card FROM public.tasks WHERE id=tid FOR UPDATE;
  IF NOT FOUND OR card.project_id<>project.id THEN RAISE EXCEPTION 'work_conflict' USING ERRCODE='40001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-task-work-command:'||cid));
  SELECT * INTO receipt FROM public.task_work_receipts WHERE command_id=cid;
  IF FOUND THEN
    IF receipt.actor_id<>actor.id OR receipt.payload_hash<>p_payload_hash OR receipt.command<>p_command OR receipt.task_id<>tid THEN
      RAISE EXCEPTION 'work_command_reused' USING ERRCODE='40001';
    END IF;
  snapshot:=jsonb_build_object('id',card.id,'task_key',card.task_key,'project_id',card.project_id,'parent_task_id',card.parent_task_id,
    'title',card.title,'status_id',card.status_id,'priority',card.priority,'assignee_id',card.assignee_id,'reviewer_id',card.reviewer_id,
    'assignee_revision',card.assignee_revision,'reviewer_revision',card.reviewer_revision,
    'assignee_acknowledged_at',card.assignee_acknowledged_at,'reviewer_acknowledged_at',card.reviewer_acknowledged_at);
    RETURN receipt.result||jsonb_build_object('replayed',true,'task',snapshot);
  END IF;
  INSERT INTO public.task_work_contexts(command_id,task_id,actor_id,operation) VALUES(cid,tid,actor.id,op);
  IF op='acknowledge' THEN
    previous:=to_jsonb(card);
    IF p_command->>'role'='assignee' THEN
      IF card.assignee_id IS DISTINCT FROM actor.id THEN RAISE EXCEPTION 'work_forbidden' USING ERRCODE='42501'; END IF;
      IF card.assignee_revision IS DISTINCT FROM (p_command->>'expectedRevision')::integer THEN RAISE EXCEPTION 'work_conflict' USING ERRCODE='40001'; END IF;
      UPDATE public.tasks SET assignee_acknowledged_at=COALESCE(assignee_acknowledged_at,stamp) WHERE id=tid RETURNING * INTO card;
    ELSIF p_command->>'role'='reviewer' THEN
      IF card.reviewer_id IS DISTINCT FROM actor.id THEN RAISE EXCEPTION 'work_forbidden' USING ERRCODE='42501'; END IF;
      IF card.reviewer_revision IS DISTINCT FROM (p_command->>'expectedRevision')::integer THEN RAISE EXCEPTION 'work_conflict' USING ERRCODE='40001'; END IF;
      UPDATE public.tasks SET reviewer_acknowledged_at=COALESCE(reviewer_acknowledged_at,stamp) WHERE id=tid RETURNING * INTO card;
    ELSE RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
  ELSIF op='create_subtask' THEN
    IF card.parent_task_id IS NOT NULL THEN RAISE EXCEPTION 'work_invalid_parent' USING ERRCODE='23514'; END IF;
    IF length(trim(COALESCE(p_command->>'title',''))) NOT BETWEEN 1 AND 500 OR p_command->>'priority' NOT IN('highest','high','medium','low','lowest')
      OR NOT EXISTS(SELECT 1 FROM public.statuses WHERE id=p_command->>'statusId') THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
    PERFORM 1 FROM public.members WHERE id IN(p_command->>'assigneeId',p_command->>'reviewerId') ORDER BY id FOR SHARE;
    IF EXISTS(SELECT 1 FROM jsonb_each_text(p_command) x WHERE x.key IN('assigneeId','reviewerId') AND x.value IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM public.members WHERE id=x.value AND is_active)) THEN RAISE EXCEPTION 'work_member_unavailable' USING ERRCODE='23514'; END IF;
    -- Title, project, status and priority are always supplied by the command (validated
    -- title/status/priority, the parent's project). Due date, assignee and reviewer are
    -- carried by the command and enforced. Other team-required fields cannot be filled
    -- by a subtask command, so they still refuse instead of creating an incomplete card.
    SELECT s.value INTO required FROM public.system_settings s WHERE s.key='required_fields';
    IF (COALESCE((required->>'dueDate')::boolean,false) AND NULLIF(p_command->>'dueDate','') IS NULL)
      OR (COALESCE((required->>'assignee')::boolean,false) AND p_command->>'assigneeId' IS NULL)
      OR (COALESCE((required->>'reviewer')::boolean,false) AND p_command->>'reviewerId' IS NULL)
      OR EXISTS(SELECT 1 FROM jsonb_each(COALESCE(required,'{}'::jsonb)) x WHERE x.value='true'::jsonb
        AND x.key NOT IN('title','project','status','priority','dueDate','assignee','reviewer'))
      OR EXISTS(SELECT 1 FROM public.custom_fields WHERE project_id=project.id AND is_required) THEN RAISE EXCEPTION 'work_required_fields' USING ERRCODE='23514'; END IF;
    IF NULLIF(p_command->>'dueDate','') IS NOT NULL AND ((p_command->>'dueDate') !~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      OR to_char((p_command->>'dueDate')::date,'YYYY-MM-DD')<>p_command->>'dueDate') THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('livo-task-number:'||card.project_id));
    SELECT COALESCE(max((substring(task_key from '([0-9]+)$'))::bigint),0)+1 INTO next_number FROM public.tasks WHERE project_id=card.project_id;
    INSERT INTO public.tasks(id,task_key,project_id,parent_task_id,title,status_id,priority,creator_id,assignee_id,reviewer_id,due_date,sprint_id,sort_order,started_at,completed_at)
      VALUES('task_'||gen_random_uuid()::text,project.key||'-'||next_number,project.id,tid,trim(p_command->>'title'),p_command->>'statusId',
      (p_command->>'priority')::public.task_priority,actor.id,p_command->>'assigneeId',p_command->>'reviewerId',NULLIF(p_command->>'dueDate',''),card.sprint_id,0,
      (SELECT CASE WHEN s.auto_start THEN stamp::text ELSE NULL END FROM public.statuses s WHERE s.id=p_command->>'statusId'),
      (SELECT CASE WHEN s.auto_done THEN stamp::text ELSE NULL END FROM public.statuses s WHERE s.id=p_command->>'statusId')) RETURNING * INTO target;
    INSERT INTO public.task_specs(id,task_id,background,requirement,notes) VALUES('spec_'||gen_random_uuid()::text,target.id,'','','');
    INSERT INTO public.status_logs(id,task_id,from_status_id,to_status_id,changed_by,changed_at)
      VALUES('log_'||gen_random_uuid()::text,target.id,NULL,target.status_id,actor.id,stamp::text);
    value:=to_jsonb(target);
  ELSIF op IN('add_item','update_item','delete_item') THEN
    IF p_command->>'list' NOT IN('checks','todos') THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
    item_table:=CASE WHEN p_command->>'list'='checks' THEN 'task_checks' ELSE 'task_todos' END;
    IF (op='add_item' OR p_command ? 'text') AND length(trim(COALESCE(p_command->>'text',''))) NOT BETWEEN 1 AND 2000 THEN
      RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
    IF op='add_item' THEN
      item_id:='item_'||gen_random_uuid()::text;
      EXECUTE format('INSERT INTO public.%I(id,task_id,text,is_done,sort_order) SELECT $1,$2,$3,$4,COALESCE(max(sort_order),-1)+1 FROM public.%I WHERE task_id=$2 RETURNING to_jsonb(%I)',item_table,item_table,item_table)
        INTO value USING item_id,tid,trim(p_command->>'text'),COALESCE((p_command->>'isDone')::boolean,false);
    ELSE
      EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 AND task_id=$2 FOR UPDATE',item_table) INTO previous USING p_command->>'itemId',tid;
      IF previous IS NULL OR (previous->>'version')::integer IS DISTINCT FROM (p_command->>'expectedVersion')::integer THEN
        RAISE EXCEPTION 'work_conflict' USING ERRCODE='40001'; END IF;
      IF op='delete_item' THEN
        EXECUTE format('DELETE FROM public.%I WHERE id=$1 AND task_id=$2',item_table) USING p_command->>'itemId',tid;
        removed:=p_command->>'itemId';
      ELSE
        EXECUTE format('UPDATE public.%I SET text=CASE WHEN $3 THEN $4 ELSE text END,is_done=CASE WHEN $5 THEN $6 ELSE is_done END WHERE id=$1 AND task_id=$2 RETURNING to_jsonb(%I)',item_table,item_table)
          INTO value USING p_command->>'itemId',tid,p_command ? 'text',trim(p_command->>'text'),p_command ? 'isDone',(p_command->>'isDone')::boolean;
      END IF;
    END IF;
  ELSE
    IF op='add_dependency' THEN
      SELECT * INTO target FROM public.tasks WHERE id=p_command->>'dependsOnTaskId' FOR SHARE;
    ELSE
      SELECT to_jsonb(d) INTO previous FROM public.task_dependencies d WHERE id=p_command->>'dependencyId' AND task_id=tid FOR UPDATE;
      IF previous IS NULL THEN RAISE EXCEPTION 'work_conflict' USING ERRCODE='40001'; END IF;
      SELECT * INTO target FROM public.tasks WHERE id=previous->>'depends_on_task_id' FOR SHARE;
    END IF;
    IF target.id IS NULL THEN RAISE EXCEPTION 'work_unavailable' USING ERRCODE='P0002'; END IF;
    PERFORM 1 FROM public.projects WHERE id=target.project_id AND NOT is_archived FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'work_unavailable' USING ERRCODE='P0002'; END IF;
    IF op='add_dependency' THEN
      IF EXISTS(SELECT 1 FROM public.task_dependencies WHERE task_id=tid AND depends_on_task_id=target.id) THEN
        RAISE EXCEPTION 'work_conflict' USING ERRCODE='40001'; END IF;
      INSERT INTO public.task_dependencies(id,task_id,depends_on_task_id) VALUES('dep_'||gen_random_uuid()::text,tid,target.id) RETURNING to_jsonb(task_dependencies) INTO value;
    ELSE DELETE FROM public.task_dependencies WHERE id=p_command->>'dependencyId' AND task_id=tid; removed:=p_command->>'dependencyId'; END IF;
  END IF;
  snapshot:=jsonb_build_object('id',card.id,'task_key',card.task_key,'project_id',card.project_id,'parent_task_id',card.parent_task_id,
    'title',card.title,'status_id',card.status_id,'priority',card.priority,'assignee_id',card.assignee_id,'reviewer_id',card.reviewer_id,
    'assignee_revision',card.assignee_revision,'reviewer_revision',card.reviewer_revision,
    'assignee_acknowledged_at',card.assignee_acknowledged_at,'reviewer_acknowledged_at',card.reviewer_acknowledged_at);
  result:=jsonb_build_object('commandId',cid,'replayed',false,'eventId',eid,'task',snapshot,'record',value);
  IF removed IS NOT NULL THEN result:=result||jsonb_build_object('removedId',removed); END IF;
  INSERT INTO public.task_work_events(id,command_id,actor_id,task_id,operation,before_value,after_value)
    VALUES(eid,cid,actor.id,tid,op,previous,CASE WHEN op='acknowledge' THEN snapshot ELSE value END);
  INSERT INTO public.task_work_receipts(command_id,actor_id,task_id,payload_hash,command,result) VALUES(cid,actor.id,tid,p_payload_hash,p_command,result);
  INSERT INTO public.activity_logs(user_id,action,task_id,task_key,detail) VALUES(actor.id,'task_work',tid,card.task_key,op);
  DELETE FROM public.task_work_contexts WHERE command_id=cid;
  RETURN result;
END; $$;
REVOKE ALL ON FUNCTION public.livo_task_work_command(uuid,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_task_work_command(uuid,jsonb,text,jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
