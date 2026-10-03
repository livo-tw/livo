-- Synthetic planning fixture; real permission floor and planning migrations are
-- applied by the runner. This is not a full production schema bootstrap.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $$;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt()->>'email' $$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;
CREATE TABLE public.members(id text PRIMARY KEY,auth_id uuid,role text NOT NULL,name text,email text,is_active boolean DEFAULT true,theme text,sort_order integer DEFAULT 0);
CREATE TABLE public.projects(id text PRIMARY KEY,line_id text,name text,key text,is_archived boolean DEFAULT false);
CREATE TABLE public.statuses(id text PRIMARY KEY,name text,is_done boolean DEFAULT false);
CREATE TABLE public.tasks(id text PRIMARY KEY,task_key text,project_id text REFERENCES projects(id),title text,status_id text REFERENCES statuses(id),creator_id text REFERENCES members(id),assignee_id text,reviewer_id text,due_date text,started_at text,completed_at text,current_approval_id text,approval_status text);
CREATE TABLE public.approval_requests(id text PRIMARY KEY,requested_by text,status text);
CREATE TABLE public.notifications(id text PRIMARY KEY,recipient_id text,sender_id text,task_id text,type text,content text);
CREATE TABLE public.system_settings(key text PRIMARY KEY,value jsonb);
CREATE TABLE public.comments(id text PRIMARY KEY,task_id text REFERENCES tasks(id) ON DELETE CASCADE,user_id text,content text);
CREATE TABLE public.sprints(id text PRIMARY KEY);
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['task_checks','task_todos','task_specs','task_deployments','task_attachments','status_logs'] LOOP
  EXECUTE format('CREATE TABLE public.%I(id text PRIMARY KEY,task_id text REFERENCES tasks(id) ON DELETE CASCADE)',n);
 END LOOP;
END; $$;
CREATE TABLE public.external_account_bindings(id uuid PRIMARY KEY,member_id text,platform text,platform_team_id text,platform_user_id text,is_verified boolean,verified_by text);
CREATE FUNCTION public.current_member_id() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT id FROM members WHERE auth_id=auth.uid() LIMIT 1 $$;
INSERT INTO members(id,auth_id,role,name,email) VALUES
 ('member','00000000-0000-0000-0000-000000000001','member','Member','member@example.com'),
 ('admin','00000000-0000-0000-0000-000000000002','admin','Admin','admin@example.com'),
 ('super','00000000-0000-0000-0000-000000000003','super_admin','Super','super@example.com'),
 ('other','00000000-0000-0000-0000-000000000004','member','Other','other@example.com');
INSERT INTO projects VALUES('p','line','Project','P',false),('archived','line','Archived','AR',true),('hidden','line','Hidden','H',false);
INSERT INTO statuses VALUES('todo','Todo',false);
INSERT INTO tasks(id,task_key,project_id,title,status_id,creator_id)
 SELECT 't-'||i,'T-'||i,CASE WHEN i=29 THEN 'archived' WHEN i=30 THEN 'hidden' ELSE 'p' END,'Synthetic task','todo','member' FROM generate_series(1,30)i;
INSERT INTO external_account_bindings VALUES('00000000-0000-0000-0000-000000000010','member','slack','TTEST','UTEST',true,'admin');
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['members','projects','statuses','tasks','notifications','system_settings','external_account_bindings'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('GRANT ALL ON public.%I TO authenticated,service_role',n);
  EXECUTE format('CREATE POLICY fixture_read ON public.%I FOR SELECT TO authenticated USING (%s)',n,CASE WHEN n='tasks' THEN 'project_id<>''hidden''' ELSE 'true' END);
END LOOP;
END; $$;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
CREATE SCHEMA planning_test;
CREATE TABLE planning_test.results(label text PRIMARY KEY,ok boolean,detail text);
CREATE TABLE planning_test.races(label text PRIMARY KEY,result jsonb);
GRANT USAGE ON SCHEMA planning_test TO authenticated,service_role;
GRANT ALL ON ALL TABLES IN SCHEMA planning_test TO authenticated,service_role;
CREATE FUNCTION planning_test.check(ok boolean,label text) RETURNS void LANGUAGE sql AS $$ INSERT INTO planning_test.results VALUES(label,ok IS TRUE,NULL) $$;
CREATE FUNCTION planning_test.error(label text,statement text,message text) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE actual text;
BEGIN
 BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS actual=MESSAGE_TEXT;
  INSERT INTO planning_test.results VALUES(label,position(message IN actual)>0,CASE WHEN position(message IN actual)=0 THEN actual END); RETURN;
 END;
 INSERT INTO planning_test.results VALUES(label,false,'statement unexpectedly succeeded');
END; $$;
CREATE FUNCTION planning_test.race(statement text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN EXECUTE statement; RETURN jsonb_build_object('status','ok','pid',pg_backend_pid());
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('status','error','pid',pg_backend_pid(),'code',SQLSTATE,'message',SQLERRM); END; $$;
-- The weekly digest's unrelated delivery helpers are deliberately not stubbed.
-- CREATE succeeds, but the native suite does not claim digest integration.
SET check_function_bodies=off;
