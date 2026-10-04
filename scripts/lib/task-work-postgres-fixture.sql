-- Synthetic relevant schema, with real permission-floor/approval/planning/work
-- migrations applied by the runner. This is NOT a full production bootstrap.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $$;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt()->>'email' $$;
GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,authenticated,service_role;
CREATE TYPE task_priority AS ENUM('highest','high','medium','low','lowest');
-- members.role is the app_member_role enum, as in the delivery baseline
-- (20260308173019_*.sql plus super_admin). A text column here hid enum/text
-- comparison bugs that failed on real installs.
CREATE TYPE app_member_role AS ENUM ('admin','member','super_admin');
CREATE TABLE members(id text PRIMARY KEY,auth_id uuid,role app_member_role NOT NULL,name text,email text,is_active boolean NOT NULL DEFAULT true,theme text,sort_order integer DEFAULT 0);
CREATE TABLE projects(id text PRIMARY KEY,line_id text,name text,key text,is_archived boolean NOT NULL DEFAULT false);
CREATE TABLE statuses(id text PRIMARY KEY,name text,is_done boolean DEFAULT false,auto_start boolean DEFAULT false,auto_done boolean DEFAULT false);
CREATE TABLE tasks(
 id text PRIMARY KEY,task_key text NOT NULL,project_id text REFERENCES projects(id),title text NOT NULL,status_id text REFERENCES statuses(id),
 priority task_priority DEFAULT 'medium',creator_id text REFERENCES members(id),assignee_id text REFERENCES members(id),reviewer_id text REFERENCES members(id),
 due_date text,started_at text,completed_at text,sprint_id text,requires_approval boolean NOT NULL DEFAULT false,sort_order integer NOT NULL DEFAULT 0,
 parent_task_id text REFERENCES tasks(id) ON DELETE SET NULL);
CREATE TABLE task_checks(id text PRIMARY KEY,task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,text text NOT NULL,is_done boolean NOT NULL DEFAULT false,sort_order integer NOT NULL DEFAULT 0);
CREATE TABLE task_todos(LIKE task_checks INCLUDING ALL);
ALTER TABLE task_todos ADD FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE;
CREATE TABLE task_dependencies(id text PRIMARY KEY,task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,depends_on_task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 dependency_type text NOT NULL DEFAULT 'finish_to_start',created_at timestamptz DEFAULT now(),UNIQUE(task_id,depends_on_task_id),CHECK(task_id<>depends_on_task_id));
CREATE TABLE task_specs(id text PRIMARY KEY,task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,background text,requirement text,notes text);
CREATE TABLE status_logs(id text PRIMARY KEY,task_id text REFERENCES tasks(id) ON DELETE CASCADE,from_status_id text,to_status_id text,changed_by text,changed_at text);
CREATE TABLE activity_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id text,action text,task_id text,task_key text,detail text);
CREATE TABLE comments(id text PRIMARY KEY,task_id text REFERENCES tasks(id) ON DELETE CASCADE,user_id text,content text,source text);
CREATE TABLE custom_fields(id text PRIMARY KEY,project_id text,is_required boolean DEFAULT false);
CREATE TABLE system_settings(key text PRIMARY KEY,value jsonb);
CREATE TABLE notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient_id text,sender_id text,task_id text,type text,content text,is_read boolean NOT NULL DEFAULT false);
CREATE TABLE status_transition_rules(id text PRIMARY KEY,target_status_id text,required_status_id text);
CREATE TABLE backup_settings(task_notify_types text[]);
CREATE TABLE external_account_bindings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),member_id text,platform text,platform_team_id text,platform_user_id text,is_verified boolean,verified_by text);
CREATE TABLE slack_thread_mappings(slack_team_id text,slack_channel_id text,slack_thread_ts text,task_id text,notification_type text,UNIQUE(slack_channel_id,slack_thread_ts));
CREATE TABLE external_action_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),member_id text,action_payload jsonb);
CREATE TABLE sprints(id text PRIMARY KEY);
CREATE TABLE task_deployments(id text PRIMARY KEY,task_id text REFERENCES tasks(id) ON DELETE CASCADE);
CREATE TABLE task_attachments(id text PRIMARY KEY,task_id text REFERENCES tasks(id) ON DELETE CASCADE);
CREATE FUNCTION current_member_id() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT id FROM members WHERE auth_id=auth.uid() AND is_active LIMIT 1 $$;
CREATE FUNCTION livo_slack_session() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT COALESCE(auth.jwt()->>'livo_slack','false')='true' $$;
INSERT INTO members(id,auth_id,role,name,email) VALUES
 ('member','00000000-0000-0000-0000-000000000001','member','Member','member@example.com'),
 ('admin','00000000-0000-0000-0000-000000000002','admin','Admin','admin@example.com'),
 ('super','00000000-0000-0000-0000-000000000003','super_admin','Super','super@example.com'),
 ('other','00000000-0000-0000-0000-000000000004','member','Other','other@example.com');
INSERT INTO projects VALUES('p','line','Project','P',false),('q','line','Other project','Q',false),('archived','line','Archived','AR',true);
INSERT INTO statuses VALUES('todo','Todo',false,false,false),('doing','Doing',false,true,false),('done','Done',true,false,true),('auto-both','Auto dates',true,true,true);
INSERT INTO tasks(id,task_key,project_id,title,status_id,creator_id,assignee_id,reviewer_id)
 SELECT 't-'||i,'P-'||i,CASE WHEN i=79 THEN 'archived' WHEN i=80 THEN 'q' ELSE 'p' END,'Synthetic task','todo','member','member','other' FROM generate_series(1,80)i;
INSERT INTO external_account_bindings VALUES('00000000-0000-0000-0000-000000000010','member','slack','TTEST','UTEST',true,'admin');
INSERT INTO system_settings VALUES('feature_toggles','{"slackActions":true,"approvals":true}'),('required_fields','{}');
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['members','projects','statuses','tasks','task_checks','task_todos','task_dependencies','task_specs','status_logs','activity_logs','comments','custom_fields','system_settings','notifications','external_account_bindings'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('GRANT ALL ON public.%I TO authenticated,service_role',n);
  EXECUTE format('CREATE POLICY fixture_read ON public.%I FOR SELECT TO authenticated USING (true)',n);
 END LOOP;
END; $$;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
CREATE SCHEMA work_test;
CREATE TABLE work_test.results(label text PRIMARY KEY,ok boolean,detail text);
CREATE TABLE work_test.saved(label text PRIMARY KEY,result jsonb);
CREATE TABLE work_test.races(label text PRIMARY KEY,result jsonb);
GRANT USAGE ON SCHEMA work_test TO anon,authenticated,service_role;
GRANT ALL ON ALL TABLES IN SCHEMA work_test TO anon,authenticated,service_role;
CREATE FUNCTION work_test.check(ok boolean,label text) RETURNS void LANGUAGE sql AS $$ INSERT INTO work_test.results VALUES(label,ok IS TRUE,NULL) $$;
CREATE FUNCTION work_test.error(label text,statement text,message text) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE actual text;
BEGIN
 BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS actual=MESSAGE_TEXT;
  INSERT INTO work_test.results VALUES(label,position(message IN actual)>0,CASE WHEN position(message IN actual)=0 THEN actual END); RETURN;
 END;
 INSERT INTO work_test.results VALUES(label,false,'statement unexpectedly succeeded');
END; $$;
CREATE FUNCTION work_test.race(statement text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE data jsonb;
BEGIN EXECUTE statement INTO data; RETURN jsonb_build_object('status','ok','pid',pg_backend_pid(),'result',data);
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('status','error','pid',pg_backend_pid(),'code',SQLSTATE,'message',SQLERRM); END; $$;
-- Unrelated digest/delivery functions have external dependencies not represented
-- by this fixture. Their bodies are not validated or exercised by these tests.
SET check_function_bodies=off;
