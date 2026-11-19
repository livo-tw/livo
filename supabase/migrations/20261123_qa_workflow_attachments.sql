-- Workflow evidence uses the same private staging as discussion attachments.
ALTER TABLE public.qa_attachments ADD COLUMN IF NOT EXISTS event_id text REFERENCES public.qa_events(id);
CREATE INDEX IF NOT EXISTS qa_attachments_event ON public.qa_attachments(event_id) WHERE event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.livo_qa_event_accepts_attachments(p_type text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT p_type IN ('submit_fix','record_deployment','record_verification','hold','reopen','close','request_handoff','resolve_handoff');
$$;
REVOKE ALL ON FUNCTION public.livo_qa_event_accepts_attachments(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_event_accepts_attachments(text) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_event_attachment_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.event_id IS NOT NULL AND (NEW.comment_id IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM public.qa_events e WHERE e.workspace_id=NEW.workspace_id AND e.id=NEW.event_id
      AND e.issue_id=NEW.issue_id AND e.actor_id=NEW.uploaded_by AND public.livo_qa_event_accepts_attachments(e.type)
  )) THEN
    RAISE EXCEPTION 'qa_invalid_event_attachments' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS livo_qa_event_attachment_scope ON public.qa_attachments;
CREATE TRIGGER livo_qa_event_attachment_scope BEFORE INSERT OR UPDATE OF event_id,comment_id,issue_id,uploaded_by,workspace_id
  ON public.qa_attachments FOR EACH ROW EXECUTE FUNCTION public.livo_qa_event_attachment_scope();
REVOKE ALL ON FUNCTION public.livo_qa_event_attachment_scope() FROM PUBLIC,anon,authenticated;

-- Revalidate the original reservation and storage object while publishing,
-- with the same scope and locks for discussion and workflow records.
CREATE OR REPLACE FUNCTION public.livo_qa_publish_staged_attachments(p_auth_id uuid,p_issue_id text,
  p_comment_id text,p_event_id text,p_created_at timestamptz,p_ids jsonb,p_identity jsonb DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,storage AS $$
DECLARE actor text; external_actor boolean; project text; file_id text;
  u public.qa_uploads%ROWTYPE; obj storage.objects%ROWTYPE; linked public.qa_attachments%ROWTYPE;
  invalid_files text:=CASE WHEN p_event_id IS NULL THEN 'qa_invalid_comment_attachments' ELSE 'qa_invalid_event_attachments' END;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  SELECT s.actor_id,s.is_external INTO actor,external_actor FROM public.livo_qa_scoped_actor(p_auth_id,p_identity) s;
  SELECT q.project_id INTO project FROM public.qa_issues q WHERE q.workspace_id='default' AND q.id=p_issue_id FOR SHARE;
  IF actor IS NULL OR project IS NULL THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
  IF external_actor THEN PERFORM public.livo_qa_lock_external_project(actor,project); END IF;
  IF (p_comment_id IS NULL)=(p_event_id IS NULL) OR jsonb_typeof(p_ids) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION '%',invalid_files USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_ids)>10
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_ids) i WHERE jsonb_typeof(i)<>'string'
      OR (i#>>'{}') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$')
    OR (SELECT count(*) FROM jsonb_array_elements(p_ids))<>(SELECT count(DISTINCT i) FROM jsonb_array_elements(p_ids) i) THEN
    RAISE EXCEPTION '%',invalid_files USING ERRCODE='22023';
  END IF;
  FOR file_id IN SELECT value FROM jsonb_array_elements_text(p_ids) ORDER BY value LOOP
    SELECT * INTO linked FROM public.qa_attachments a WHERE a.workspace_id='default' AND a.id=file_id;
    IF FOUND THEN
      IF linked.issue_id<>p_issue_id OR linked.uploaded_by<>actor OR linked.comment_id IS DISTINCT FROM p_comment_id
        OR linked.event_id IS DISTINCT FROM p_event_id THEN
        RAISE EXCEPTION '%',invalid_files USING ERRCODE='22023';
      END IF;
      CONTINUE;
    END IF;
    SELECT * INTO u FROM public.qa_uploads WHERE workspace_id='default' AND id=file_id FOR UPDATE;
    IF NOT FOUND OR u.issue_id<>p_issue_id OR u.actor_id<>actor OR u.purpose<>'comment'
      OR u.completed_at IS NOT NULL OR u.expires_at<=clock_timestamp() OR u.cleanup_token IS NOT NULL THEN
      RAISE EXCEPTION '%',invalid_files USING ERRCODE='22023';
    END IF;
    SELECT * INTO obj FROM storage.objects WHERE bucket_id='qa-evidence' AND name=u.storage_path FOR SHARE;
    IF NOT FOUND OR COALESCE((obj.metadata->>'size')::bigint,-1)<>u.size OR lower(COALESCE(obj.metadata->>'mimetype',''))<>u.mime_type THEN
      RAISE EXCEPTION 'qa_upload_incomplete' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.qa_attachments(id,issue_id,uploaded_by,file_name,mime_type,size,storage_path,created_at,comment_id,event_id)
      VALUES(u.id,p_issue_id,actor,u.file_name,u.mime_type,u.size,u.storage_path,p_created_at,p_comment_id,p_event_id);
    UPDATE public.qa_uploads SET completed_at=clock_timestamp() WHERE workspace_id='default' AND id=u.id;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_publish_staged_attachments(uuid,text,text,text,timestamptz,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_publish_staged_attachments(uuid,text,text,text,timestamptz,jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_publish_comment_attachments(p_auth_id uuid,p_issue_id text,p_comment jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE actor text; ids jsonb:=COALESCE(p_comment->'attachmentIds','[]'::jsonb);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  SELECT s.actor_id INTO actor FROM public.livo_qa_scoped_actor(p_auth_id) s;
  IF actor IS NULL THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(ids)<>'array' OR jsonb_typeof(p_comment->'body') IS DISTINCT FROM 'string'
    OR length(p_comment->>'body')>20000 OR NOT EXISTS(
      SELECT 1 FROM public.qa_comments c WHERE c.workspace_id='default' AND c.id=p_comment->>'id'
        AND c.issue_id=p_issue_id AND c.actor_id=actor AND c.body=p_comment->>'body'
    ) THEN
    RAISE EXCEPTION 'qa_invalid_comment_attachments' USING ERRCODE='22023';
  END IF;
  IF btrim(p_comment->>'body')='' AND jsonb_array_length(ids)=0 THEN
    RAISE EXCEPTION 'qa_invalid_comment_attachments' USING ERRCODE='22023';
  END IF;
  PERFORM public.livo_qa_publish_staged_attachments(p_auth_id,p_issue_id,p_comment->>'id',NULL,
    (p_comment->>'createdAt')::timestamptz,ids);
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_publish_comment_attachments(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_publish_comment_attachments(uuid,text,jsonb) TO service_role;

-- Keep the established command entry point. The base routine rechecks permissions
-- even on replay and creates the receipt, event and issue revision in this transaction.
CREATE OR REPLACE FUNCTION public.livo_qa_commit(p_auth_id uuid,p_issue_id text,p_command_id text,
  p_payload_hash text,p_expected_version integer,p_kind text,p_data jsonb,p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE previous_guard text:=current_setting('livo.qa_assignment_enforce',true); result jsonb;
  has_files boolean:=p_event ? 'attachmentIds'; repeated boolean:=false;
BEGIN
  PERFORM set_config('livo.qa_assignment_enforce','true',true);
  IF has_files THEN
    IF p_kind<>'command' OR NOT COALESCE(public.livo_qa_event_accepts_attachments(p_event->>'type'),false) THEN
      RAISE EXCEPTION 'qa_invalid_event_attachments' USING ERRCODE='22023';
    END IF;
    -- Match the base lock order to distinguish a replay from a new command.
    PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
    PERFORM pg_advisory_xact_lock(hashtext('livo-qa-command:'||p_command_id));
    SELECT EXISTS(SELECT 1 FROM public.qa_commands WHERE workspace_id='default' AND id=p_command_id) INTO repeated;
  END IF;
  result:=public.livo_qa_commit_assignment_base(p_auth_id,p_issue_id,p_command_id,
    p_payload_hash,p_expected_version,p_kind,p_data,p_event);
  IF p_kind='comment' THEN
    PERFORM public.livo_qa_publish_comment_attachments(p_auth_id,p_issue_id,result);
  ELSIF has_files AND NOT repeated THEN
    PERFORM public.livo_qa_publish_staged_attachments(p_auth_id,p_issue_id,NULL,p_event->>'id',
      (p_data->>'updatedAt')::timestamptz,p_event->'attachmentIds',p_event->'slackIdentity');
  END IF;
  PERFORM set_config('livo.qa_assignment_enforce',COALESCE(previous_guard,'false'),true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('livo.qa_assignment_enforce',COALESCE(previous_guard,'false'),true);
  RAISE;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) TO service_role;

-- Extend only whitelisted metadata and validate references before restore writes.
DO $patch$
DECLARE definition text;
  old_read text:=$old$'createdAt',a.created_at,'commentId',a.comment_id)$old$;
  new_read text:=$new$'createdAt',a.created_at,'commentId',a.comment_id,'eventId',a.event_id)$new$;
  old_restore text:='  -- Row casts validate SQL types even in validate-only mode, before any writes.';
  new_restore text:=$new$  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_tables->'qa_attachments') a WHERE a->>'event_id' IS NOT NULL
    AND (a->>'comment_id' IS NOT NULL OR NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(p_tables->'qa_events') e WHERE e->>'id'=a->>'event_id'
          AND e->>'issue_id'=a->>'issue_id' AND e->>'actor_id'=a->>'uploaded_by'
          AND public.livo_qa_event_accepts_attachments(e->>'type')
      ) AND NOT EXISTS(
        SELECT 1 FROM public.qa_events e WHERE e.workspace_id='default' AND e.id=a->>'event_id'
          AND e.issue_id=a->>'issue_id' AND e.actor_id=a->>'uploaded_by'
          AND public.livo_qa_event_accepts_attachments(e.type)
      ))) THEN
    RAISE EXCEPTION 'invalid_issue: event_attachment' USING ERRCODE='22023';
  END IF;

$new$;
BEGIN
  SELECT pg_get_functiondef('public.livo_qa_external_read(uuid,text,jsonb)'::regprocedure) INTO definition;
  IF position(new_read IN definition)=0 THEN
    IF (length(definition)-length(replace(definition,old_read,'')))/length(old_read)<>1 THEN
      RAISE EXCEPTION 'qa_external_read_event_patch_unrecognized';
    END IF;
    EXECUTE replace(definition,old_read,new_read);
  END IF;
  SELECT pg_get_functiondef('public.livo_qa_restore(uuid,jsonb,boolean)'::regprocedure) INTO definition;
  IF position(new_restore IN definition)=0 THEN
    IF (length(definition)-length(replace(definition,old_restore,'')))/length(old_restore)<>1 THEN
      RAISE EXCEPTION 'qa_restore_event_patch_unrecognized';
    END IF;
    EXECUTE replace(definition,old_restore,new_restore||old_restore);
  END IF;
END;
$patch$;

NOTIFY pgrst, 'reload schema';
