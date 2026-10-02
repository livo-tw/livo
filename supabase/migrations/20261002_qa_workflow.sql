-- QA is optional and disabled unless feature_toggles.qa is exactly true.
CREATE TABLE IF NOT EXISTS public.qa_issues (
  id text PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default' CHECK (workspace_id='default'),
  project_id text NOT NULL, state text NOT NULL CHECK (state IN ('new','triaged','in_progress','verification','closed')),
  assignee_id text, qa_owner_id text, reporter_id text NOT NULL, title text NOT NULL,
  version integer NOT NULL CHECK (version>0), updated_at timestamptz NOT NULL, data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS qa_issues_project_state ON public.qa_issues(workspace_id,project_id,state,updated_at DESC);
CREATE TABLE IF NOT EXISTS public.qa_commands (
  id text PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default' CHECK (workspace_id='default'),
  issue_id text NOT NULL REFERENCES public.qa_issues(id), actor_id text NOT NULL,
  payload_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.qa_events (
  id text PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default' CHECK (workspace_id='default'),
  issue_id text NOT NULL REFERENCES public.qa_issues(id), actor_id text NOT NULL,
  type text NOT NULL, detail text NOT NULL DEFAULT '', version integer NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS public.qa_comments (
  id text PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default' CHECK (workspace_id='default'),
  issue_id text NOT NULL REFERENCES public.qa_issues(id), actor_id text NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000), created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS public.qa_uploads (
  id text PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default' CHECK (workspace_id='default'),
  issue_id text NOT NULL REFERENCES public.qa_issues(id), actor_id text NOT NULL,
  file_name text NOT NULL, mime_type text NOT NULL, size bigint NOT NULL CHECK (size BETWEEN 1 AND 209715200),
  storage_path text NOT NULL UNIQUE, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.qa_attachments (
  id text PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default' CHECK (workspace_id='default'),
  issue_id text NOT NULL REFERENCES public.qa_issues(id), uploaded_by text NOT NULL,
  file_name text NOT NULL, mime_type text NOT NULL, size bigint NOT NULL CHECK (size BETWEEN 1 AND 209715200),
  storage_path text NOT NULL UNIQUE, created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS qa_events_issue ON public.qa_events(issue_id,created_at,id);
CREATE INDEX IF NOT EXISTS qa_comments_issue ON public.qa_comments(issue_id,created_at,id);
CREATE INDEX IF NOT EXISTS qa_attachments_issue ON public.qa_attachments(issue_id,created_at,id);
CREATE TABLE IF NOT EXISTS public.qa_slack_links (
  id text PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default' CHECK (workspace_id='default'),
  issue_id text NOT NULL REFERENCES public.qa_issues(id) ON DELETE RESTRICT,
  team_id text NOT NULL, channel_id text NOT NULL, thread_ts text NOT NULL, card_ts text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(team_id,channel_id,thread_ts)
);
CREATE TABLE IF NOT EXISTS public.qa_slack_receipts (
  id text PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default' CHECK (workspace_id='default'), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.qa_slack_inbox (
  id text PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default' CHECK (workspace_id='default'), payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done')), attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz
);
CREATE INDEX IF NOT EXISTS qa_slack_inbox_pending ON public.qa_slack_inbox(state,next_attempt_at,lease_until);

-- No browser/PostgREST writes or reads: the API validates a live active member,
-- the feature gate, and the shared domain contract. Never accept actorId input.
DO $migration$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['qa_issues','qa_commands','qa_events','qa_comments','qa_uploads','qa_attachments','qa_slack_links','qa_slack_receipts','qa_slack_inbox'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated',tab);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role',tab);
  END LOOP;
END $migration$;

CREATE OR REPLACE FUNCTION public.livo_qa_enabled()
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT COALESCE((SELECT value->'qa'='true'::jsonb FROM public.system_settings WHERE key='feature_toggles'),false);
$$;
CREATE OR REPLACE FUNCTION public.livo_guard_qa_toggle()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.key='feature_toggles' THEN PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature')); END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS livo_guard_qa_toggle ON public.system_settings;
CREATE TRIGGER livo_guard_qa_toggle BEFORE INSERT OR UPDATE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.livo_guard_qa_toggle();

-- Only the service role may propose the domain-validated aggregate. The SQL
-- transaction rechecks active membership/feature state and commits receipt,
-- aggregate and audit event together. The receipt is bound to the actor+hash.
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
        WHEN 'edit' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id
        WHEN 'hold' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id
        WHEN 'reopen' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id
        ELSE false END;
      IF NOT COALESCE(allowed,false) THEN RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
      IF p_data->>'id' IS DISTINCT FROM p_issue_id OR p_data->>'workspaceId'<>'default'
        OR p_data->>'reporterId' IS DISTINCT FROM existing.reporter_id
        OR (p_data->>'version')::integer<>existing.version+1 THEN
        RAISE EXCEPTION 'invalid_issue' USING ERRCODE='22023'; END IF;
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

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('qa-evidence','qa-evidence',false,209715200,ARRAY['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm','application/pdf','text/plain'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=209715200,
  allowed_mime_types=EXCLUDED.allowed_mime_types;
-- Signed upload uses a server-issued capability; direct storage reads/writes
-- remain forbidden even if an older installation has permissive policies.
DROP POLICY IF EXISTS qa_storage_private ON storage.objects;
CREATE POLICY qa_storage_private ON storage.objects AS RESTRICTIVE FOR ALL TO anon,authenticated
  USING(bucket_id<>'qa-evidence') WITH CHECK(bucket_id<>'qa-evidence');

CREATE OR REPLACE FUNCTION public.livo_qa_finalize_upload(p_auth_id uuid,p_upload_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,storage AS $$
DECLARE actor text; u public.qa_uploads%ROWTYPE; obj storage.objects%ROWTYPE; a public.qa_attachments%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  SELECT id INTO actor FROM public.members WHERE auth_id=p_auth_id AND is_active=true LIMIT 1;
  IF actor IS NULL THEN RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
  SELECT * INTO u FROM public.qa_uploads WHERE id=p_upload_id AND workspace_id='default' FOR UPDATE;
  IF NOT FOUND OR u.actor_id<>actor THEN RAISE EXCEPTION 'upload_not_found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO a FROM public.qa_attachments WHERE id=u.id AND workspace_id='default';
  IF FOUND THEN RETURN to_jsonb(a); END IF;
  IF u.expires_at<now() THEN RAISE EXCEPTION 'upload_expired' USING ERRCODE='22023'; END IF;
  SELECT * INTO obj FROM storage.objects WHERE bucket_id='qa-evidence' AND name=u.storage_path FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'upload_incomplete' USING ERRCODE='22023'; END IF;
  IF COALESCE((obj.metadata->>'size')::bigint,-1)<>u.size
    OR lower(COALESCE(obj.metadata->>'mimetype',''))<>u.mime_type THEN
    RAISE EXCEPTION 'upload_metadata_mismatch' USING ERRCODE='22023'; END IF;
  INSERT INTO public.qa_attachments(id,issue_id,uploaded_by,file_name,mime_type,size,storage_path,created_at)
    VALUES(u.id,u.issue_id,actor,u.file_name,u.mime_type,u.size,u.storage_path,now()) RETURNING * INTO a;
  UPDATE public.qa_uploads SET completed_at=now() WHERE id=u.id AND workspace_id='default';
  RETURN to_jsonb(a);
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_finalize_upload(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_finalize_upload(uuid,text) TO service_role;

-- Pending signed upload tokens cannot write after QA is disabled or the
-- reservation expires, and completed objects cannot be replaced in place.
CREATE OR REPLACE FUNCTION public.livo_guard_qa_object()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,storage AS $$
BEGIN
  IF NEW.bucket_id='qa-evidence' THEN
    -- Storage may refresh access timestamps while serving an existing object.
    -- That does not grant permission to replace its bytes, path or metadata.
    IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['last_accessed_at','updated_at'])=
      (to_jsonb(OLD)-ARRAY['last_accessed_at','updated_at']) THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
    IF NOT public.livo_qa_enabled() OR NOT EXISTS(SELECT 1 FROM public.qa_uploads u
      JOIN public.members m ON m.id=u.actor_id AND m.is_active=true
      WHERE u.storage_path=NEW.name AND u.workspace_id='default' AND u.completed_at IS NULL AND u.expires_at>now()) THEN
      RAISE EXCEPTION 'qa_upload_unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS livo_guard_qa_object ON storage.objects;
CREATE TRIGGER livo_guard_qa_object BEFORE INSERT OR UPDATE ON storage.objects
FOR EACH ROW EXECUTE FUNCTION public.livo_guard_qa_object();

-- Restore merges QA rows without deleting history. Preflight accepts the full
-- backup for dependency validation; only this explicit QA table list is written.
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
          OR COALESCE(issue->>'state','') NOT IN ('new','triaged','in_progress','verification','closed')
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
REVOKE ALL ON FUNCTION public.livo_qa_restore(uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_restore(uuid,jsonb,boolean) TO service_role;

-- Operational Slack inbox, deliberately excluded from backups. Runtime cleanup
-- below only removes expired inbox payloads; applying this migration deletes no data.
CREATE OR REPLACE FUNCTION public.livo_qa_slack_enqueue(p_id text,p_payload jsonb)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() OR NOT public.livo_slack_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  IF p_id IS NULL OR length(p_id) NOT BETWEEN 8 AND 200 OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>262144 THEN
    RAISE EXCEPTION 'invalid_command' USING ERRCODE='22023'; END IF;
  DELETE FROM public.qa_slack_inbox WHERE workspace_id='default' AND created_at<now()-interval '30 days';
  INSERT INTO public.qa_slack_inbox(id,payload,attempts,next_attempt_at,lease_until)
    VALUES(p_id,p_payload,1,now()+interval '30 seconds',now()+interval '2 minutes') ON CONFLICT(id) DO NOTHING;
  RETURN p_id;
END;
$$;
CREATE OR REPLACE FUNCTION public.livo_qa_slack_pending()
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() OR NOT public.livo_slack_enabled() THEN RETURN '[]'::jsonb; END IF;
  DELETE FROM public.qa_slack_inbox WHERE workspace_id='default' AND created_at<now()-interval '30 days';
  WITH candidates AS (SELECT id FROM public.qa_slack_inbox WHERE workspace_id='default' AND state='pending'
      AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_attempt_at,id
      LIMIT 20 FOR UPDATE SKIP LOCKED), claimed AS (
    UPDATE public.qa_slack_inbox q SET attempts=q.attempts+1,lease_until=now()+interval '2 minutes',
      next_attempt_at=now()+make_interval(secs=>LEAST(3600,30*power(2,LEAST(q.attempts,7)))::integer)
      FROM candidates c WHERE q.id=c.id AND q.workspace_id='default' RETURNING q.id,q.payload)
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'payload',payload)),'[]'::jsonb) INTO result FROM claimed;
  RETURN result;
END;
$$;
CREATE OR REPLACE FUNCTION public.livo_qa_slack_complete(p_id text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  UPDATE public.qa_slack_inbox SET state='done',payload='{}'::jsonb,lease_until=null
    WHERE id=p_id AND workspace_id='default';
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_slack_enqueue(text,jsonb),public.livo_qa_slack_pending(),public.livo_qa_slack_complete(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_slack_enqueue(text,jsonb),public.livo_qa_slack_pending(),public.livo_qa_slack_complete(text) TO service_role;
