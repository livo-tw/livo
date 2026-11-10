-- Aggregate only: the HTTP adapter supplies IDs re-read through the caller's task RLS.
-- No private table is exposed through generic CRUD, and no quota counter is written.
CREATE OR REPLACE FUNCTION public.livo_task_comment_attachment_summary(p_actor text,p_auth uuid,p_tasks text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE counts jsonb; comment_counts jsonb; used_bytes bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.members WHERE id=p_actor AND auth_id=p_auth AND is_active=true)
 THEN RAISE EXCEPTION 'task_comment_forbidden' USING ERRCODE='42501'; END IF;
 IF p_tasks IS NULL OR cardinality(p_tasks)>1000 OR EXISTS(SELECT 1 FROM unnest(p_tasks)x WHERE x IS NULL OR x!~'^[A-Za-z0-9_:-]{1,180}$')
 THEN RAISE EXCEPTION 'invalid_task_summary' USING ERRCODE='22023'; END IF;
 WITH allowed AS(SELECT id FROM public.tasks WHERE id=ANY(p_tasks)),
 normal AS(SELECT task_id,count(*) n FROM public.task_attachments WHERE task_id IN(SELECT id FROM allowed) GROUP BY task_id),
 legacy AS(SELECT task_id,count(*) total,count(*) FILTER(WHERE attachment_url IS NOT NULL AND attachment_url<>'') n FROM public.comments WHERE task_id IN(SELECT id FROM allowed) GROUP BY task_id),
 private AS(SELECT task_id,count(*) n FROM public.task_comment_uploads WHERE workspace_id='default' AND task_id IN(SELECT id FROM allowed) AND state='bound' AND comment_id IS NOT NULL GROUP BY task_id)
 SELECT coalesce(jsonb_object_agg(a.id,coalesce(n.n,0)+coalesce(l.n,0)+coalesce(p.n,0)),'{}'::jsonb),coalesce(jsonb_object_agg(a.id,coalesce(l.total,0)),'{}'::jsonb)
 INTO counts,comment_counts FROM allowed a LEFT JOIN normal n ON n.task_id=a.id LEFT JOIN legacy l ON l.task_id=a.id LEFT JOIN private p ON p.task_id=a.id;
 SELECT coalesce((SELECT sum(file_size) FROM public.task_attachments),0)
  +coalesce((SELECT sum(attachment_size) FROM public.comments),0)
  +coalesce((SELECT sum(expected_size) FROM public.task_comment_uploads WHERE workspace_id='default' AND state<>'aborted'),0)
 INTO used_bytes;
 RETURN jsonb_build_object('workspaceId','default','actorId',p_actor,'counts',counts,'commentCounts',comment_counts,'storageUsedBytes',used_bytes,'storageUsageSource','task_attachment_accounting');
END;$$;
REVOKE ALL ON FUNCTION public.livo_task_comment_attachment_summary(text,uuid,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_task_comment_attachment_summary(text,uuid,text[]) TO service_role;
