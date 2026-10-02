-- Separate verified/failed/dismissed outcomes without rewriting historical records.
-- Drop only the old check constraint; all rows, indexes, permissions and evidence remain.
ALTER TABLE public.qa_issues DROP CONSTRAINT IF EXISTS qa_issues_state_check;
ALTER TABLE public.qa_issues ADD CONSTRAINT qa_issues_state_check
  CHECK (state IN ('new','triaged','in_progress','verification','verified','failed','closed','dismissed'));

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
  -- Row casts validate SQL types even in validate-only mode, before any writes.
  FOREACH tab IN ARRAY ARRAY['qa_issues','qa_commands','qa_events','qa_comments','qa_uploads','qa_attachments','qa_slack_links'] LOOP
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
    FOREACH tab IN ARRAY ARRAY['qa_commands','qa_events','qa_comments','qa_uploads','qa_attachments','qa_slack_links'] LOOP
      EXECUTE format('INSERT INTO public.%I SELECT * FROM jsonb_populate_recordset(null::public.%I,$1) ON CONFLICT(id) DO NOTHING',tab,tab) USING p_tables->tab;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('validateOnly',p_validate_only,'inserted',
    CASE WHEN NOT p_validate_only AND jsonb_array_length(conflicts)=0 AND jsonb_array_length(missing_assets)=0 THEN inserted ELSE 0 END,
    'skipped',skipped,'conflicts',conflicts,'missingAssets',missing_assets,'pending',inserted);
END;
$$;

-- v1 display preferences are normalized to v2 by the shared API before saving.
CREATE OR REPLACE FUNCTION public.livo_qa_save_workflow(p_auth_id uuid,p_workflow jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE states text[]:=ARRAY['new','triaged','in_progress','verification','verified','failed','closed','dismissed'];
  item jsonb; grouped text[]:=ARRAY[]::text[]; member_state text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.members WHERE auth_id=p_auth_id AND is_active=true AND role::text IN ('admin','super_admin')) THEN
    RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_workflow) IS DISTINCT FROM 'object' OR p_workflow->'version' IS DISTINCT FROM '2'::jsonb
    OR jsonb_typeof(p_workflow->'order') IS DISTINCT FROM 'array' OR jsonb_typeof(p_workflow->'labels') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_workflow->'groups') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'qa_invalid_workflow' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_workflow))<>4 OR jsonb_array_length(p_workflow->'order')<>8
    OR (SELECT array_agg(s ORDER BY s) FROM jsonb_array_elements_text(p_workflow->'order') s)
      IS DISTINCT FROM ARRAY['closed','dismissed','failed','in_progress','new','triaged','verification','verified']::text[]
    OR (SELECT count(*) FROM jsonb_object_keys(p_workflow->'labels'))<>8
    OR EXISTS(SELECT 1 FROM jsonb_each(p_workflow->'labels') e WHERE NOT e.key=ANY(states)
      OR jsonb_typeof(e.value)<>'string' OR length(e.value#>>'{}')>40 OR (e.value#>>'{}')~'[[:cntrl:]]')
    OR EXISTS(SELECT 1 FROM jsonb_each_text(p_workflow->'labels') e WHERE btrim(e.value)<>''
      GROUP BY lower(btrim(e.value)) HAVING count(*)>1)
    OR jsonb_array_length(p_workflow->'groups')>8 THEN
    RAISE EXCEPTION 'qa_invalid_workflow' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_workflow->'groups') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'qa_invalid_workflow' USING ERRCODE='22023'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(item))<>3 OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'label') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'states') IS DISTINCT FROM 'array'
      OR length(btrim(item->>'label')) NOT BETWEEN 1 AND 40 OR (item->>'label')~'[[:cntrl:]]' THEN
      RAISE EXCEPTION 'qa_invalid_workflow' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(item->'states') NOT BETWEEN 2 AND 4 OR NOT (item->'states') ? (item->>'id') THEN
      RAISE EXCEPTION 'qa_invalid_workflow' USING ERRCODE='22023'; END IF;
    FOR member_state IN SELECT jsonb_array_elements_text(item->'states') LOOP
      IF member_state NOT IN ('new','triaged','in_progress','verification') OR member_state=ANY(grouped) THEN
        RAISE EXCEPTION 'qa_invalid_workflow' USING ERRCODE='22023'; END IF;
      grouped:=array_append(grouped,member_state);
    END LOOP;
  END LOOP;
  INSERT INTO public.system_settings(key,value,updated_at) VALUES('qa_workflow',p_workflow,now())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at;
  RETURN p_workflow;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_restore(uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_restore(uuid,jsonb,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.livo_qa_save_workflow(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_save_workflow(uuid,jsonb) TO service_role;
