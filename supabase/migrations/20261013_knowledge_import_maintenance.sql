-- Privileged, actor-independent retention. This migration installs maintenance
-- functions only; it does not delete or rewrite any existing document data.
CREATE INDEX IF NOT EXISTS knowledge_import_jobs_expiry ON public.knowledge_import_jobs(expires_at,id);
CREATE INDEX IF NOT EXISTS knowledge_import_orphan_inventory ON storage.objects(bucket_id,created_at,id);

-- Metadata-only cursor. Skipped/referenced objects still advance the scan, so a
-- prefix full of retained files cannot starve later abandoned staging objects.
CREATE TABLE IF NOT EXISTS public.knowledge_import_cleanup_cursors (
  id text PRIMARY KEY,after_created_at timestamptz,after_id uuid,updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.knowledge_import_cleanup_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.knowledge_import_cleanup_cursors FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.knowledge_import_orphan_allowed(p_object_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(SELECT 1 FROM storage.objects o WHERE o.id=p_object_id AND o.bucket_id='kb-imports'
    AND o.created_at<now()-interval '24 hours' AND o.updated_at<now()-interval '24 hours'
    AND o.name ~ '^[-A-Za-z0-9_.]{1,100}/[-A-Za-z0-9_.]{1,100}/[^/]+(/[^/]+)*$'
    AND o.name !~ '(^|/)\.{1,2}(/|$)' AND o.name !~ '[[:cntrl:]]' AND strpos(o.name,chr(92))=0
    AND NOT EXISTS(SELECT 1 FROM public.knowledge_import_jobs j WHERE j.id=split_part(o.name,'/',2))
    AND NOT EXISTS(SELECT 1 FROM public.knowledge_import_sources s WHERE s.original->>'key'=o.name
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(s.assets) asset WHERE asset->>'key'=o.name)))
$$;
REVOKE ALL ON FUNCTION public.knowledge_import_orphan_allowed(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_import_orphan_allowed(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.knowledge_import_cleanup(p_action text,p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE job public.knowledge_import_jobs%ROWTYPE; result jsonb:='[]'::jsonb;
  scan_cursor public.knowledge_import_cleanup_cursors%ROWTYPE; storage_object storage.objects%ROWTYPE; scanned integer:=0;
  token text:=p_payload->>'token'; limit_count integer:=least(20,greatest(1,coalesce((p_payload->>'limit')::integer,20)));
  lease_until timestamptz:=now()+interval '10 minutes'; count_changed integer;
BEGIN
  -- EXECUTE is granted only to service_role. No user/actor or page ACL is needed
  -- to remove expired private staging, including jobs of deleted accounts.
  IF p_action='orphan_scan' THEN
    INSERT INTO public.knowledge_import_cleanup_cursors(id) VALUES('storage-orphans') ON CONFLICT DO NOTHING;
    SELECT * INTO scan_cursor FROM public.knowledge_import_cleanup_cursors WHERE id='storage-orphans' FOR UPDATE;
    FOR storage_object IN SELECT * FROM storage.objects o
      WHERE o.bucket_id='kb-imports' AND o.created_at<now()-interval '24 hours'
        AND (scan_cursor.after_created_at IS NULL OR (o.created_at,o.id)>(scan_cursor.after_created_at,scan_cursor.after_id))
      ORDER BY o.created_at,o.id LIMIT 100
    LOOP
      scanned:=scanned+1;
      scan_cursor.after_created_at:=storage_object.created_at;scan_cursor.after_id:=storage_object.id;
      IF public.knowledge_import_orphan_allowed(storage_object.id) THEN
        result:=result||jsonb_build_array(jsonb_build_object('id',storage_object.id,'bucket_id',storage_object.bucket_id,
          'key',storage_object.name,'created_at',storage_object.created_at,'updated_at',storage_object.updated_at));
      END IF;
    END LOOP;
    UPDATE public.knowledge_import_cleanup_cursors SET after_created_at=CASE WHEN scanned=100 THEN scan_cursor.after_created_at END,
      after_id=CASE WHEN scanned=100 THEN scan_cursor.after_id END,updated_at=now() WHERE id='storage-orphans';
    RETURN jsonb_build_object('objects',result,'visited',scanned,'done',scanned<100);
  END IF;
  IF p_action='orphan_check' THEN
    -- Immediately before storage deletion, recheck identity, age, job existence
    -- and every durable source reference. Never act on a stale inventory entry.
    RETURN to_jsonb(EXISTS(SELECT 1 FROM storage.objects o WHERE o.id=(p_payload->>'id')::uuid
      AND o.bucket_id=p_payload->>'bucket_id' AND o.name=p_payload->>'key'
      AND o.created_at=(p_payload->>'created_at')::timestamptz AND o.updated_at=(p_payload->>'updated_at')::timestamptz
      AND public.knowledge_import_orphan_allowed(o.id)));
  END IF;
  IF p_action='claim' THEN
    IF token IS NULL OR length(token)>80 OR length(token)<1 THEN RAISE EXCEPTION 'invalid_cleanup_token'; END IF;
    FOR job IN SELECT * FROM public.knowledge_import_jobs j
      WHERE j.expires_at<=now()
        AND coalesce((j.data->>'cleanup_lease_until')::timestamptz,'-infinity')<=now()
        AND coalesce((j.data->>'cleanup_after')::timestamptz,'-infinity')<=now()
      ORDER BY coalesce((j.data->>'cleanup_last_attempt')::timestamptz,'-infinity'),j.expires_at,j.id LIMIT limit_count FOR UPDATE SKIP LOCKED
    LOOP
      -- The row lock waits for any in-flight commit, then the version fence
      -- prevents a preview/parse that started earlier from committing afterwards.
      UPDATE public.knowledge_import_jobs SET version=version+1,
        data=data||jsonb_build_object('version',version+1,'cleanup_token',token,'cleanup_lease_until',lease_until,'cleanup_last_attempt',now())
        WHERE id=job.id;
      result:=result||jsonb_build_array(jsonb_build_object('id',job.id,'workspace_id','default','actor_id',job.actor_id,'lease_token',token));
    END LOOP;
    RETURN result;
  END IF;
  SELECT * INTO job FROM public.knowledge_import_jobs j WHERE j.id=p_payload->>'job_id'
    AND j.expires_at<=now() AND j.data->>'cleanup_token'=token
    AND (j.data->>'cleanup_lease_until')::timestamptz>now() FOR UPDATE;
  IF p_action='owns' THEN RETURN to_jsonb(FOUND); END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'cleanup_lease_lost' USING ERRCODE='40001'; END IF;
  IF p_action='retained' THEN
    IF jsonb_typeof(p_payload->'keys') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload->'keys')>1000 THEN
      RAISE EXCEPTION 'cleanup_object_limit';
    END IF;
    -- Sources outlive jobs and creator accounts. Protect every exact reference,
    -- even if that source belongs to another creator or a now-private page.
    RETURN coalesce((SELECT jsonb_agg(DISTINCT key) FROM (
      SELECT original->>'key' AS key FROM public.knowledge_import_sources
      UNION ALL SELECT asset->>'key' FROM public.knowledge_import_sources s CROSS JOIN LATERAL jsonb_array_elements(s.assets) asset
    ) refs WHERE key IN (SELECT jsonb_array_elements_text(p_payload->'keys'))),'[]'::jsonb);
  END IF;
  IF p_action='finish' THEN
    IF job.data->>'cleanup_completed_at' IS NOT NULL AND
       (job.data->>'cleanup_completed_at')::timestamptz<=now()-interval '15 minutes' THEN
      DELETE FROM public.knowledge_import_jobs WHERE id=job.id AND data->>'cleanup_token'=token;
    ELSE
      -- Retain only a content-free tombstone for a second scheduled prefix sweep.
      -- This catches an object write that was in flight during the first sweep.
      UPDATE public.knowledge_import_jobs SET version=version+1,data=jsonb_build_object(
        'id',id,'actor_id',actor_id,'source',data->>'source','status','cancelled','version',version+1,
        'policy_version',0,'created_at',created_at,'expires_at',expires_at,'initial_parent',NULL,
        'items','[]'::jsonb,'staged_keys','[]'::jsonb,'cleanup_completed_at',now(),'cleanup_after',now()+interval '15 minutes','cleanup_last_attempt',now())
        WHERE id=job.id AND data->>'cleanup_token'=token;
    END IF;
    GET DIAGNOSTICS count_changed=ROW_COUNT; RETURN to_jsonb(count_changed=1);
  END IF;
  RAISE EXCEPTION 'unknown_cleanup_action';
END $$;
REVOKE ALL ON FUNCTION public.knowledge_import_cleanup(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.knowledge_import_cleanup(text,jsonb) TO service_role;

-- New immutable snapshots store page provenance, not another copy of full OCR
-- text. The exact converted body still lives in kb_source_snapshots.body and the
-- staged parser payload remains available for retry until its retention expiry.
CREATE OR REPLACE FUNCTION public.knowledge_import_compact_provenance() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.source_kind IN ('notion','docx','md','pdf') AND jsonb_typeof(NEW.provenance->'pages')='array' THEN
    NEW.provenance:=jsonb_set(NEW.provenance,'{pages}',coalesce((SELECT jsonb_agg(jsonb_strip_nulls(
      jsonb_build_object('page',p->'page','state',p->'state','confidence',p->'confidence')))
      FROM jsonb_array_elements(NEW.provenance->'pages') p),'[]'::jsonb));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS knowledge_import_compact_provenance ON public.kb_source_snapshots;
CREATE TRIGGER knowledge_import_compact_provenance BEFORE INSERT ON public.kb_source_snapshots
FOR EACH ROW EXECUTE FUNCTION public.knowledge_import_compact_provenance();
