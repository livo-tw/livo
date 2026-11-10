-- Private ordinary-task comment attachments; existing comments and public legacy URLs remain intact.
CREATE TABLE IF NOT EXISTS public.task_comment_uploads (
 workspace_id text NOT NULL DEFAULT 'default', id text PRIMARY KEY, task_id text NOT NULL, actor_id text NOT NULL,
 file_name text NOT NULL, mime_type text NOT NULL, expected_size bigint NOT NULL CHECK(expected_size>0 AND expected_size<=209715200),
 storage_key text NOT NULL UNIQUE, state text NOT NULL DEFAULT 'uploading',
 comment_id text REFERENCES public.comments(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', cleanup_token text, cleanup_last_attempt_at timestamptz,
 CHECK(state IN ('uploading','complete','bound','cleaning','aborted'))
);
CREATE INDEX IF NOT EXISTS task_comment_upload_scope ON public.task_comment_uploads(workspace_id,task_id,comment_id);
CREATE INDEX IF NOT EXISTS task_comment_upload_expiry ON public.task_comment_uploads(workspace_id,expires_at);
CREATE TABLE IF NOT EXISTS public.task_comment_commands (
 workspace_id text NOT NULL DEFAULT 'default', id text PRIMARY KEY, task_id text NOT NULL, actor_id text NOT NULL,
 payload_hash text NOT NULL, payload jsonb NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.task_comment_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_comment_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.task_comment_uploads,public.task_comment_commands FROM anon,authenticated;
GRANT ALL ON public.task_comment_uploads,public.task_comment_commands TO service_role;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('task-comment-media','task-comment-media',false,209715200,ARRAY['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm','application/pdf','text/plain','text/csv','application/json'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=EXCLUDED.file_size_limit,allowed_mime_types=EXCLUDED.allowed_mime_types;
DROP POLICY IF EXISTS task_comment_storage_private ON storage.objects;
CREATE POLICY task_comment_storage_private ON storage.objects AS RESTRICTIVE FOR ALL TO anon,authenticated
 USING(bucket_id<>'task-comment-media') WITH CHECK(bucket_id<>'task-comment-media');

CREATE OR REPLACE FUNCTION public.livo_task_comment_actor() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE actor text;
BEGIN
 SELECT id INTO actor FROM public.members WHERE auth_id=auth.uid() AND is_active=true;
 IF actor IS NULL THEN RAISE EXCEPTION 'task_comment_forbidden' USING ERRCODE='42501'; END IF;
 RETURN actor;
END;$$;

CREATE OR REPLACE FUNCTION public.livo_task_comment_upload_init(p_task text,p_id text,p_name text,p_mime text,p_size bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor text:=public.livo_task_comment_actor(); u public.task_comment_uploads%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tasks WHERE id=p_task) THEN RAISE EXCEPTION 'task_unavailable' USING ERRCODE='42501'; END IF;
 IF p_id IS NULL OR p_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR length(p_name)>180 OR btrim(p_name)='' OR p_name~E'[\\\\/\\r\\n]' OR p_size<1 OR p_size>209715200
 OR p_mime NOT IN('image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm','application/pdf','text/plain','text/csv','application/json')
 THEN RAISE EXCEPTION 'invalid_file' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('task-comment-upload:'||p_id));
 SELECT * INTO u FROM public.task_comment_uploads WHERE workspace_id='default' AND id=p_id FOR UPDATE;
 IF FOUND THEN
  IF u.actor_id<>actor OR u.task_id<>p_task OR u.file_name<>p_name OR u.mime_type<>p_mime OR u.expected_size<>p_size
  THEN RAISE EXCEPTION 'upload_id_reused' USING ERRCODE='PT409'; END IF;
  IF u.state IN('cleaning','aborted') OR (u.comment_id IS NULL AND u.expires_at<=now()) THEN RAISE EXCEPTION 'upload_expired' USING ERRCODE='PT409'; END IF;
 ELSE
  INSERT INTO public.task_comment_uploads(id,task_id,actor_id,file_name,mime_type,expected_size,storage_key)
  VALUES(p_id,p_task,actor,p_name,p_mime,p_size,'default/'||p_task||'/'||p_id) RETURNING * INTO u;
 END IF;
 RETURN to_jsonb(u);
END;$$;

CREATE OR REPLACE FUNCTION public.livo_task_comment_upload_complete(p_id text,p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor text:=p_actor; u public.task_comment_uploads%ROWTYPE; object storage.objects%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.members WHERE id=actor AND is_active=true) THEN RAISE EXCEPTION 'task_comment_forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO u FROM public.task_comment_uploads WHERE workspace_id='default' AND id=p_id AND actor_id=actor FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.tasks WHERE id=u.task_id) THEN RAISE EXCEPTION 'upload_unavailable' USING ERRCODE='42501'; END IF;
 IF u.state IN('bound','complete') THEN RETURN to_jsonb(u); END IF;
 IF u.state<>'uploading' OR u.expires_at<=now() THEN RAISE EXCEPTION 'upload_expired' USING ERRCODE='PT409'; END IF;
 SELECT * INTO object FROM storage.objects WHERE bucket_id='task-comment-media' AND name=u.storage_key FOR SHARE;
 IF NOT FOUND OR NOT coalesce((object.metadata->>'size')::bigint=u.expected_size AND object.metadata->>'mimetype'=u.mime_type,false)
 THEN RAISE EXCEPTION 'upload_incomplete' USING ERRCODE='PT409'; END IF;
 UPDATE public.task_comment_uploads SET state='complete' WHERE id=u.id RETURNING * INTO u;
 RETURN to_jsonb(u);
END;$$;

CREATE OR REPLACE FUNCTION public.livo_task_comment_publish(p_task text,p_id text,p_body text,p_uploads text[],p_mentions text[],p_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor text:=public.livo_task_comment_actor(); prior public.task_comment_commands%ROWTYPE;
 t public.tasks%ROWTYPE; c public.comments%ROWTYPE; result jsonb; person text; plain text;
 input_payload jsonb:=jsonb_build_object('task',p_task,'body',p_body,'uploads',p_uploads,'mentions',p_mentions);
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('task-comment-command:'||p_id));
 SELECT * INTO t FROM public.tasks WHERE id=p_task FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'task_unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO prior FROM public.task_comment_commands WHERE workspace_id='default' AND id=p_id;
 IF FOUND THEN
  IF prior.actor_id<>actor OR prior.task_id<>p_task OR prior.payload_hash<>p_hash OR prior.payload IS DISTINCT FROM input_payload THEN RAISE EXCEPTION 'command_id_reused' USING ERRCODE='PT409'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.comments WHERE id=p_id AND task_id=p_task) THEN RAISE EXCEPTION 'comment_unavailable' USING ERRCODE='42501'; END IF;
  RETURN prior.result;
 END IF;
 IF p_id IS NULL OR p_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR p_body IS NULL OR p_uploads IS NULL OR p_mentions IS NULL OR p_hash IS NULL OR length(p_body)>20000 OR cardinality(p_uploads)>10 OR cardinality(p_mentions)>100
 OR cardinality(p_uploads)<>(SELECT count(DISTINCT x) FROM unnest(p_uploads)x)
 OR (btrim(regexp_replace(p_body,'<[^>]*>','','g'))='' AND cardinality(p_uploads)=0)
 THEN RAISE EXCEPTION 'invalid_comment' USING ERRCODE='22023'; END IF;
 PERFORM id FROM public.task_comment_uploads WHERE id=ANY(p_uploads) ORDER BY id FOR UPDATE;
 IF (SELECT count(*) FROM public.task_comment_uploads WHERE workspace_id='default' AND id=ANY(p_uploads)
  AND task_id=p_task AND actor_id=actor AND state='complete' AND comment_id IS NULL AND expires_at>now())<>cardinality(p_uploads)
 THEN RAISE EXCEPTION 'invalid_upload' USING ERRCODE='42501'; END IF;
 INSERT INTO public.comments(id,task_id,user_id,content) VALUES(p_id,p_task,actor,p_body) RETURNING * INTO c;
 UPDATE public.task_comment_uploads SET comment_id=p_id,state='bound' WHERE workspace_id='default' AND id=ANY(p_uploads);
 UPDATE public.tasks SET comment_count=(SELECT count(*) FROM public.comments WHERE task_id=p_task) WHERE id=p_task;
 plain:=left(regexp_replace(p_body,'<[^>]*>','','g'),100);
 FOR person IN SELECT DISTINCT x FROM unnest(p_mentions||ARRAY[t.assignee_id,t.reviewer_id])x
 WHERE x IS NOT NULL AND x<>actor AND EXISTS(SELECT 1 FROM public.members m WHERE m.id=x AND m.is_active=true) LOOP
  INSERT INTO public.notifications(recipient_id,sender_id,type,task_id,content)
  VALUES(person,actor,CASE WHEN person=ANY(p_mentions) THEN 'mention' ELSE 'comment' END,p_task,plain);
 END LOOP;
 result:=jsonb_build_object('comment',to_jsonb(c),'commentCount',(SELECT comment_count FROM public.tasks WHERE id=p_task));
 INSERT INTO public.task_comment_commands(id,task_id,actor_id,payload_hash,payload,result) VALUES(p_id,p_task,actor,p_hash,input_payload,result);
 RETURN result;
END;$$;

-- A claimed object cannot subsequently be bound by publish. Retain the cleanup handle until storage ACK.
CREATE OR REPLACE FUNCTION public.livo_task_comment_cleanup_claim(p_token text,p_limit integer DEFAULT 4) RETURNS SETOF public.task_comment_uploads
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 UPDATE public.task_comment_uploads SET state='cleaning',cleanup_token=p_token,cleanup_last_attempt_at=now()
 WHERE id IN(SELECT id FROM public.task_comment_uploads WHERE workspace_id='default' AND comment_id IS NULL
 AND expires_at<=now() AND (state<>'aborted' OR cleanup_last_attempt_at IS NULL OR cleanup_last_attempt_at<=now()-interval '5 minutes') AND (cleanup_token IS NULL OR cleanup_last_attempt_at<=now()-interval '2 minutes') ORDER BY coalesce(cleanup_last_attempt_at,'epoch'::timestamptz),expires_at LIMIT greatest(0,least(coalesce(p_limit,4),25)) FOR UPDATE SKIP LOCKED)
 RETURNING *;
$$;
CREATE OR REPLACE FUNCTION public.livo_task_comment_cleanup_ack(p_id text,p_token text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 WITH finished AS (UPDATE public.task_comment_uploads SET state='aborted' WHERE workspace_id='default' AND id=p_id
 AND state='cleaning' AND cleanup_token=p_token AND comment_id IS NULL
 AND NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='task-comment-media' AND o.name=task_comment_uploads.storage_key) RETURNING id) SELECT EXISTS(SELECT 1 FROM finished);
$$;
CREATE OR REPLACE FUNCTION public.livo_task_comment_cleanup_owns(p_id text,p_token text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.task_comment_uploads WHERE workspace_id='default' AND id=p_id
 AND state='cleaning' AND cleanup_token=p_token AND comment_id IS NULL AND expires_at<=now());
$$;
REVOKE ALL ON FUNCTION public.livo_task_comment_cleanup_owns(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_task_comment_cleanup_owns(text,text) TO service_role;
REVOKE ALL ON FUNCTION public.livo_task_comment_actor() FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.livo_task_comment_upload_init(text,text,text,text,bigint) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.livo_task_comment_upload_complete(text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.livo_task_comment_publish(text,text,text,text[],text[],text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.livo_task_comment_actor(),public.livo_task_comment_upload_init(text,text,text,text,bigint),
 public.livo_task_comment_publish(text,text,text,text[],text[],text) TO authenticated;
REVOKE ALL ON FUNCTION public.livo_task_comment_upload_complete(text,text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.livo_task_comment_upload_complete(text,text) TO service_role;
REVOKE ALL ON FUNCTION public.livo_task_comment_cleanup_claim(text,integer),public.livo_task_comment_cleanup_ack(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_task_comment_cleanup_claim(text,integer),public.livo_task_comment_cleanup_ack(text,text) TO service_role;
SELECT public.livo_apply_active_member_gate();
