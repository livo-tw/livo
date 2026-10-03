-- Private two-stage imports. No generic-client write access, and no Realtime publication.
CREATE TABLE IF NOT EXISTS public.knowledge_import_policy (
  id text PRIMARY KEY DEFAULT 'knowledge.import' CHECK(id='knowledge.import'),
  version integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.knowledge_import_jobs (
  id text PRIMARY KEY,
  actor_id text NOT NULL,
  version integer NOT NULL,
  data jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_import_jobs_actor ON public.knowledge_import_jobs(actor_id,created_at DESC);
CREATE TABLE IF NOT EXISTS public.knowledge_import_sources (
  id text PRIMARY KEY,
  page_id text NOT NULL REFERENCES public.kb_pages(id) ON DELETE CASCADE,
  snapshot_id text NOT NULL REFERENCES public.kb_source_snapshots(id) ON DELETE CASCADE,
  job_id text NOT NULL,
  item_id text NOT NULL,
  source_key text NOT NULL,
  source_hash text NOT NULL,
  version integer NOT NULL,
  original jsonb NOT NULL,
  assets jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,item_id)
);
CREATE INDEX IF NOT EXISTS knowledge_import_source_page ON public.knowledge_import_sources(page_id,source_key,version DESC);
ALTER TABLE public.knowledge_import_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_import_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.knowledge_import_policy,public.knowledge_import_jobs,public.knowledge_import_sources FROM anon,authenticated;
GRANT ALL ON public.knowledge_import_policy,public.knowledge_import_jobs,public.knowledge_import_sources TO service_role;
INSERT INTO storage.buckets(id,name,public,file_size_limit) VALUES('kb-imports','kb-imports',false,10485760)
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=10485760;
-- Existing permissive storage policies must not expose staging through the generic API.
DROP POLICY IF EXISTS knowledge_import_storage_floor ON storage.objects;
CREATE POLICY knowledge_import_storage_floor ON storage.objects AS RESTRICTIVE FOR ALL TO anon,authenticated
  USING(bucket_id!='kb-imports') WITH CHECK(bucket_id!='kb-imports');

CREATE OR REPLACE FUNCTION public.knowledge_import_can(actor_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(SELECT 1 FROM public.members m LEFT JOIN public.knowledge_import_policy p ON p.id='knowledge.import'
    WHERE m.id=actor_id AND m.is_active AND (
      (p.id IS NULL AND m.role::text='super_admin') OR
      p.data->'subjects'->'roles' ? m.role::text OR p.data->'subjects'->'positions' ? m.job_title OR p.data->'subjects'->'member_ids' ? m.id));
$$;
REVOKE ALL ON FUNCTION public.knowledge_import_can(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_import_can(text) TO service_role;

CREATE OR REPLACE FUNCTION public.knowledge_import_db(p_action text,p_actor text,p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor public.members%ROWTYPE; policy public.knowledge_import_policy%ROWTYPE; job public.knowledge_import_jobs%ROWTYPE;
  item jsonb; dest jsonb; source jsonb; previous public.knowledge_import_sources%ROWTYPE; page public.kb_pages%ROWTYPE;
  new_page text; snapshot text; digest text; source_version integer; result jsonb; expected integer; found_count integer;
BEGIN
  -- EXECUTE is granted exclusively to service_role below. The authenticated actor
  -- is resolved by the edge function, never accepted from the user's request body.
  SELECT * INTO actor FROM public.members WHERE id=p_actor AND is_active AND auth_id::text=p_payload->>'auth_id' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'import_forbidden' USING ERRCODE='42501'; END IF;
  -- Serialize capability changes against every import commit, including an absent default row.
  PERFORM pg_advisory_xact_lock(hashtext('knowledge.import.policy'));
  SELECT * INTO policy FROM public.knowledge_import_policy WHERE id='knowledge.import' FOR SHARE;
  PERFORM set_config('request.jwt.claim.sub',actor.auth_id::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor.auth_id,'role','authenticated')::text,true);
  IF p_action='actor' THEN RETURN to_jsonb(actor); END IF;
  IF p_action='policy' THEN RETURN coalesce(policy.data,jsonb_build_object('version',0,'subjects',jsonb_build_object('roles',jsonb_build_array('super_admin'),'positions','[]'::jsonb,'member_ids','[]'::jsonb),'notion_subjects',jsonb_build_object('roles',jsonb_build_array('super_admin'),'positions','[]'::jsonb,'member_ids','[]'::jsonb),'notion_pages','[]'::jsonb)); END IF;
  IF p_action='save_policy' THEN
    IF actor.role::text!='super_admin' OR coalesce(policy.version,0)!=(p_payload->>'expected')::integer THEN RAISE EXCEPTION 'policy_changed' USING ERRCODE='40001'; END IF;
    INSERT INTO public.knowledge_import_policy(id,version,data,updated_by) VALUES('knowledge.import',(p_payload->'policy'->>'version')::integer,p_payload->'policy',p_actor)
    ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,data=EXCLUDED.data,updated_by=EXCLUDED.updated_by,updated_at=now();
    RETURN 'true'::jsonb;
  END IF;
  IF p_action='pages' THEN RETURN coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM public.kb_pages p WHERE public.kb_has_permission(p.id,'view')),'[]'::jsonb); END IF;
  IF p_action='sources' THEN
    IF NOT public.kb_has_permission(p_payload->>'page_id','view') THEN RAISE EXCEPTION 'import_forbidden' USING ERRCODE='42501'; END IF;
    RETURN coalesce((SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('body',ss.body)) FROM public.knowledge_import_sources s JOIN public.kb_source_snapshots ss ON ss.id=s.snapshot_id WHERE s.page_id=p_payload->>'page_id'),'[]'::jsonb);
  END IF;
  IF NOT public.knowledge_import_can(p_actor) THEN RAISE EXCEPTION 'import_forbidden' USING ERRCODE='42501'; END IF;
  IF p_action='find_sources' THEN RETURN coalesce((SELECT jsonb_agg(to_jsonb(q)) FROM (SELECT s.* FROM public.knowledge_import_sources s JOIN public.kb_pages p ON p.id=s.page_id WHERE s.created_by=p_actor AND s.source_key IN (SELECT jsonb_array_elements_text(p_payload->'keys')) AND p.parent_id IS NOT DISTINCT FROM p_payload->>'parent' AND p.project_id IS NOT DISTINCT FROM p_payload->>'project' AND public.kb_has_permission(p.id,'view') LIMIT 30) q),'[]'::jsonb); END IF;
  IF p_action='results' THEN RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('item_id',item_id,'page_id',page_id,'snapshot_id',snapshot_id,'file_keys',jsonb_build_array(original->>'key')||coalesce((SELECT jsonb_agg(value->>'key') FROM jsonb_array_elements(assets)),'[]'::jsonb))) FROM public.knowledge_import_sources WHERE job_id=p_payload->>'job_id' AND created_by=p_actor),'[]'::jsonb); END IF;
  IF p_action='expired' THEN RETURN coalesce((SELECT jsonb_agg(data) FROM (SELECT data FROM public.knowledge_import_jobs WHERE actor_id=p_actor AND expires_at<=now() LIMIT 30) q),'[]'::jsonb); END IF;
  IF p_action='delete_expired' THEN DELETE FROM public.knowledge_import_jobs WHERE id=p_payload->>'job_id' AND actor_id=p_actor AND expires_at<=now(); RETURN 'true'::jsonb; END IF;
  IF p_action='list' THEN RETURN coalesce((SELECT jsonb_agg(data) FROM (SELECT data FROM public.knowledge_import_jobs WHERE actor_id=p_actor AND expires_at>now() ORDER BY created_at DESC LIMIT 30) q),'[]'::jsonb); END IF;
  IF p_action='get' THEN RETURN (SELECT data FROM public.knowledge_import_jobs WHERE id=p_payload->>'id' AND actor_id=p_actor); END IF;
  IF p_action='save_job' THEN
    IF p_payload->'job'->>'actor_id' IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'import_forbidden'; END IF;
    IF p_payload->>'expected' IS NULL THEN
      INSERT INTO public.knowledge_import_jobs(id,actor_id,version,data,expires_at) VALUES(p_payload->'job'->>'id',p_actor,(p_payload->'job'->>'version')::integer,p_payload->'job',(p_payload->'job'->>'expires_at')::timestamptz) ON CONFLICT DO NOTHING;
    ELSE
      UPDATE public.knowledge_import_jobs SET data=p_payload->'job',version=(p_payload->'job'->>'version')::integer WHERE id=p_payload->'job'->>'id' AND actor_id=p_actor AND version=(p_payload->>'expected')::integer AND expires_at>now();
    END IF;
    GET DIAGNOSTICS found_count=ROW_COUNT; RETURN to_jsonb(found_count=1);
  END IF;
  IF p_action!='commit' THEN RAISE EXCEPTION 'unknown_action'; END IF;
  SELECT * INTO job FROM public.knowledge_import_jobs WHERE id=p_payload->>'job_id' AND actor_id=p_actor AND expires_at>now() FOR UPDATE;
  IF NOT FOUND OR job.version!=(p_payload->>'job_version')::integer OR job.data->>'status'!='committing' OR (job.data->>'policy_version')::integer!=coalesce(policy.version,0) THEN RAISE EXCEPTION 'preview_changed' USING ERRCODE='40001'; END IF;
  SELECT value INTO item FROM jsonb_array_elements(job.data->'items') WHERE value->>'id'=p_payload->>'item_id';
  IF item IS NULL OR item->'parsed' IS NULL THEN RAISE EXCEPTION 'item_not_ready'; END IF;
  IF job.data->>'source'='notion' AND (policy.data->>'notion_secret' IS NULL OR NOT (policy.data->'notion_pages' ? replace(item->>'source_key','notion:','')) OR NOT (
    policy.data->'notion_subjects'->'roles' ? actor.role::text OR policy.data->'notion_subjects'->'positions' ? actor.job_title OR policy.data->'notion_subjects'->'member_ids' ? actor.id)) THEN RAISE EXCEPTION 'import_forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO previous FROM public.knowledge_import_sources WHERE job_id=job.id AND item_id=item->>'id';
  IF FOUND THEN
    IF NOT public.kb_has_permission(previous.page_id,'view') THEN RAISE EXCEPTION 'import_forbidden'; END IF;
    RETURN jsonb_build_object('page_id',previous.page_id,'snapshot_id',previous.snapshot_id);
  END IF;
  dest:=p_payload->'mapping'->'destination'; source:=p_payload->'source';
  IF p_payload->'mapping'->>'reviewed'!='true' OR p_payload->'mapping'->>'confirm_audience'!='true' OR
    (item->'parsed'->>'incomplete'='true' AND p_payload->'mapping'->>'allow_incomplete'!='true') THEN RAISE EXCEPTION 'review_required'; END IF;
  -- Lock the hierarchy and membership for the whole page+ACL+snapshot transaction.
  LOCK TABLE public.kb_pages IN SHARE ROW EXCLUSIVE MODE;
  IF dest->>'parent_id' IS NOT NULL AND NOT public.kb_has_permission(dest->>'parent_id','edit') THEN RAISE EXCEPTION 'import_forbidden' USING ERRCODE='42501'; END IF;
  IF dest->>'mode'='update' THEN
    SELECT * INTO page FROM public.kb_pages WHERE id=dest->>'target_id' FOR UPDATE;
    IF NOT FOUND OR NOT public.kb_has_permission(page.id,'edit') THEN RAISE EXCEPTION 'import_forbidden' USING ERRCODE='42501'; END IF;
    IF page.version!=(dest->>'expected_version')::integer THEN RAISE EXCEPTION 'destination_changed' USING ERRCODE='40001'; END IF;
    new_page:=page.id;
  ELSE
    IF NOT public.kb_policy_valid(dest->'policy') OR (dest->'policy'->>'mode'='custom' AND (actor.role::text NOT IN ('admin','super_admin') OR NOT (
      dest->'policy'->'view'->'roles' ? actor.role::text OR dest->'policy'->'view'->'positions' ? actor.job_title OR dest->'policy'->'view'->'member_ids' ? actor.id))) THEN RAISE EXCEPTION 'invalid_policy'; END IF;
    IF dest->>'mode'='create' AND EXISTS(SELECT 1 FROM public.knowledge_import_sources s JOIN public.kb_pages p ON p.id=s.page_id WHERE s.created_by=p_actor AND s.source_key=item->>'source_key' AND p.parent_id IS NOT DISTINCT FROM dest->>'parent_id' AND p.project_id IS NOT DISTINCT FROM dest->>'project_id' AND public.kb_has_permission(p.id,'view')) THEN RAISE EXCEPTION 'duplicate_source'; END IF;
    new_page:=source->>'page_id';
    INSERT INTO public.kb_pages(id,title,body,project_id,parent_id,category,access_policy,created_by,updated_by)
      VALUES(new_page,item->>'title',item->'parsed'->>'body',dest->>'project_id',dest->>'parent_id',dest->>'category',dest->'policy',p_actor,p_actor) RETURNING * INTO page;
  END IF;
  digest:=encode(sha256(convert_to(item->'parsed'->>'body','UTF8')),'hex'); snapshot:=source->>'snapshot_id';
  SELECT coalesce(max(s.version),0)+1 INTO source_version FROM public.knowledge_import_sources s WHERE s.page_id=new_page AND s.source_key=item->>'source_key';
  INSERT INTO public.kb_source_snapshots(id,workspace_id,page_id,source_kind,source_title,source_url,source_key,source_version,body,body_hash,page_version,provenance,created_by,created_at)
    VALUES(snapshot,'default',new_page,job.data->>'source',item->>'title',item->>'source_url',item->>'source_key',source_version::text,item->'parsed'->>'body',digest,page.version,
      jsonb_build_object('pages',item->'parsed'->'pages','warnings',item->'parsed'->'warnings','parser_version',item->'parsed'->'parser_version','incomplete',item->'parsed'->'incomplete','historical',true),p_actor,now()) ON CONFLICT DO NOTHING;
  SELECT ss.id INTO snapshot FROM public.kb_source_snapshots ss WHERE ss.page_id=new_page AND ss.body_hash=digest AND ss.source_kind=job.data->>'source' AND ss.source_key=item->>'source_key' LIMIT 1;
  INSERT INTO public.knowledge_import_sources(id,page_id,snapshot_id,job_id,item_id,source_key,source_hash,version,original,assets,created_by)
    VALUES(source->>'id',new_page,snapshot,job.id,item->>'id',item->>'source_key',item->>'source_hash',source_version,item->'original',item->'assets',p_actor);
  RETURN jsonb_build_object('page_id',new_page,'snapshot_id',snapshot);
END $$;
REVOKE ALL ON FUNCTION public.knowledge_import_db(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_import_db(text,text,jsonb) TO service_role;
