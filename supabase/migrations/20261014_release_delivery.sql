-- A release is shared only after explicit, signed Slack publication.
CREATE TABLE IF NOT EXISTS public.release_publications (
 workspace_id text NOT NULL DEFAULT 'default', batch_id text PRIMARY KEY REFERENCES public.release_batches(id),
 team_id text NOT NULL CHECK(team_id ~ '^T[A-Z0-9]+$'), channel_id text NOT NULL CHECK(channel_id ~ '^[CG][A-Z0-9]+$'),
 published_by text NOT NULL REFERENCES public.members(id), binding_id text NOT NULL,
 published_at timestamptz NOT NULL, command_id text NOT NULL, first_version integer NOT NULL CHECK(first_version>0)
);
ALTER TABLE public.release_publications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.release_publications FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.release_publications TO service_role;
ALTER TABLE public.release_outbox ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE public.release_outbox ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE public.release_outbox ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE public.release_outbox ADD COLUMN IF NOT EXISTS message_ts text;
CREATE INDEX IF NOT EXISTS release_outbox_pending ON public.release_outbox(status,next_attempt_at,created_at);

CREATE OR REPLACE FUNCTION public.livo_release_route_allowed(p_after jsonb,p_team text,p_channel text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE config jsonb; component jsonb; project public.projects%ROWTYPE;
BEGIN
 SELECT value INTO config FROM public.system_settings WHERE key='slack_delivery';
 IF config->'enabled' IS DISTINCT FROM 'true'::jsonb OR config->>'teamId' IS DISTINCT FROM p_team
   OR COALESCE(p_team,'') !~ '^T[A-Z0-9]+$' OR COALESCE(p_channel,'') !~ '^[CG][A-Z0-9]+$'
   OR jsonb_typeof(config->'routes') IS DISTINCT FROM 'array'
   OR jsonb_typeof(p_after->'components') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(p_after->'components')=0 THEN RETURN false; END IF;
 FOR component IN SELECT value FROM jsonb_array_elements(p_after->'components') LOOP
  SELECT * INTO project FROM public.projects WHERE id=component->>'projectId' AND NOT is_archived;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(config->'routes') r
    WHERE COALESCE(r->'enabled','true'::jsonb)='true'::jsonb AND r->>'channelId'=p_channel
    AND (r->>'projectId'=project.id OR r->>'lineId'=project.line_id)) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.livo_release_route_allowed(jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_release_route_allowed(jsonb,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_release_claim_delivery(p_owner text,p_batch text DEFAULT NULL)
RETURNS SETOF public.release_outbox LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE job public.release_outbox%ROWTYPE;
BEGIN
 IF COALESCE(p_owner,'') !~ '^[A-Za-z0-9_-]{8,200}$' THEN RETURN; END IF;
 -- An expired send can already have reached Slack. Never retry it automatically.
 UPDATE public.release_outbox SET status='review',last_error='delivery_receipt_unknown',lease_owner=NULL,lease_until=NULL
 WHERE status='sending' AND lease_until<clock_timestamp();
 UPDATE public.release_outbox o SET status='skipped',last_error='before_explicit_publication'
 FROM public.release_publications p,public.release_events e
 WHERE o.batch_id=p.batch_id AND o.workspace_id=p.workspace_id AND e.id=o.event_id
   AND e.workspace_id=o.workspace_id AND e.version<p.first_version AND o.status='pending';
 SELECT o.* INTO job FROM public.release_outbox o
 JOIN public.release_publications p ON p.batch_id=o.batch_id AND p.workspace_id=o.workspace_id
 JOIN public.release_events e ON e.id=o.event_id AND e.workspace_id=o.workspace_id
 WHERE o.status='pending' AND (p_batch IS NULL OR o.batch_id=p_batch) AND (o.next_attempt_at IS NULL OR o.next_attempt_at<=clock_timestamp())
 AND NOT EXISTS(
  SELECT 1 FROM public.release_outbox older JOIN public.release_events earlier ON earlier.id=older.event_id AND earlier.workspace_id=older.workspace_id
  WHERE older.batch_id=o.batch_id AND older.workspace_id=o.workspace_id AND older.status IN('pending','sending','review')
    AND (earlier.version<e.version OR (earlier.version=e.version AND older.id<o.id))
 ) ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN; END IF;
 UPDATE public.release_outbox SET status='sending',lease_owner=p_owner,lease_until=clock_timestamp()+interval '180 seconds',attempts=attempts+1
 WHERE id=job.id RETURNING * INTO job;
 RETURN NEXT job;
END; $$;
REVOKE ALL ON FUNCTION public.livo_release_claim_delivery(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_release_claim_delivery(text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_release_can_deliver(p_id text,p_owner text,p_version integer,p_user text,p_team text,p_channel text)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE job public.release_outbox%ROWTYPE; publication public.release_publications%ROWTYPE;
 batch public.release_batches%ROWTYPE; binding public.external_account_bindings%ROWTYPE;
BEGIN
 SELECT * INTO job FROM public.release_outbox WHERE id=p_id AND status='sending' AND lease_owner=p_owner AND lease_until>clock_timestamp();
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO publication FROM public.release_publications WHERE batch_id=job.batch_id AND workspace_id=job.workspace_id;
 IF NOT FOUND OR publication.team_id IS DISTINCT FROM p_team OR publication.channel_id IS DISTINCT FROM p_channel THEN RETURN false; END IF;
 SELECT * INTO batch FROM public.release_batches WHERE id=job.batch_id AND workspace_id=job.workspace_id AND version=p_version;
 IF NOT FOUND OR NOT public.livo_release_route_allowed(batch.data,publication.team_id,publication.channel_id) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.system_settings WHERE key='feature_toggles' AND value->'slackActions'='true'::jsonb) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.members WHERE id=publication.published_by AND is_active AND role::text IN('admin','super_admin')) THEN RETURN false; END IF;
 SELECT * INTO binding FROM public.external_account_bindings WHERE id::text=publication.binding_id;
 IF NOT FOUND OR binding.member_id IS DISTINCT FROM publication.published_by OR binding.platform IS DISTINCT FROM 'slack'
   OR binding.platform_team_id IS DISTINCT FROM publication.team_id OR binding.is_verified IS DISTINCT FROM true
   OR binding.verified_by IS NULL OR binding.verified_by NOT IN('email','admin') OR COALESCE(binding.platform_user_id,'') !~ '^[UW][A-Z0-9]+$' OR binding.platform_user_id IS DISTINCT FROM p_user
   OR (SELECT count(*) FROM public.external_account_bindings WHERE platform='slack' AND platform_team_id=binding.platform_team_id AND platform_user_id=binding.platform_user_id)<>1 THEN RETURN false; END IF;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.livo_release_can_deliver(text,text,integer,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_release_can_deliver(text,text,integer,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_release_finish_delivery(
 p_id text,p_owner text,p_status text,p_message_ts text DEFAULT NULL,p_thread_ts text DEFAULT NULL,p_error text DEFAULT NULL,p_delay integer DEFAULT 0)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE job public.release_outbox%ROWTYPE; publication public.release_publications%ROWTYPE; existing public.release_slack_links%ROWTYPE;
BEGIN
 IF p_status NOT IN('sent','pending','failed','review','skipped') THEN RETURN false; END IF;
 SELECT * INTO job FROM public.release_outbox WHERE id=p_id AND status='sending' AND lease_owner=p_owner AND lease_until>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF p_status='sent' THEN
  IF COALESCE(p_message_ts,'') !~ '^[0-9]+[.][0-9]+$' OR COALESCE(p_thread_ts,'') !~ '^[0-9]+[.][0-9]+$' THEN RETURN false; END IF;
  SELECT * INTO publication FROM public.release_publications WHERE batch_id=job.batch_id AND workspace_id=job.workspace_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO existing FROM public.release_slack_links WHERE batch_id=job.batch_id AND workspace_id=job.workspace_id AND team_id=publication.team_id AND channel_id=publication.channel_id FOR UPDATE;
  IF FOUND AND existing.thread_ts IS DISTINCT FROM p_thread_ts THEN RETURN false; END IF;
  INSERT INTO public.release_slack_links(workspace_id,id,batch_id,team_id,channel_id,thread_ts,card_ts)
  VALUES(job.workspace_id,job.batch_id,job.batch_id,publication.team_id,publication.channel_id,p_thread_ts,p_message_ts)
  ON CONFLICT(batch_id,team_id,channel_id) DO UPDATE SET card_ts=EXCLUDED.card_ts;
 END IF;
 UPDATE public.release_outbox SET status=p_status,lease_owner=NULL,lease_until=NULL,last_error=left(p_error,100),message_ts=p_message_ts,
 next_attempt_at=CASE WHEN p_status='pending' THEN clock_timestamp()+make_interval(secs=>greatest(1,least(p_delay,3600))) ELSE NULL END
 WHERE id=p_id;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.livo_release_finish_delivery(text,text,text,text,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_release_finish_delivery(text,text,text,text,text,text,integer) TO service_role;
