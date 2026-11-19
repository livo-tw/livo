-- Commit an ordinary-task comment edit and its new private media together.
CREATE OR REPLACE FUNCTION public.livo_task_comment_edit(
 p_auth uuid,p_actor text,p_task text,p_comment text,p_id text,p_previous_body text,p_body text,p_uploads text[],p_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 prior public.task_comment_commands%ROWTYPE;
 target public.comments%ROWTYPE;
 result jsonb;
 input_payload jsonb:=jsonb_build_object('task',p_task,'comment',p_comment,'previousBody',p_previous_body,'body',p_body,'uploads',p_uploads);
BEGIN
 IF p_id IS NULL OR p_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR p_body IS NULL OR length(p_body)>20000 OR p_previous_body IS NULL OR length(p_previous_body)>20000
 OR p_hash IS NULL OR p_uploads IS NULL OR cardinality(p_uploads) NOT BETWEEN 1 AND 10
 OR cardinality(p_uploads)<>(SELECT count(DISTINCT x) FROM unnest(p_uploads)x)
 THEN RAISE EXCEPTION 'invalid_comment' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('task-comment-command:'||p_id));
 PERFORM 1 FROM public.members WHERE id=p_actor AND auth_id=p_auth AND is_active=true FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.tasks WHERE id=p_task FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'task_unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO target FROM public.comments WHERE id=p_comment AND task_id=p_task AND user_id=p_actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO prior FROM public.task_comment_commands WHERE workspace_id='default' AND id=p_id;
 IF FOUND THEN
   IF prior.actor_id<>p_actor OR prior.task_id<>p_task OR prior.payload_hash<>p_hash OR prior.payload IS DISTINCT FROM input_payload
   THEN RAISE EXCEPTION 'command_id_reused' USING ERRCODE='PT409'; END IF;
   RETURN jsonb_build_object('comment',to_jsonb(target));
 END IF;
 IF target.content IS DISTINCT FROM p_previous_body THEN RAISE EXCEPTION 'comment_edit_conflict' USING ERRCODE='PT409'; END IF;
 PERFORM id FROM public.task_comment_uploads WHERE workspace_id='default' AND id=ANY(p_uploads) ORDER BY id FOR UPDATE;
 IF (SELECT count(*) FROM public.task_comment_uploads WHERE workspace_id='default' AND id=ANY(p_uploads)
     AND task_id=p_task AND actor_id=p_actor AND state='complete' AND comment_id IS NULL AND expires_at>clock_timestamp())<>cardinality(p_uploads)
 OR cardinality(p_uploads)+(SELECT count(*) FROM public.task_comment_uploads WHERE workspace_id='default'
     AND task_id=p_task AND comment_id=p_comment AND state='bound')>10
 THEN RAISE EXCEPTION 'invalid_upload' USING ERRCODE='PT409'; END IF;
 UPDATE public.comments SET content=p_body WHERE id=p_comment RETURNING * INTO target;
 UPDATE public.task_comment_uploads SET comment_id=p_comment,state='bound' WHERE workspace_id='default' AND id=ANY(p_uploads);
 result:=jsonb_build_object('comment',to_jsonb(target));
 INSERT INTO public.task_comment_commands(id,task_id,actor_id,payload_hash,payload,result)
 VALUES(p_id,p_task,p_actor,p_hash,input_payload,result);
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_task_comment_edit(uuid,text,text,text,text,text,text,text[],text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_task_comment_edit(uuid,text,text,text,text,text,text,text[],text) TO service_role;
