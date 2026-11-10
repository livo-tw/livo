-- Comment files remain private reservations until the original command transaction publishes them.
ALTER TABLE public.qa_uploads ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'issue' CHECK(purpose IN ('issue','comment'));
ALTER TABLE public.qa_attachments ADD COLUMN IF NOT EXISTS comment_id text REFERENCES public.qa_comments(id);
ALTER TABLE public.qa_comments DROP CONSTRAINT IF EXISTS qa_comments_body_check;
ALTER TABLE public.qa_comments ADD CONSTRAINT qa_comments_body_check CHECK(length(body) BETWEEN 0 AND 20000);
CREATE INDEX IF NOT EXISTS qa_attachments_comment ON public.qa_attachments(comment_id) WHERE comment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.livo_qa_comment_attachment_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.comment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.qa_comments c WHERE c.workspace_id=NEW.workspace_id
    AND c.id=NEW.comment_id AND c.issue_id=NEW.issue_id AND c.actor_id=NEW.uploaded_by) THEN
    RAISE EXCEPTION 'qa_invalid_comment_attachments' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS livo_qa_comment_attachment_scope ON public.qa_attachments;
CREATE TRIGGER livo_qa_comment_attachment_scope BEFORE INSERT OR UPDATE OF comment_id,issue_id,uploaded_by ON public.qa_attachments
  FOR EACH ROW EXECUTE FUNCTION public.livo_qa_comment_attachment_scope();
REVOKE ALL ON FUNCTION public.livo_qa_comment_attachment_scope() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.livo_qa_publish_comment_attachments(p_auth_id uuid,p_issue_id text,p_comment jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,storage AS $$
DECLARE actor text; external_actor boolean; project text; ids jsonb:=COALESCE(p_comment->'attachmentIds','[]'::jsonb);
  file_id text; u public.qa_uploads%ROWTYPE; obj storage.objects%ROWTYPE; linked public.qa_attachments%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  SELECT s.actor_id,s.is_external INTO actor,external_actor FROM public.livo_qa_scoped_actor(p_auth_id) s;
  SELECT q.project_id INTO project FROM public.qa_issues q WHERE q.workspace_id='default' AND q.id=p_issue_id FOR SHARE;
  IF actor IS NULL OR project IS NULL THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
  IF external_actor THEN PERFORM public.livo_qa_lock_external_project(actor,project); END IF;
  IF jsonb_typeof(ids)<>'array' OR jsonb_array_length(ids)>10
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(ids) i WHERE jsonb_typeof(i)<>'string' OR (i#>>'{}') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$')
    OR (SELECT count(*) FROM jsonb_array_elements(ids))<>(SELECT count(DISTINCT i) FROM jsonb_array_elements(ids) i)
    OR jsonb_typeof(p_comment->'body') IS DISTINCT FROM 'string' OR length(p_comment->>'body')>20000
    OR (btrim(p_comment->>'body')='' AND jsonb_array_length(ids)=0)
    OR NOT EXISTS(SELECT 1 FROM public.qa_comments c WHERE c.workspace_id='default' AND c.id=p_comment->>'id'
      AND c.issue_id=p_issue_id AND c.actor_id=actor AND c.body=p_comment->>'body') THEN
    RAISE EXCEPTION 'qa_invalid_comment_attachments' USING ERRCODE='22023';
  END IF;
  FOR file_id IN SELECT value FROM jsonb_array_elements_text(ids) ORDER BY value LOOP
    SELECT * INTO linked FROM public.qa_attachments a WHERE a.workspace_id='default' AND a.id=file_id;
    IF FOUND THEN
      IF linked.issue_id<>p_issue_id OR linked.uploaded_by<>actor OR linked.comment_id IS DISTINCT FROM p_comment->>'id' THEN
        RAISE EXCEPTION 'qa_invalid_comment_attachments' USING ERRCODE='22023';
      END IF;
      CONTINUE;
    END IF;
    SELECT * INTO u FROM public.qa_uploads WHERE workspace_id='default' AND id=file_id FOR UPDATE;
    IF NOT FOUND OR u.issue_id<>p_issue_id OR u.actor_id<>actor OR u.purpose<>'comment'
      OR u.completed_at IS NOT NULL OR u.expires_at<=clock_timestamp() OR u.cleanup_token IS NOT NULL THEN
      RAISE EXCEPTION 'qa_invalid_comment_attachments' USING ERRCODE='22023';
    END IF;
    SELECT * INTO obj FROM storage.objects WHERE bucket_id='qa-evidence' AND name=u.storage_path FOR SHARE;
    IF NOT FOUND OR COALESCE((obj.metadata->>'size')::bigint,-1)<>u.size OR lower(COALESCE(obj.metadata->>'mimetype',''))<>u.mime_type THEN
      RAISE EXCEPTION 'qa_upload_incomplete' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.qa_attachments(id,issue_id,uploaded_by,file_name,mime_type,size,storage_path,created_at,comment_id)
      VALUES(u.id,p_issue_id,actor,u.file_name,u.mime_type,u.size,u.storage_path,(p_comment->>'createdAt')::timestamptz,p_comment->>'id');
    UPDATE public.qa_uploads SET completed_at=clock_timestamp() WHERE workspace_id='default' AND id=u.id;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_publish_comment_attachments(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_publish_comment_attachments(uuid,text,jsonb) TO service_role;

-- Preserve the published OID, assignment guard, original receipt and live grant checks.
CREATE OR REPLACE FUNCTION public.livo_qa_commit(p_auth_id uuid,p_issue_id text,p_command_id text,
  p_payload_hash text,p_expected_version integer,p_kind text,p_data jsonb,p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE previous_guard text:=current_setting('livo.qa_assignment_enforce',true); result jsonb;
BEGIN
  PERFORM set_config('livo.qa_assignment_enforce','true',true);
  result:=public.livo_qa_commit_assignment_base(p_auth_id,p_issue_id,p_command_id,
    p_payload_hash,p_expected_version,p_kind,p_data,p_event);
  IF p_kind='comment' THEN PERFORM public.livo_qa_publish_comment_attachments(p_auth_id,p_issue_id,result); END IF;
  PERFORM set_config('livo.qa_assignment_enforce',COALESCE(previous_guard,'false'),true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('livo.qa_assignment_enforce',COALESCE(previous_guard,'false'),true);
  RAISE;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_external_reserve_upload(p_auth_id uuid,p_issue_id text,p_upload_id text,
  p_name text,p_mime text,p_size bigint,p_purpose text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  IF p_purpose NOT IN ('issue','comment') OR p_purpose IS NULL THEN RAISE EXCEPTION 'qa_invalid_file' USING ERRCODE='22023'; END IF;
  result:=public.livo_qa_external_reserve_upload(p_auth_id,p_issue_id,p_upload_id,p_name,p_mime,p_size);
  UPDATE public.qa_uploads SET purpose=p_purpose WHERE workspace_id='default' AND id=p_upload_id;
  RETURN result||jsonb_build_object('purpose',p_purpose);
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_external_reserve_upload(uuid,text,text,text,text,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_external_reserve_upload(uuid,text,text,text,text,bigint,text) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_attachment_for_download(p_auth_id uuid,p_attachment_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,storage AS $$
DECLARE actor text; external_actor boolean; project text; a public.qa_attachments%ROWTYPE; u public.qa_uploads%ROWTYPE; result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  SELECT s.actor_id,s.is_external INTO actor,external_actor FROM public.livo_qa_scoped_actor(p_auth_id) s;
  IF actor IS NULL THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO a FROM public.qa_attachments WHERE workspace_id='default' AND id=p_attachment_id;
  IF FOUND THEN result:=to_jsonb(a);
  ELSE
    SELECT * INTO u FROM public.qa_uploads WHERE workspace_id='default' AND id=p_attachment_id AND actor_id=actor
      AND purpose='comment' AND completed_at IS NULL AND expires_at>clock_timestamp() AND cleanup_token IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'qa_attachment_not_found' USING ERRCODE='P0002'; END IF;
    IF NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='qa-evidence' AND o.name=u.storage_path
      AND COALESCE((o.metadata->>'size')::bigint,-1)=u.size AND lower(COALESCE(o.metadata->>'mimetype',''))=u.mime_type) THEN
      RAISE EXCEPTION 'qa_attachment_not_found' USING ERRCODE='P0002'; END IF;
    result:=to_jsonb(u)||jsonb_build_object('uploaded_by',actor);
  END IF;
  SELECT q.project_id INTO project FROM public.qa_issues q WHERE q.workspace_id='default' AND q.id=result->>'issue_id' FOR SHARE;
  IF project IS NULL THEN RAISE EXCEPTION 'qa_attachment_not_found' USING ERRCODE='P0002'; END IF;
  IF external_actor THEN PERFORM public.livo_qa_lock_external_project(actor,project); END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_attachment_for_download(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_attachment_for_download(uuid,text) TO service_role;

-- Extend only the attachment metadata in the existing scoped external detail RPC.
DO $patch$
DECLARE definition text; old_fragment text:=$old$'mimeType',a.mime_type,'size',a.size,'uploadedBy',a.uploaded_by,'createdAt',a.created_at)$old$;
BEGIN
  SELECT pg_get_functiondef('public.livo_qa_external_read(uuid,text,jsonb)'::regprocedure) INTO definition;
  IF position($new$'createdAt',a.created_at,'commentId',a.comment_id)$new$ IN definition)=0 THEN
    IF (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 THEN
      RAISE EXCEPTION 'qa_external_read_comment_patch_unrecognized'; END IF;
    EXECUTE replace(definition,old_fragment,$new$'mimeType',a.mime_type,'size',a.size,'uploadedBy',a.uploaded_by,'createdAt',a.created_at,'commentId',a.comment_id)$new$);
  END IF;
END;
$patch$;

CREATE OR REPLACE FUNCTION public.livo_qa_finalize_upload(p_auth_id uuid,p_upload_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,storage AS $$
DECLARE actor text; is_external boolean; project text; u public.qa_uploads%ROWTYPE; obj storage.objects%ROWTYPE; a public.qa_attachments%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  SELECT s.actor_id,s.is_external INTO actor,is_external FROM public.livo_qa_scoped_actor(p_auth_id) s;
  IF actor IS NULL THEN RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
  SELECT * INTO u FROM public.qa_uploads WHERE id=p_upload_id AND workspace_id='default' FOR UPDATE;
  IF NOT FOUND OR u.actor_id<>actor THEN RAISE EXCEPTION 'upload_not_found' USING ERRCODE='P0002'; END IF;
  IF is_external THEN
    SELECT q.project_id INTO project FROM public.qa_issues q WHERE q.id=u.issue_id AND q.workspace_id='default' FOR SHARE;
    PERFORM public.livo_qa_lock_external_project(actor,project);
  END IF;
  SELECT * INTO a FROM public.qa_attachments WHERE id=u.id AND workspace_id='default';
  IF FOUND THEN RETURN to_jsonb(a); END IF;
  IF u.expires_at<now() THEN RAISE EXCEPTION 'upload_expired' USING ERRCODE='22023'; END IF;
  SELECT * INTO obj FROM storage.objects WHERE bucket_id='qa-evidence' AND name=u.storage_path FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'upload_incomplete' USING ERRCODE='22023'; END IF;
  IF COALESCE((obj.metadata->>'size')::bigint,-1)<>u.size
    OR lower(COALESCE(obj.metadata->>'mimetype',''))<>u.mime_type THEN
    RAISE EXCEPTION 'upload_metadata_mismatch' USING ERRCODE='22023'; END IF;
  IF u.purpose='comment' THEN RETURN to_jsonb(u)||jsonb_build_object('uploaded_by',actor); END IF;
  INSERT INTO public.qa_attachments(id,issue_id,uploaded_by,file_name,mime_type,size,storage_path,created_at)
    VALUES(u.id,u.issue_id,actor,u.file_name,u.mime_type,u.size,u.storage_path,now()) RETURNING * INTO a;
  UPDATE public.qa_uploads SET completed_at=now() WHERE id=u.id AND workspace_id='default';
  RETURN to_jsonb(a);
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_finalize_upload(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_finalize_upload(uuid,text) TO service_role;


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
  IF p_tables ? 'qa_uploads' THEN
  p_tables:=jsonb_set(p_tables,'{qa_uploads}',COALESCE((SELECT jsonb_agg(jsonb_build_object('purpose','issue')||r)
    FROM jsonb_array_elements(p_tables->'qa_uploads') r),'[]'::jsonb));
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_tables->'qa_attachments') a WHERE a->>'comment_id' IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_tables->'qa_comments') c WHERE c->>'id'=a->>'comment_id'
      AND c->>'issue_id'=a->>'issue_id' AND c->>'actor_id'=a->>'uploaded_by')
    AND NOT EXISTS(SELECT 1 FROM public.qa_comments c WHERE c.workspace_id='default' AND c.id=a->>'comment_id'
      AND c.issue_id=a->>'issue_id' AND c.actor_id=a->>'uploaded_by'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_tables->'qa_comments') c WHERE btrim(COALESCE(c->>'body',''))=''
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_tables->'qa_attachments') a WHERE a->>'comment_id'=c->>'id'
        AND a->>'issue_id'=c->>'issue_id' AND a->>'uploaded_by'=c->>'actor_id')) THEN
    RAISE EXCEPTION 'invalid_issue: comment_attachment' USING ERRCODE='22023';
  END IF;

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
        IF tab='qa_comments' AND COALESCE(length(item->>'body'),0) NOT BETWEEN 0 AND 20000 THEN
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

SELECT public.livo_apply_active_member_gate();
