-- Atomic sprint lifecycle; old completed totals remain explicitly incomplete.
DO $migration$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='statuses' AND column_name='is_cancelled') THEN
  ALTER TABLE public.statuses ADD COLUMN is_cancelled boolean NOT NULL DEFAULT false;
  UPDATE public.statuses SET is_cancelled=true,is_done=true WHERE id='s7' OR id ~ '^[0-9a-f]{8}-s7$';
 END IF;
END $migration$;
DO $migration$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.statuses'::regclass AND conname='statuses_cancelled_terminal') THEN
  ALTER TABLE public.statuses ADD CONSTRAINT statuses_cancelled_terminal CHECK(NOT is_cancelled OR is_done);
 END IF;
END $migration$;
ALTER TABLE public.sprints ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0 CHECK(version>=0);
ALTER TABLE public.sprints ADD COLUMN IF NOT EXISTS cancelled_count integer CHECK(cancelled_count>=0);
ALTER TABLE public.sprints ADD COLUMN IF NOT EXISTS history_captured_at timestamptz;
CREATE TABLE IF NOT EXISTS public.sprint_task_history(
 id text PRIMARY KEY,sprint_id uuid NOT NULL REFERENCES public.sprints(id),task_id text NOT NULL,
 task_key text NOT NULL,title text NOT NULL,project_id text NOT NULL,status_id text NOT NULL,status_name text NOT NULL,
 assignee_id text,parent_task_id text,outcome text NOT NULL CHECK(outcome IN('completed','cancelled','pending','removed','unknown')),
 source text NOT NULL CHECK(source IN('snapshot','observed','legacy')),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(sprint_id,task_id)
);
CREATE TABLE IF NOT EXISTS public.sprint_command_contexts(
 command_id uuid PRIMARY KEY,transaction_id bigint NOT NULL,actor_id text NOT NULL,sprint_id uuid NOT NULL,operation text NOT NULL CHECK(operation IN('start','complete'))
);
CREATE TABLE IF NOT EXISTS public.sprint_command_receipts(
 command_id uuid PRIMARY KEY,actor_id text NOT NULL,command jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.sprint_task_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sprint_command_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sprint_command_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sprint_task_history,public.sprint_command_contexts,public.sprint_command_receipts FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.sprint_task_history TO authenticated;
GRANT ALL ON public.sprint_task_history,public.sprint_command_contexts,public.sprint_command_receipts TO service_role;
DROP POLICY IF EXISTS sprint_history_read ON public.sprint_task_history;
CREATE POLICY sprint_history_read ON public.sprint_task_history FOR SELECT TO authenticated USING(
 EXISTS(SELECT 1 FROM public.projects p WHERE p.id=project_id)
);

CREATE OR REPLACE FUNCTION public.livo_sprint_name(p_name text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT btrim(p_name,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$$;
CREATE OR REPLACE FUNCTION public.livo_sprint_name_valid(p_name text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT p_name IS NOT NULL AND length(p_name)>0 AND
  COALESCE((SELECT sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END) FROM regexp_split_to_table(p_name,'') ch),0)<=120
$$;
REVOKE ALL ON FUNCTION public.livo_sprint_name(text),public.livo_sprint_name_valid(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.livo_sprint_name(text),public.livo_sprint_name_valid(text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.livo_sprint_row_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE allowed boolean;
BEGIN
 SELECT EXISTS(SELECT 1 FROM public.sprint_command_contexts c WHERE c.transaction_id=txid_current() AND c.sprint_id=NEW.id
  AND c.operation=CASE WHEN TG_OP='INSERT' THEN 'start' ELSE 'complete' END) INTO allowed;
 IF TG_OP='INSERT' OR NEW.name IS DISTINCT FROM OLD.name THEN
  NEW.name:=public.livo_sprint_name(NEW.name);
  IF NOT public.livo_sprint_name_valid(NEW.name) THEN RAISE EXCEPTION 'sprint_invalid_input' USING ERRCODE='22023'; END IF;
 END IF;
 IF NOT allowed THEN
  IF TG_OP='INSERT' OR (to_jsonb(NEW)-'name') IS DISTINCT FROM (to_jsonb(OLD)-'name') THEN
   RAISE EXCEPTION 'sprint_forbidden' USING ERRCODE='42501';
  END IF;
  IF NEW.name IS NOT DISTINCT FROM OLD.name THEN RETURN NEW; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('livo-sprint-lifecycle')) THEN RAISE EXCEPTION 'sprint_conflict' USING ERRCODE='PT409'; END IF;
  NEW.version:=OLD.version+1;
 END IF;
 IF (TG_OP='INSERT' OR NEW.name IS DISTINCT FROM OLD.name) AND EXISTS(SELECT 1 FROM public.sprints s WHERE s.id<>NEW.id AND s.name=NEW.name) THEN RAISE EXCEPTION 'sprint_conflict' USING ERRCODE='PT409'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.livo_sprint_row_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_sprint_row_guard ON public.sprints;
CREATE TRIGGER livo_sprint_row_guard BEFORE INSERT OR UPDATE ON public.sprints FOR EACH ROW EXECUTE FUNCTION public.livo_sprint_row_guard();

CREATE OR REPLACE FUNCTION public.livo_sprint_membership_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE parent_sprint uuid; active boolean;
BEGIN
 IF TG_OP='INSERT' AND NEW.parent_task_id IS NOT NULL THEN
  SELECT p.sprint_id INTO parent_sprint FROM public.tasks p WHERE p.id=NEW.parent_task_id FOR SHARE;
  IF parent_sprint IS NOT NULL THEN
   SELECT s.is_active INTO active FROM public.sprints s WHERE s.id=parent_sprint FOR SHARE;
  END IF;
  NEW.sprint_id:=CASE WHEN active IS TRUE THEN parent_sprint ELSE NULL END;
 END IF;
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.sprint_id IS DISTINCT FROM NEW.sprint_id) THEN
  IF OLD.sprint_id IS NOT NULL THEN PERFORM 1 FROM public.sprints WHERE id=OLD.sprint_id FOR SHARE; END IF;
 END IF;
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND OLD.sprint_id IS DISTINCT FROM NEW.sprint_id) THEN
  IF NEW.sprint_id IS NOT NULL THEN
   SELECT s.is_active INTO active FROM public.sprints s WHERE s.id=NEW.sprint_id FOR SHARE;
   IF NOT FOUND OR active IS NOT TRUE THEN RAISE EXCEPTION 'sprint_conflict' USING ERRCODE='PT409'; END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.livo_sprint_membership_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_sprint_membership_guard ON public.tasks;
CREATE TRIGGER livo_sprint_membership_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.livo_sprint_membership_guard();

CREATE OR REPLACE FUNCTION public.livo_sprint_history_observe() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE card public.tasks%ROWTYPE; sid uuid; result_outcome text; status_label text;
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.sprint_id IS DISTINCT FROM NEW.sprint_id) THEN
  IF OLD.sprint_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.sprints WHERE id=OLD.sprint_id AND is_active) THEN
   card:=OLD;sid:=OLD.sprint_id;result_outcome:='removed';
   SELECT name INTO status_label FROM public.statuses WHERE id=card.status_id;
   INSERT INTO public.sprint_task_history(id,sprint_id,task_id,task_key,title,project_id,status_id,status_name,assignee_id,parent_task_id,outcome,source)
    VALUES('sprint:'||sid::text||':'||card.id,sid,card.id,card.task_key,card.title,card.project_id,card.status_id,COALESCE(status_label,''),card.assignee_id,card.parent_task_id,result_outcome,'observed')
    ON CONFLICT(sprint_id,task_id) DO UPDATE SET task_key=EXCLUDED.task_key,title=EXCLUDED.title,project_id=EXCLUDED.project_id,status_id=EXCLUDED.status_id,status_name=EXCLUDED.status_name,assignee_id=EXCLUDED.assignee_id,parent_task_id=EXCLUDED.parent_task_id,outcome='removed',source='observed',recorded_at=clock_timestamp()
    WHERE sprint_task_history.source<>'snapshot';
  END IF;
 END IF;
 IF TG_OP<>'DELETE' AND NEW.sprint_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.sprints WHERE id=NEW.sprint_id AND is_active) THEN
  card:=NEW;sid:=NEW.sprint_id;SELECT name INTO status_label FROM public.statuses WHERE id=card.status_id;
  INSERT INTO public.sprint_task_history(id,sprint_id,task_id,task_key,title,project_id,status_id,status_name,assignee_id,parent_task_id,outcome,source)
   VALUES('sprint:'||sid::text||':'||card.id,sid,card.id,card.task_key,card.title,card.project_id,card.status_id,COALESCE(status_label,''),card.assignee_id,card.parent_task_id,'unknown','observed')
   ON CONFLICT(sprint_id,task_id) DO UPDATE SET task_key=EXCLUDED.task_key,title=EXCLUDED.title,project_id=EXCLUDED.project_id,status_id=EXCLUDED.status_id,status_name=EXCLUDED.status_name,assignee_id=EXCLUDED.assignee_id,parent_task_id=EXCLUDED.parent_task_id,outcome='unknown',source='observed',recorded_at=clock_timestamp()
   WHERE sprint_task_history.source<>'snapshot';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.livo_sprint_history_observe() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_sprint_history_observe ON public.tasks;
CREATE TRIGGER livo_sprint_history_observe AFTER INSERT OR UPDATE OR DELETE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.livo_sprint_history_observe();

-- Only currently known associations are observable for old rows. No historical
-- totals, membership or completion time is reconstructed from today's status.
INSERT INTO public.sprint_task_history(id,sprint_id,task_id,task_key,title,project_id,status_id,status_name,assignee_id,parent_task_id,outcome,source)
 SELECT 'sprint:'||s.id::text||':'||t.id,s.id,t.id,t.task_key,t.title,t.project_id,t.status_id,st.name,t.assignee_id,t.parent_task_id,'unknown',CASE WHEN s.is_active THEN 'observed' ELSE 'legacy' END
 FROM public.tasks t JOIN public.sprints s ON s.id=t.sprint_id JOIN public.statuses st ON st.id=t.status_id
 ON CONFLICT(sprint_id,task_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.livo_sprint_command(p_command jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor public.members%ROWTYPE; sprint public.sprints%ROWTYPE; receipt public.sprint_command_receipts%ROWTYPE;
 cid uuid;sid uuid;op text;new_name text;expected_version integer;command jsonb;result jsonb;ids text[];all_ids text[];pending_ids text[];carry_ids text[];card public.tasks%ROWTYPE;
 done_count integer:=0;cancel_count integer:=0;pending_total integer:=0;stamp timestamptz:=clock_timestamp();outcome text;status_label text;
BEGIN
 SELECT * INTO actor FROM public.members WHERE auth_id=auth.uid() AND is_active FOR SHARE;
 IF NOT FOUND OR (SELECT count(*) FROM public.members WHERE auth_id=auth.uid() AND is_active)<>1 THEN RAISE EXCEPTION 'sprint_forbidden' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_command) IS DISTINCT FROM 'object' OR COALESCE(p_command->>'commandId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR COALESCE(p_command->>'sprintId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'sprint_invalid_input' USING ERRCODE='22023'; END IF;
 cid:=(p_command->>'commandId')::uuid;sid:=(p_command->>'sprintId')::uuid;op:=p_command->>'operation';
 IF op='start' THEN
  IF (p_command-ARRAY['commandId','operation','sprintId','name','taskIds','includeBacklog'])<>'{}'::jsonb OR NOT(p_command ?& ARRAY['commandId','operation','sprintId','name','taskIds','includeBacklog'])
   OR jsonb_typeof(p_command->'name')<>'string' OR jsonb_typeof(p_command->'includeBacklog')<>'boolean' OR jsonb_typeof(p_command->'taskIds')<>'array'
   OR jsonb_array_length(p_command->'taskIds')>2000 THEN RAISE EXCEPTION 'sprint_invalid_input' USING ERRCODE='22023'; END IF;
  new_name:=public.livo_sprint_name(p_command->>'name');IF NOT public.livo_sprint_name_valid(new_name) THEN RAISE EXCEPTION 'sprint_invalid_input' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_command->'taskIds') e WHERE jsonb_typeof(e)<>'string' OR length(e#>>'{}') NOT BETWEEN 1 AND 200) THEN RAISE EXCEPTION 'sprint_invalid_input' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::text[]) INTO ids FROM(SELECT DISTINCT value AS id FROM jsonb_array_elements_text(p_command->'taskIds')) q;
  command:=jsonb_build_object('commandId',cid::text,'operation',op,'sprintId',sid::text,'name',new_name,'taskIds',to_jsonb(ids),'includeBacklog',p_command->'includeBacklog');
 ELSIF op='complete' THEN
  IF (p_command-ARRAY['commandId','operation','sprintId','expectedVersion'])<>'{}'::jsonb OR NOT(p_command ?& ARRAY['commandId','operation','sprintId','expectedVersion'])
   OR jsonb_typeof(p_command->'expectedVersion') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'sprint_invalid_input' USING ERRCODE='22023'; END IF;
  IF (p_command->>'expectedVersion')::numeric<0 OR (p_command->>'expectedVersion')::numeric>2147483647 OR trunc((p_command->>'expectedVersion')::numeric)<>(p_command->>'expectedVersion')::numeric THEN RAISE EXCEPTION 'sprint_invalid_input' USING ERRCODE='22023'; END IF;
  expected_version:=(p_command->>'expectedVersion')::numeric::integer;
  command:=jsonb_build_object('commandId',cid::text,'operation',op,'sprintId',sid::text,'expectedVersion',expected_version);
 ELSE RAISE EXCEPTION 'sprint_invalid_input' USING ERRCODE='22023'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtext('livo-task-planning-import')) OR NOT pg_try_advisory_xact_lock(hashtext('livo-sprint-lifecycle')) THEN RAISE EXCEPTION 'sprint_conflict' USING ERRCODE='PT409'; END IF;
 SELECT * INTO receipt FROM public.sprint_command_receipts WHERE command_id=cid;
 IF FOUND THEN
  IF receipt.actor_id<>actor.id OR receipt.command<>command THEN RAISE EXCEPTION 'sprint_command_reused' USING ERRCODE='PT409'; END IF;
  RETURN receipt.result||jsonb_build_object('replayed',true);
 END IF;
 IF op='start' THEN
  IF EXISTS(SELECT 1 FROM public.sprints WHERE is_active OR id=sid OR name=new_name) THEN RAISE EXCEPTION 'sprint_conflict' USING ERRCODE='PT409'; END IF;
  PERFORM 1 FROM public.statuses ORDER BY id FOR SHARE;
  IF EXISTS(SELECT 1 FROM unnest(ids) i WHERE NOT EXISTS(SELECT 1 FROM public.tasks t JOIN public.projects p ON p.id=t.project_id JOIN public.statuses st ON st.id=t.status_id WHERE t.id=i AND t.sprint_id IS NULL AND NOT p.is_archived AND NOT st.is_done AND NOT st.is_cancelled)) THEN RAISE EXCEPTION 'sprint_invalid_input' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::text[]) INTO all_ids FROM(
   SELECT t.id FROM public.tasks t JOIN public.projects p ON p.id=t.project_id JOIN public.statuses st ON st.id=t.status_id
   WHERE t.id=ANY(ids) OR ((p_command->>'includeBacklog')::boolean AND t.sprint_id IS NULL AND NOT p.is_archived AND NOT st.is_done AND NOT st.is_cancelled)
  ) q;
  PERFORM 1 FROM public.tasks WHERE id=ANY(all_ids) ORDER BY id FOR UPDATE NOWAIT;
  IF EXISTS(SELECT 1 FROM public.tasks t JOIN public.projects p ON p.id=t.project_id JOIN public.statuses st ON st.id=t.status_id WHERE t.id=ANY(all_ids) AND (t.sprint_id IS NOT NULL OR p.is_archived OR st.is_done OR st.is_cancelled)) THEN RAISE EXCEPTION 'sprint_conflict' USING ERRCODE='PT409'; END IF;
  INSERT INTO public.sprint_command_contexts(command_id,transaction_id,actor_id,sprint_id,operation) VALUES(cid,txid_current(),actor.id,sid,op);
  INSERT INTO public.sprints(id,name,is_active,started_at,version,completed_count,pending_count,cancelled_count) VALUES(sid,new_name,true,stamp,1,0,cardinality(all_ids),0) RETURNING * INTO sprint;
  UPDATE public.tasks SET sprint_id=sid WHERE id=ANY(all_ids);
  result:=jsonb_build_object('sprintId',sid::text,'version',1,'completedCount',0,'cancelledCount',0,'pendingCount',cardinality(all_ids),'pendingIds',to_jsonb(all_ids),'carryIds',to_jsonb(all_ids),'taskIds',to_jsonb(all_ids));
 ELSE
  -- Task locks are fail-fast before the sprint lock. Membership writers hold a
  -- shared sprint lock; a concurrent unseen join/removal therefore conflicts
  -- rather than slipping between snapshot and closure or deadlocking a parent.
  PERFORM 1 FROM public.tasks WHERE sprint_id=sid ORDER BY id FOR UPDATE NOWAIT;
  SELECT * INTO sprint FROM public.sprints WHERE id=sid FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'sprint_not_found' USING ERRCODE='P0002'; END IF;
  IF NOT sprint.is_active OR sprint.version<>expected_version THEN RAISE EXCEPTION 'sprint_conflict' USING ERRCODE='PT409'; END IF;
  PERFORM 1 FROM public.statuses ORDER BY id FOR SHARE;
  INSERT INTO public.sprint_command_contexts(command_id,transaction_id,actor_id,sprint_id,operation) VALUES(cid,txid_current(),actor.id,sid,op);
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::text[]) INTO all_ids FROM public.tasks WHERE sprint_id=sid;
  pending_ids:='{}'::text[];
  FOR card IN SELECT * FROM public.tasks WHERE sprint_id=sid ORDER BY id LOOP
   SELECT s.name,CASE WHEN s.is_cancelled THEN 'cancelled' WHEN s.is_done THEN 'completed' ELSE 'pending' END INTO status_label,outcome FROM public.statuses s WHERE s.id=card.status_id;
   IF outcome='cancelled' THEN cancel_count:=cancel_count+1;ELSIF outcome='completed' THEN done_count:=done_count+1;ELSE pending_total:=pending_total+1;pending_ids:=array_append(pending_ids,card.id);END IF;
   INSERT INTO public.sprint_task_history(id,sprint_id,task_id,task_key,title,project_id,status_id,status_name,assignee_id,parent_task_id,outcome,source,recorded_at)
    VALUES('sprint:'||sid::text||':'||card.id,sid,card.id,card.task_key,card.title,card.project_id,card.status_id,status_label,card.assignee_id,card.parent_task_id,outcome,'snapshot',stamp)
    ON CONFLICT(sprint_id,task_id) DO UPDATE SET task_key=EXCLUDED.task_key,title=EXCLUDED.title,project_id=EXCLUDED.project_id,status_id=EXCLUDED.status_id,status_name=EXCLUDED.status_name,assignee_id=EXCLUDED.assignee_id,parent_task_id=EXCLUDED.parent_task_id,outcome=EXCLUDED.outcome,source='snapshot',recorded_at=EXCLUDED.recorded_at;
  END LOOP;
  UPDATE public.sprints SET is_active=false,completed_at=stamp,version=version+1,completed_count=done_count,cancelled_count=cancel_count,pending_count=pending_total,history_captured_at=stamp WHERE id=sid RETURNING * INTO sprint;
  UPDATE public.tasks SET sprint_id=NULL WHERE id=ANY(pending_ids);
  SELECT COALESCE(array_agg(t.id ORDER BY t.id),'{}'::text[]) INTO carry_ids FROM public.tasks t JOIN public.projects p ON p.id=t.project_id WHERE t.id=ANY(pending_ids) AND NOT p.is_archived;
  result:=jsonb_build_object('sprintId',sid::text,'version',sprint.version,'completedCount',done_count,'cancelledCount',cancel_count,'pendingCount',pending_total,'pendingIds',to_jsonb(pending_ids),'carryIds',to_jsonb(carry_ids),'taskIds',to_jsonb(all_ids));
 END IF;
 INSERT INTO public.sprint_command_receipts(command_id,actor_id,command,result) VALUES(cid,actor.id,command,result);
 DELETE FROM public.sprint_command_contexts WHERE command_id=cid AND transaction_id=txid_current() AND actor_id=actor.id;
 RETURN result;
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN RAISE EXCEPTION 'sprint_conflict' USING ERRCODE='PT409';
END $$;
REVOKE ALL ON FUNCTION public.livo_sprint_command(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.livo_sprint_command(jsonb) TO authenticated,service_role;
-- Jira's destructive reset must not orphan/delete retained sprint history.
DO $migration$
DECLARE definition text;old text:='IF EXISTS(SELECT 1 FROM public.task_work_events) OR EXISTS(SELECT 1 FROM public.task_work_receipts) THEN';
BEGIN
 IF to_regprocedure('public.livo_jira_clear_tasks()') IS NOT NULL THEN
  definition:=pg_get_functiondef('public.livo_jira_clear_tasks()'::regprocedure);
  IF position('public.sprint_task_history' IN definition)=0 THEN
   IF (length(definition)-length(replace(definition,old,'')))/length(old)<>1 THEN RAISE EXCEPTION 'sprint_clear_guard_anchor_changed'; END IF;
   definition:=replace(definition,old,'IF EXISTS(SELECT 1 FROM public.task_work_events) OR EXISTS(SELECT 1 FROM public.task_work_receipts) OR EXISTS(SELECT 1 FROM public.sprint_task_history) OR EXISTS(SELECT 1 FROM public.sprint_command_receipts) THEN');
   EXECUTE definition;
  END IF;
 END IF;
END $migration$;
SELECT public.livo_apply_active_member_gate();