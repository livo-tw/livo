-- Human-operated release records. No deployment, task-status or QA-state side effects.
CREATE TABLE IF NOT EXISTS public.release_batches (
 workspace_id text NOT NULL DEFAULT 'default', id text PRIMARY KEY, title text NOT NULL, owner_id text NOT NULL REFERENCES public.members(id),
 status text NOT NULL CHECK(status IN('draft','active','completed','cancelled')), version integer NOT NULL CHECK(version>0), revision integer NOT NULL CHECK(revision>0),
 data jsonb NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS public.release_commands (
 workspace_id text NOT NULL DEFAULT 'default',id text PRIMARY KEY,batch_id text NOT NULL REFERENCES public.release_batches(id) DEFERRABLE INITIALLY DEFERRED,
 actor_id text NOT NULL,request_hash text NOT NULL,command jsonb NOT NULL,result_json jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS public.release_events (
 workspace_id text NOT NULL DEFAULT 'default',id text PRIMARY KEY,batch_id text NOT NULL REFERENCES public.release_batches(id),actor_id text NOT NULL,
 operation text NOT NULL,version integer NOT NULL,revision integer NOT NULL,created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS public.release_batch_projects (
 workspace_id text NOT NULL DEFAULT 'default',batch_id text NOT NULL REFERENCES public.release_batches(id),project_id text NOT NULL REFERENCES public.projects(id),PRIMARY KEY(batch_id,project_id)
);
CREATE TABLE IF NOT EXISTS public.release_batch_tasks (
 workspace_id text NOT NULL DEFAULT 'default',batch_id text NOT NULL REFERENCES public.release_batches(id),task_id text NOT NULL REFERENCES public.tasks(id),PRIMARY KEY(batch_id,task_id)
);
CREATE TABLE IF NOT EXISTS public.release_outbox (
 workspace_id text NOT NULL DEFAULT 'default',id text PRIMARY KEY,batch_id text NOT NULL REFERENCES public.release_batches(id),event_id text NOT NULL UNIQUE REFERENCES public.release_events(id),
 attempts integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'pending',next_attempt_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS public.release_slack_links (
 workspace_id text NOT NULL DEFAULT 'default',id text PRIMARY KEY,batch_id text NOT NULL REFERENCES public.release_batches(id),team_id text NOT NULL,channel_id text NOT NULL,
 thread_ts text NOT NULL,card_ts text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(batch_id,team_id,channel_id)
);
CREATE INDEX IF NOT EXISTS release_batches_order ON public.release_batches(updated_at DESC,id);
CREATE INDEX IF NOT EXISTS release_events_order ON public.release_events(batch_id,version DESC);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['release_batches','release_commands','release_events','release_batch_projects','release_batch_tasks','release_outbox','release_slack_links'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
 END LOOP;
END $$;
GRANT SELECT ON public.release_batches,public.release_events,public.release_batch_projects,public.release_batch_tasks TO authenticated;
-- References only contain identifiers and remain governed by their original tables' RLS.
DROP POLICY IF EXISTS release_project_read ON public.release_batch_projects;
CREATE POLICY release_project_read ON public.release_batch_projects FOR SELECT TO authenticated USING(public.current_member_id() IS NOT NULL);
DROP POLICY IF EXISTS release_task_read ON public.release_batch_tasks;
CREATE POLICY release_task_read ON public.release_batch_tasks FOR SELECT TO authenticated USING(public.current_member_id() IS NOT NULL);
DROP POLICY IF EXISTS release_batch_read ON public.release_batches;
CREATE POLICY release_batch_read ON public.release_batches FOR SELECT TO authenticated USING(
 public.current_member_id() IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM public.release_batch_projects r WHERE r.batch_id=release_batches.id AND NOT EXISTS(SELECT 1 FROM public.projects p WHERE p.id=r.project_id))
 AND NOT EXISTS(SELECT 1 FROM public.release_batch_tasks r WHERE r.batch_id=release_batches.id AND NOT EXISTS(SELECT 1 FROM public.tasks t WHERE t.id=r.task_id))
);
DROP POLICY IF EXISTS release_event_read ON public.release_events;
CREATE POLICY release_event_read ON public.release_events FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.release_batches b WHERE b.id=batch_id));

CREATE OR REPLACE FUNCTION public.livo_release_commit(p_auth_id uuid,p_command jsonb,p_hash text,p_after jsonb,p_event jsonb,p_slack_identity jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor public.members%ROWTYPE; binding public.external_account_bindings%ROWTYPE; prior public.release_commands%ROWTYPE;
 old public.release_batches%ROWTYPE; c jsonb; catalog jsonb; task text; stamp timestamptz:=clock_timestamp(); result jsonb;
 cid text:=p_command->>'commandId'; bid text:=p_command->>'batchId'; op text:=p_command->>'operation';
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'release_forbidden' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_command)<>'object' OR COALESCE(cid,'')!~'^[a-zA-Z0-9_-]{8,128}$' OR COALESCE(bid,'')!~'^[a-zA-Z0-9_-]{1,128}$'
  OR COALESCE(p_hash,'')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'release_invalid_input' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('livo-task-planning-import'));
 PERFORM pg_advisory_xact_lock(hashtext('livo-release-command:'||cid));
 SELECT * INTO actor FROM public.members WHERE auth_id=p_auth_id AND is_active FOR SHARE;
 IF NOT FOUND OR actor.role NOT IN('admin','super_admin') OR (SELECT count(*) FROM public.members WHERE auth_id=p_auth_id AND is_active)<>1 THEN RAISE EXCEPTION 'release_forbidden' USING ERRCODE='42501'; END IF;
 IF p_slack_identity IS NOT NULL THEN
  PERFORM 1 FROM public.system_settings WHERE key='feature_toggles' AND value->'slackActions'='true'::jsonb FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release_forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO binding FROM public.external_account_bindings WHERE id::text=p_slack_identity->>'bindingId' FOR SHARE;
  IF NOT FOUND OR binding.member_id IS DISTINCT FROM actor.id OR binding.platform IS DISTINCT FROM 'slack' OR binding.is_verified IS DISTINCT FROM true OR binding.verified_by IS NULL OR binding.verified_by NOT IN('email','admin')
   OR binding.platform_team_id IS DISTINCT FROM p_slack_identity->>'teamId' OR binding.platform_user_id IS DISTINCT FROM p_slack_identity->>'userId' THEN RAISE EXCEPTION 'release_forbidden' USING ERRCODE='42501'; END IF;
  IF (SELECT count(*) FROM public.external_account_bindings WHERE platform='slack' AND platform_team_id=binding.platform_team_id AND platform_user_id=binding.platform_user_id)<>1 THEN RAISE EXCEPTION 'release_forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 SELECT * INTO prior FROM public.release_commands WHERE id=cid;
 IF FOUND THEN
  IF prior.actor_id<>actor.id OR prior.command<>p_command OR prior.request_hash<>p_hash THEN RAISE EXCEPTION 'release_command_reused' USING ERRCODE='40001'; END IF;
  RETURN prior.result_json||jsonb_build_object('replayed',true);
 END IF;
 SELECT * INTO old FROM public.release_batches WHERE id=bid FOR UPDATE;
 IF (op='create' AND (FOUND OR (p_command->>'expectedVersion')::integer<>0)) OR (op<>'create' AND (NOT FOUND OR old.version<>(p_command->>'expectedVersion')::integer)) THEN RAISE EXCEPTION 'release_conflict' USING ERRCODE='40001'; END IF;
 IF old.status IN('completed','cancelled') AND op NOT IN('publish_thread','record_maintenance') AND NOT(op='record_result' AND p_command->>'type' IN('rollback','recovery')) THEN RAISE EXCEPTION 'release_closed' USING ERRCODE='40001'; END IF;
 IF p_after->>'id' IS DISTINCT FROM bid OR p_after->>'workspaceId' IS DISTINCT FROM 'default' OR (p_after->>'version')::integer IS DISTINCT FROM (p_command->>'expectedVersion')::integer+1
  OR (p_after->>'manifestRevision')::integer<1 OR length(p_after::text)>500000 OR jsonb_typeof(p_after->'components')<>'array'
  OR p_event->>'batchId' IS DISTINCT FROM bid OR p_event->>'actorId' IS DISTINCT FROM actor.id OR p_event->>'operation' IS DISTINCT FROM op
  OR (p_event->>'version')::integer IS DISTINCT FROM (p_after->>'version')::integer THEN RAISE EXCEPTION 'release_invalid_input' USING ERRCODE='22023'; END IF;
 IF op IN('create','edit_manifest','link_evidence','start_attempt') THEN
 PERFORM 1 FROM public.members WHERE id=p_after->>'ownerId' AND is_active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'release_reference_unavailable' USING ERRCODE='42501'; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(p_after->'components') LOOP
  PERFORM 1 FROM public.projects WHERE id=c->>'projectId' AND NOT is_archived FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release_reference_unavailable' USING ERRCODE='42501'; END IF;
  FOR task IN SELECT jsonb_array_elements_text(c->'taskIds') LOOP
   PERFORM 1 FROM public.tasks WHERE id=task AND project_id=c->>'projectId' FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'release_reference_unavailable' USING ERRCODE='42501'; END IF;
  END LOOP;
 END LOOP;
 END IF;
 IF op IN('create','edit_manifest','start_attempt') THEN
  SELECT value INTO catalog FROM public.system_settings WHERE key='deployment_environments' FOR SHARE;
  IF FOUND AND (jsonb_typeof(catalog) IS DISTINCT FROM 'object' OR catalog->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(catalog->'values') IS DISTINCT FROM 'array') THEN RAISE EXCEPTION 'release_invalid_environment' USING ERRCODE='22023'; END IF;
  IF catalog IS NOT NULL AND (jsonb_array_length(catalog->'values') NOT BETWEEN 1 AND 30) THEN RAISE EXCEPTION 'release_invalid_environment' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_after->'components') component(value) JOIN LATERAL jsonb_array_elements(component.value->'targets') target(value) ON true
    WHERE (op<>'start_attempt' OR target.value->>'environment'=p_command->>'environment') AND NOT EXISTS(
     SELECT 1 FROM jsonb_array_elements_text(COALESCE((SELECT value->'values' FROM public.system_settings WHERE key='deployment_environments'),'["Dev","QA","Stage","Live Staging","Prod"]'::jsonb)) v WHERE v=target.value->>'environment')) THEN
   RAISE EXCEPTION 'release_invalid_environment' USING ERRCODE='22023';
  END IF;
 END IF;
 IF op='link_evidence' AND p_command->>'kind'='qa' THEN
  PERFORM 1 FROM public.qa_issues WHERE id=p_command->>'issueId' AND version=(p_command->>'issueVersion')::integer AND (data->>'fixCycle')::integer=(p_after->'evidence'->-1->'qa'->>'fixCycle')::integer FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'release_evidence_stale' USING ERRCODE='40001'; END IF;
 END IF;
 IF op='publish_thread' THEN
  PERFORM 1 FROM public.system_settings WHERE key='slack_delivery' FOR SHARE;
  FOR c IN SELECT value FROM jsonb_array_elements(p_after->'components') LOOP
   PERFORM 1 FROM public.projects WHERE id=c->>'projectId' FOR SHARE;
  END LOOP;
  IF p_slack_identity IS NULL OR p_slack_identity->>'teamId' IS DISTINCT FROM p_command->>'teamId' OR p_command->'confirmed' IS DISTINCT FROM 'true'::jsonb
   OR NOT public.livo_release_route_allowed(p_after,p_command->>'teamId',p_command->>'channelId') THEN RAISE EXCEPTION 'release_forbidden' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.release_publications WHERE batch_id=bid AND (team_id IS DISTINCT FROM p_command->>'teamId' OR channel_id IS DISTINCT FROM p_command->>'channelId')) THEN RAISE EXCEPTION 'release_conflict' USING ERRCODE='40001'; END IF;
 END IF;
 INSERT INTO public.release_batches(id,title,owner_id,status,version,revision,data,updated_at)
 VALUES(bid,p_after->>'title',p_after->>'ownerId',p_after->>'status',(p_after->>'version')::integer,(p_after->>'manifestRevision')::integer,p_after,stamp)
 ON CONFLICT(id) DO UPDATE SET title=excluded.title,owner_id=excluded.owner_id,status=excluded.status,version=excluded.version,revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at;
 FOR c IN SELECT value FROM jsonb_array_elements(p_after->'components') LOOP
  INSERT INTO public.release_batch_projects(batch_id,project_id) VALUES(bid,c->>'projectId') ON CONFLICT DO NOTHING;
  INSERT INTO public.release_batch_tasks(batch_id,task_id) SELECT bid,jsonb_array_elements_text(c->'taskIds') ON CONFLICT DO NOTHING;
 END LOOP;
 INSERT INTO public.release_events(id,batch_id,actor_id,operation,version,revision,created_at) VALUES(p_event->>'id',bid,actor.id,op,(p_after->>'version')::integer,(p_after->>'manifestRevision')::integer,stamp);
 result:=jsonb_build_object('commandId',cid,'replayed',false,'batch',p_after,'event',p_event);
 INSERT INTO public.release_commands(id,batch_id,actor_id,request_hash,command,result_json) VALUES(cid,bid,actor.id,p_hash,p_command,result);
 INSERT INTO public.release_outbox(id,batch_id,event_id) VALUES(p_event->>'id',bid,p_event->>'id');
 IF op='publish_thread' THEN
  INSERT INTO public.release_publications(batch_id,team_id,channel_id,published_by,binding_id,published_at,command_id,first_version)
   VALUES(bid,p_command->>'teamId',p_command->>'channelId',actor.id,binding.id::text,stamp,cid,(p_after->>'version')::integer)
   ON CONFLICT(batch_id) DO UPDATE SET published_by=EXCLUDED.published_by,binding_id=EXCLUDED.binding_id,command_id=EXCLUDED.command_id;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.livo_release_commit(uuid,jsonb,text,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_release_commit(uuid,jsonb,text,jsonb,jsonb,jsonb) TO service_role;

-- Preserve existing clear implementation but gate it in the same transaction before any child DELETE.
DO $$ BEGIN
 IF to_regprocedure('public.livo_jira_clear_tasks_pre_release()') IS NULL AND to_regprocedure('public.livo_jira_clear_tasks()') IS NOT NULL THEN
  ALTER FUNCTION public.livo_jira_clear_tasks() RENAME TO livo_jira_clear_tasks_pre_release;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.livo_jira_clear_tasks() RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'release_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('livo-task-planning-import'));
 IF EXISTS(SELECT 1 FROM public.release_batches) THEN RAISE EXCEPTION 'release_history_requires_restore' USING ERRCODE='40001'; END IF;
 RETURN public.livo_jira_clear_tasks_pre_release();
END $$;
REVOKE ALL ON FUNCTION public.livo_jira_clear_tasks() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_jira_clear_tasks() TO service_role;
