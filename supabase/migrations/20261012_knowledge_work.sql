-- Server-only plan commit. HTTP accepts a domain command, never this internal plan.
ALTER TABLE public.kb_pages ADD COLUMN IF NOT EXISTS private_draft_owner_id text;
ALTER TABLE public.kb_pages ADD COLUMN IF NOT EXISTS document_metadata jsonb NOT NULL DEFAULT '{"documentKind":null,"ownerId":null,"applicability":{"productVersion":null,"environment":null,"summary":null}}';
ALTER TABLE public.kb_revisions ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE public.kb_revisions ADD COLUMN IF NOT EXISTS document_metadata jsonb NOT NULL DEFAULT '{"documentKind":null,"ownerId":null,"applicability":{"productVersion":null,"environment":null,"summary":null}}';
CREATE TABLE IF NOT EXISTS public.kb_publications (
 id text PRIMARY KEY, page_id text NOT NULL REFERENCES public.kb_pages(id) ON DELETE RESTRICT,
 page_version integer NOT NULL, state text NOT NULL CHECK(state IN('effective','superseded')), version integer NOT NULL CHECK(version>0),
 predecessor_id text REFERENCES public.kb_publications(id) DEFERRABLE INITIALLY DEFERRED,
 successor_id text REFERENCES public.kb_publications(id) DEFERRABLE INITIALLY DEFERRED,
 published_by text NOT NULL, published_at timestamptz NOT NULL,
 FOREIGN KEY(page_id,page_version) REFERENCES public.kb_revisions(page_id,version) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS kb_one_effective_publication ON public.kb_publications(page_id) WHERE state='effective';
CREATE TABLE IF NOT EXISTS public.kb_source_links (
 id text PRIMARY KEY, page_id text NOT NULL REFERENCES public.kb_pages(id) ON DELETE RESTRICT,
 source_kind text NOT NULL CHECK(source_kind IN('knowledge','task','qa','knowledge_file','task_file','qa_file')),
 source_id text NOT NULL, source_version text NOT NULL, source_page_version integer,
 created_by text NOT NULL, created_at timestamptz NOT NULL, UNIQUE(page_id,source_kind,source_id),
 FOREIGN KEY(source_id,source_page_version) REFERENCES public.kb_revisions(page_id,version) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS public.kb_work_receipts (
 id text PRIMARY KEY, actor_id text NOT NULL, page_id text NOT NULL REFERENCES public.kb_pages(id) ON DELETE RESTRICT,
 canonical text NOT NULL, event_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.kb_work_events (
 id text PRIMARY KEY, actor_id text NOT NULL, page_id text NOT NULL REFERENCES public.kb_pages(id) ON DELETE RESTRICT,
 command_id text NOT NULL UNIQUE REFERENCES public.kb_work_receipts(id) DEFERRABLE INITIALLY DEFERRED,
 operation text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.kb_work_clock (id integer PRIMARY KEY CHECK(id=1), generation bigint NOT NULL DEFAULT 0);
INSERT INTO public.kb_work_clock(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION public.kb_work_tick() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN UPDATE public.kb_work_clock SET generation=generation+1 WHERE id=1; RETURN NULL; END $$;
REVOKE ALL ON FUNCTION public.kb_work_tick() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['members','projects','statuses','tasks','task_specs','task_attachments','qa_issues','qa_attachments','kb_pages','kb_revisions','kb_attachments','kb_publications','kb_source_links','field_locks','system_settings','external_account_bindings'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS kb_work_tick ON public.%I',t);
  EXECUTE format('CREATE TRIGGER kb_work_tick AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.kb_work_tick()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['kb_publications','kb_source_links','kb_work_receipts','kb_work_events','kb_work_clock'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
 END LOOP;
END $$;

-- This wrapper preserves the exact inherited ACL. Private ownership is an
-- additional condition; being an admin or metadata owner never grants view.
DO $$ BEGIN
 IF to_regprocedure('public.kb_inherited_permission(text,text)') IS NULL THEN
  ALTER FUNCTION public.kb_has_permission(text,text) RENAME TO kb_inherited_permission;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.kb_has_permission(page text,action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT public.kb_inherited_permission(page,action) AND NOT EXISTS (
  WITH RECURSIVE ancestors AS (SELECT id,parent_id,private_draft_owner_id,1 d FROM public.kb_pages WHERE id=page
   UNION ALL SELECT p.id,p.parent_id,p.private_draft_owner_id,a.d+1 FROM public.kb_pages p JOIN ancestors a ON p.id=a.parent_id WHERE a.d<4)
  SELECT 1 FROM ancestors WHERE private_draft_owner_id IS NOT NULL AND private_draft_owner_id IS DISTINCT FROM public.current_member_id()
 );
$$;
-- PostgreSQL policies retain function OIDs across a rename. Rebind every KB
-- predicate at its original OID, rather than leaving old policies on the old ACL.
CREATE OR REPLACE FUNCTION public.kb_inherited_permission(page text,action text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE actor public.members%ROWTYPE; p public.kb_pages%ROWTYPE; cursor_id text:=page; seen text[]:=ARRAY[]::text[]; rule jsonb; a text;
BEGIN
 IF action NOT IN('view','edit','comment') THEN RETURN false; END IF;
 SELECT * INTO actor FROM public.members WHERE auth_id=auth.uid() AND is_active;
 IF NOT FOUND OR (SELECT count(*) FROM public.members WHERE auth_id=auth.uid() AND is_active)<>1 OR actor.role::text NOT IN('member','admin','super_admin') THEN RETURN false; END IF;
 WHILE cursor_id IS NOT NULL LOOP
  IF cursor_id=ANY(seen) OR cardinality(seen)>=3 THEN RETURN false; END IF;
  seen:=array_append(seen,cursor_id); SELECT * INTO p FROM public.kb_pages WHERE id=cursor_id;
  IF NOT FOUND OR NOT public.kb_policy_valid(p.access_policy) OR (p.private_draft_owner_id IS NOT NULL AND p.private_draft_owner_id<>actor.id) THEN RETURN false; END IF;
  IF action<>'view' AND (p.is_archived OR (action='edit' AND p.admin_only AND actor.role::text NOT IN('admin','super_admin'))) THEN RETURN false; END IF;
  IF p.access_policy->>'mode'='custom' THEN
   FOREACH a IN ARRAY(CASE WHEN action='view' THEN ARRAY['view'] ELSE ARRAY['view',action] END) LOOP
    rule:=p.access_policy->a;
    IF NOT(rule->'roles' ? actor.role::text OR rule->'positions' ? actor.job_title OR rule->'member_ids' ? actor.id) THEN RETURN false; END IF;
   END LOOP;
  END IF;
  cursor_id:=p.parent_id;
 END LOOP;
 RETURN cardinality(seen)>0;
END $$;
REVOKE ALL ON FUNCTION public.kb_inherited_permission(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kb_inherited_permission(text,text),public.kb_has_permission(text,text) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public.kb_can_manage(page text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT public.kb_has_permission(page,'view') AND (public.is_livo_admin() OR (
  current_setting('role',true)='service_role' AND current_setting('livo.knowledge_command',true)='on'
  AND current_setting('livo.knowledge_operation',true)='share_draft' AND current_setting('livo.knowledge_page',true)=page
  AND EXISTS(SELECT 1 FROM public.kb_pages WHERE id=page AND private_draft_owner_id=public.current_member_id())
 ));
$$;

CREATE OR REPLACE FUNCTION public.kb_work_page_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE internal boolean:=current_user='service_role' AND current_setting('livo.knowledge_command',true)='on'; BEGIN
 IF TG_OP='INSERT' THEN
  IF (NEW.private_draft_owner_id IS NOT NULL OR NEW.document_metadata<>'{"documentKind":null,"ownerId":null,"applicability":{"productVersion":null,"environment":null,"summary":null}}'::jsonb) AND NOT internal THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
 ELSE
  IF (NEW.private_draft_owner_id IS DISTINCT FROM OLD.private_draft_owner_id OR NEW.document_metadata IS DISTINCT FROM OLD.document_metadata) AND NOT internal THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
  IF OLD.private_draft_owner_id IS NOT NULL AND NOT internal AND ROW(NEW.project_id,NEW.parent_id,NEW.access_policy) IS DISTINCT FROM ROW(OLD.project_id,OLD.parent_id,OLD.access_policy) THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS kb_work_page_guard ON public.kb_pages;
CREATE TRIGGER kb_work_page_guard BEFORE INSERT OR UPDATE ON public.kb_pages FOR EACH ROW EXECUTE FUNCTION public.kb_work_page_guard();
REVOKE ALL ON FUNCTION public.kb_work_page_guard() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.kb_save_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 INSERT INTO public.kb_revisions(page_id,title,body,document_metadata,created_by,created_at,version)
 VALUES(OLD.id,OLD.title,OLD.body,OLD.document_metadata,OLD.updated_by,OLD.updated_at,OLD.version) ON CONFLICT DO NOTHING;
 DELETE FROM public.kb_revisions r WHERE r.page_id=NEW.id AND r.id IN(SELECT id FROM public.kb_revisions WHERE page_id=NEW.id ORDER BY version DESC OFFSET 20)
  AND NOT EXISTS(SELECT 1 FROM public.kb_publications p WHERE p.page_id=r.page_id AND p.page_version=r.version)
  AND NOT EXISTS(SELECT 1 FROM public.kb_source_links l WHERE l.source_kind='knowledge' AND l.source_id=r.page_id AND l.source_page_version=r.version);
 RETURN NEW;
END $$;

-- Verify a GoTrue-accepted identity again while the clock locks every state
-- transition relevant to authorization. The adapter alone can invoke this RPC.
CREATE OR REPLACE FUNCTION public.kb_work_identity(p_auth_id uuid,p_slack_identity jsonb DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE a public.members%ROWTYPE; b public.external_account_bindings%ROWTYPE; BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM public.members WHERE auth_id=p_auth_id AND is_active;
 IF NOT FOUND OR a.role::text NOT IN('member','admin','super_admin') OR (SELECT count(*) FROM public.members WHERE auth_id=p_auth_id AND is_active)<>1 THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
 IF p_slack_identity IS NOT NULL THEN
  IF jsonb_typeof(p_slack_identity)<>'object' OR (p_slack_identity-ARRAY['bindingId','teamId','userId'])<>'{}'::jsonb
   OR COALESCE(p_slack_identity->>'bindingId','') !~ '^[a-zA-Z0-9_-]{1,200}$' OR COALESCE(p_slack_identity->>'teamId','') !~ '^T[A-Z0-9]+$'
   OR COALESCE(p_slack_identity->>'userId','') !~ '^[UW][A-Z0-9]+$' THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO b FROM public.external_account_bindings WHERE id::text=p_slack_identity->>'bindingId';
  IF NOT FOUND OR b.member_id IS DISTINCT FROM a.id OR b.platform IS DISTINCT FROM 'slack' OR b.is_verified IS DISTINCT FROM true
   OR b.verified_by IS NULL OR b.verified_by NOT IN('email','admin') OR b.platform_team_id IS DISTINCT FROM p_slack_identity->>'teamId'
   OR b.platform_user_id IS DISTINCT FROM p_slack_identity->>'userId' OR (SELECT count(*) FROM public.external_account_bindings
     WHERE platform='slack' AND platform_team_id=b.platform_team_id AND platform_user_id=b.platform_user_id)<>1 OR NOT public.livo_slack_enabled()
   THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN a.id;
END $$;
CREATE OR REPLACE FUNCTION public.livo_knowledge_work_snapshot(p_auth_id uuid,p_slack_identity jsonb DEFAULT NULL,p_command_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor_id text; t text; tables jsonb:='{}'; rows jsonb; n bigint; total bigint:=0; generation bigint; BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
 SELECT c.generation INTO generation FROM public.kb_work_clock c WHERE id=1 FOR SHARE;
 actor_id:=public.kb_work_identity(p_auth_id,p_slack_identity);
 FOREACH t IN ARRAY ARRAY['members','projects','statuses','tasks','task_specs','task_attachments','qa_issues','qa_attachments','kb_pages','kb_revisions','kb_attachments','kb_publications','kb_source_links','kb_work_receipts','field_locks','system_settings'] LOOP
  IF t='kb_work_receipts' THEN SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]'),count(*) INTO rows,n FROM public.kb_work_receipts r WHERE id=p_command_id;
  ELSE EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(r)),''[]''::jsonb),count(*) FROM public.%I r',t) INTO rows,n; END IF;
  total:=total+n; IF total>100000 OR octet_length(rows::text)>25000000 THEN RAISE EXCEPTION 'knowledge_incomplete_source' USING ERRCODE='22023'; END IF;
  tables:=tables||jsonb_build_object(t,rows);
 END LOOP;
 RETURN jsonb_build_object('generation',generation,'workspaceId','default','authId',p_auth_id::text,'tables',tables);
END $$;

CREATE OR REPLACE FUNCTION public.livo_knowledge_work_commit(p_auth_id uuid,p_plan jsonb,p_slack_identity jsonb DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor_id text; generation bigint; oldclaims text; oldsub text; receipt public.kb_work_receipts%ROWTYPE; m jsonb; vals jsonb; tab text; op text;
 allowed text[]; keys text[]; columns text; selected text; assignments text; affected integer; pid text; command jsonb; BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
 SELECT c.generation INTO generation FROM public.kb_work_clock c WHERE id=1 FOR UPDATE;
 actor_id:=public.kb_work_identity(p_auth_id,p_slack_identity); command:=p_plan->'command';
 IF p_plan->>'actorId' IS DISTINCT FROM actor_id OR COALESCE(command->>'commandId','') !~ '^[a-zA-Z0-9_-]{8,200}$' OR jsonb_typeof(p_plan->'mutations')<>'array' OR jsonb_array_length(p_plan->'mutations')>200 THEN RAISE EXCEPTION 'knowledge_invalid_input' USING ERRCODE='22023'; END IF;
 oldclaims:=current_setting('request.jwt.claims',true); oldsub:=current_setting('request.jwt.claim.sub',true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',p_auth_id,'role','service_role')::text,true); PERFORM set_config('request.jwt.claim.sub',p_auth_id::text,true);
 SELECT * INTO receipt FROM public.kb_work_receipts WHERE id=command->>'commandId';
 IF FOUND THEN
  IF receipt.actor_id<>actor_id OR receipt.canonical IS DISTINCT FROM p_plan->>'canonical' THEN RAISE EXCEPTION 'knowledge_command_reused' USING ERRCODE='40001'; END IF;
  IF NOT public.kb_has_permission(receipt.page_id,'view') THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
  PERFORM set_config('request.jwt.claims',COALESCE(oldclaims,''),true); PERFORM set_config('request.jwt.claim.sub',COALESCE(oldsub,''),true); RETURN receipt.page_id;
 END IF;
 IF generation IS DISTINCT FROM (p_plan->>'generation')::bigint THEN RAISE EXCEPTION 'knowledge_conflict' USING ERRCODE='40001'; END IF;
 IF command->>'operation'<>'save_draft' THEN
  IF NOT public.kb_has_permission(command->>'pageId','edit') THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.kb_pages WHERE id=command->>'pageId' AND version=(command->>'expectedVersion')::integer) THEN RAISE EXCEPTION 'knowledge_conflict' USING ERRCODE='40001'; END IF;
 END IF;
 FOREACH pid IN ARRAY ARRAY(SELECT jsonb_array_elements_text(p_plan->'leasePageIds')) LOOP
  IF NOT public.kb_has_permission(pid,'edit') THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
  INSERT INTO public.field_locks(lock_key,locked_by,expires_at) VALUES('kb:'||pid,actor_id,clock_timestamp()+interval '30 seconds')
   ON CONFLICT(lock_key) DO UPDATE SET locked_by=excluded.locked_by,expires_at=excluded.expires_at
    WHERE field_locks.locked_by=actor_id OR field_locks.expires_at<=clock_timestamp();
  GET DIAGNOSTICS affected=ROW_COUNT; IF affected<>1 THEN RAISE EXCEPTION 'knowledge_conflict' USING ERRCODE='40001'; END IF;
 END LOOP;
 PERFORM set_config('livo.knowledge_command','on',true);
 PERFORM set_config('livo.knowledge_operation',command->>'operation',true); PERFORM set_config('livo.knowledge_page',p_plan->>'pageId',true);
 FOR m IN SELECT value FROM jsonb_array_elements(p_plan->'mutations') LOOP
  tab:=m->>'table'; op:=m->>'operation'; vals:=m->'values';
  allowed:=CASE tab WHEN 'kb_pages' THEN ARRAY['title','body','project_id','parent_id','sort_order','is_archived','admin_only','category','access_policy','created_by','updated_by','created_at','updated_at','version','private_draft_owner_id','document_metadata']
   WHEN 'kb_revisions' THEN ARRAY['page_id','version','title','body','document_metadata','created_by','created_at']
   WHEN 'kb_publications' THEN ARRAY['page_id','page_version','state','version','predecessor_id','successor_id','published_by','published_at']
   WHEN 'kb_source_links' THEN ARRAY['page_id','source_kind','source_id','source_version','source_page_version','created_by','created_at'] ELSE NULL END;
  IF allowed IS NULL OR op NOT IN('insert','update','delete') OR jsonb_typeof(vals)<>'object' OR (vals-allowed)<>'{}'::jsonb OR (op='delete' AND tab<>'kb_source_links') THEN RAISE EXCEPTION 'knowledge_invalid_input' USING ERRCODE='22023'; END IF;
  IF tab='kb_pages' AND ((op='insert' AND command->>'operation'<>'save_draft') OR m->>'id' IS DISTINCT FROM p_plan->>'pageId') THEN RAISE EXCEPTION 'knowledge_invalid_input' USING ERRCODE='22023'; END IF;
  IF tab='kb_revisions' AND op<>'insert' THEN RAISE EXCEPTION 'knowledge_invalid_input' USING ERRCODE='22023'; END IF;
  IF op='delete' THEN EXECUTE format('DELETE FROM public.%I WHERE id=$1',tab) USING m->>'id';
  ELSE
   keys:=ARRAY(SELECT jsonb_object_keys(vals));
   SELECT string_agg(format('%I',k),','),string_agg(format('r.%I',k),','),string_agg(format('%I=r.%I',k,k),',') INTO columns,selected,assignments FROM unnest(keys) k;
   IF op='insert' THEN EXECUTE format('INSERT INTO public.%I(id,%s) SELECT $1,%s FROM jsonb_populate_record(NULL::public.%I,$2) r %s',tab,columns,selected,tab,CASE WHEN tab='kb_revisions' THEN 'ON CONFLICT(page_id,version) DO NOTHING' ELSE '' END) USING m->>'id',vals;
   ELSE EXECUTE format('UPDATE public.%I SET %s FROM jsonb_populate_record(NULL::public.%I,$2) r WHERE %I.id=$1',tab,assignments,tab,tab) USING m->>'id',vals; END IF;
  END IF;
 END LOOP;
 INSERT INTO public.kb_work_receipts(id,actor_id,page_id,canonical,event_id) VALUES(command->>'commandId',actor_id,p_plan->>'pageId',p_plan->>'canonical',p_plan->>'eventId');
 INSERT INTO public.kb_work_events(id,actor_id,page_id,command_id,operation) VALUES(p_plan->>'eventId',actor_id,p_plan->>'pageId',command->>'commandId',command->>'operation');
 PERFORM set_config('livo.knowledge_command','off',true); PERFORM set_config('livo.knowledge_operation','',true); PERFORM set_config('livo.knowledge_page','',true); PERFORM set_config('request.jwt.claims',COALESCE(oldclaims,''),true); PERFORM set_config('request.jwt.claim.sub',COALESCE(oldsub,''),true);
 RETURN p_plan->>'pageId';
END $$;
REVOKE ALL ON FUNCTION public.kb_work_identity(uuid,jsonb),public.livo_knowledge_work_snapshot(uuid,jsonb,text),public.livo_knowledge_work_commit(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.kb_work_identity(uuid,jsonb),public.livo_knowledge_work_snapshot(uuid,jsonb,text),public.livo_knowledge_work_commit(uuid,jsonb,jsonb) TO service_role;

-- Keep all existing approval/planning/TaskWork import guards. This outer guard
-- serializes against source-link creation before the first child deletion.
DO $$ BEGIN
 IF to_regprocedure('public.livo_jira_clear_tasks_before_knowledge()') IS NULL THEN
  ALTER FUNCTION public.livo_jira_clear_tasks() RENAME TO livo_jira_clear_tasks_before_knowledge;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.livo_jira_clear_tasks() RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM generation FROM public.kb_work_clock WHERE id=1 FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.kb_source_links WHERE source_kind IN('task','task_file','qa','qa_file')) THEN
  RAISE EXCEPTION 'knowledge_requires_server_restore' USING ERRCODE='23514';
 END IF;
 RETURN public.livo_jira_clear_tasks_before_knowledge();
END $$;
REVOKE ALL ON FUNCTION public.livo_jira_clear_tasks(),public.livo_jira_clear_tasks_before_knowledge() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_jira_clear_tasks(),public.livo_jira_clear_tasks_before_knowledge() TO service_role;
