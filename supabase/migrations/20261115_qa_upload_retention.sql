-- Expired QA uploads retain a fence while storage deletion is retried.
-- Committed attachments and active upload reservations are never cleanup targets.
ALTER TABLE public.qa_uploads ADD COLUMN IF NOT EXISTS cleanup_token text;
ALTER TABLE public.qa_uploads ADD COLUMN IF NOT EXISTS cleanup_lease_until timestamptz;
ALTER TABLE public.qa_uploads ADD COLUMN IF NOT EXISTS cleanup_last_attempt_at timestamptz;
ALTER TABLE public.qa_uploads ADD COLUMN IF NOT EXISTS cleanup_completed_at timestamptz;
CREATE INDEX IF NOT EXISTS qa_uploads_retention ON public.qa_uploads(expires_at,cleanup_last_attempt_at)
  WHERE completed_at IS NULL;

CREATE OR REPLACE FUNCTION public.livo_qa_upload_cleanup(p_action text,p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  upload public.qa_uploads%ROWTYPE;
  claimed jsonb := '[]'::jsonb;
  batch_limit integer := LEAST(25,GREATEST(1,COALESCE((p_payload->>'limit')::integer,25)));
BEGIN
  -- Share the short database fence with finalize, delete and restore. Object I/O
  -- happens after this transaction, protected by each reservation's tombstone.
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF p_action='claim' THEN
    FOR upload IN SELECT u.* FROM public.qa_uploads u
      WHERE u.workspace_id='default' AND u.completed_at IS NULL
        AND u.expires_at<=clock_timestamp()-interval '5 minutes'
        AND (u.cleanup_lease_until IS NULL OR u.cleanup_lease_until<=clock_timestamp())
        AND (u.cleanup_last_attempt_at IS NULL OR u.cleanup_last_attempt_at<=clock_timestamp()-interval '1 hour')
        AND NOT EXISTS(SELECT 1 FROM public.qa_attachments a WHERE a.workspace_id=u.workspace_id
          AND (a.id=u.id OR a.storage_path=u.storage_path))
      ORDER BY u.cleanup_last_attempt_at NULLS FIRST,u.expires_at,u.id LIMIT batch_limit
      FOR UPDATE OF u SKIP LOCKED
    LOOP
      UPDATE public.qa_uploads u SET cleanup_token=gen_random_uuid()::text,
        cleanup_lease_until=clock_timestamp()+interval '5 minutes',cleanup_last_attempt_at=clock_timestamp()
        WHERE u.id=upload.id AND u.workspace_id='default' RETURNING * INTO upload;
      claimed:=claimed||jsonb_build_array(jsonb_build_object('id',upload.id,'workspaceId',upload.workspace_id,
        'issueId',upload.issue_id,'storageKey',upload.storage_path,'token',upload.cleanup_token));
    END LOOP;
    RETURN claimed;
  END IF;
  IF p_action NOT IN ('owns','referenced','finish') THEN
    RAISE EXCEPTION 'qa_cleanup_invalid_action' USING ERRCODE='22023';
  END IF;
  SELECT * INTO upload FROM public.qa_uploads u
    WHERE u.id=p_payload->>'id' AND u.workspace_id='default' FOR UPDATE;
  IF p_action='referenced' THEN
    RETURN to_jsonb(NOT FOUND OR EXISTS(SELECT 1 FROM public.qa_attachments a
      WHERE a.workspace_id='default' AND (a.id=upload.id OR a.storage_path=upload.storage_path)));
  END IF;
  IF NOT FOUND OR upload.completed_at IS NOT NULL OR upload.cleanup_token IS DISTINCT FROM p_payload->>'token'
    OR upload.cleanup_lease_until<=clock_timestamp() OR upload.cleanup_lease_until IS NULL
    OR EXISTS(SELECT 1 FROM public.qa_attachments a WHERE a.workspace_id='default'
      AND (a.id=upload.id OR a.storage_path=upload.storage_path)) THEN RETURN 'false'::jsonb; END IF;
  IF p_action='owns' THEN RETURN 'true'::jsonb; END IF;
  IF EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='qa-evidence' AND o.name=upload.storage_path)
    THEN RETURN 'false'::jsonb; END IF;
  IF upload.cleanup_completed_at IS NOT NULL AND upload.cleanup_completed_at<=clock_timestamp()-interval '24 hours' THEN
    DELETE FROM public.qa_uploads WHERE workspace_id='default' AND id=upload.id AND cleanup_token=upload.cleanup_token;
  ELSE
    UPDATE public.qa_uploads SET cleanup_completed_at=COALESCE(cleanup_completed_at,clock_timestamp()),cleanup_lease_until=NULL
      WHERE workspace_id='default' AND id=upload.id AND cleanup_token=upload.cleanup_token;
  END IF;
  RETURN 'true'::jsonb;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_upload_cleanup(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_upload_cleanup(text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_attachment_retention_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF EXISTS(SELECT 1 FROM public.qa_uploads u WHERE u.workspace_id=NEW.workspace_id
    AND (u.id=NEW.id OR u.storage_path=NEW.storage_path) AND u.cleanup_token IS NOT NULL) THEN
    RAISE EXCEPTION 'qa_upload_cleanup_in_progress' USING ERRCODE='PT409';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_attachment_retention_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_qa_attachment_retention_guard ON public.qa_attachments;
CREATE TRIGGER livo_qa_attachment_retention_guard BEFORE INSERT OR UPDATE OF id,storage_path ON public.qa_attachments
  FOR EACH ROW EXECUTE FUNCTION public.livo_qa_attachment_retention_guard();

CREATE OR REPLACE FUNCTION public.livo_guard_qa_object()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,storage AS $$
BEGIN
  IF NEW.bucket_id='qa-evidence' THEN
    IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['last_accessed_at','updated_at'])=
      (to_jsonb(OLD)-ARRAY['last_accessed_at','updated_at']) THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
    IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_upload_unavailable' USING ERRCODE='42501'; END IF;
    PERFORM 1 FROM public.qa_uploads u JOIN public.qa_issues q ON q.id=u.issue_id AND q.workspace_id=u.workspace_id
      WHERE u.storage_path=NEW.name AND u.workspace_id='default' AND u.completed_at IS NULL
        AND u.expires_at>clock_timestamp() AND u.cleanup_token IS NULL
        AND public.livo_qa_person_available(q.project_id,u.actor_id) FOR SHARE OF u;
    IF NOT FOUND THEN RAISE EXCEPTION 'qa_upload_unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

SELECT public.livo_apply_active_member_gate();
