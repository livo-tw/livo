-- Isolated PostgreSQL-only fixture; all actors and tasks are fictitious.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
-- members.role is the app_member_role enum, as in the delivery baseline
-- (20260308173019_*.sql plus super_admin). A text column here hid enum/text
-- comparison bugs that failed on real installs.
CREATE TYPE app_member_role AS ENUM ('admin','member','super_admin');
CREATE TABLE members(id text PRIMARY KEY,auth_id uuid,role app_member_role NOT NULL,name text,is_active boolean NOT NULL DEFAULT true);
CREATE TABLE projects(id text PRIMARY KEY,line_id text,name text,key text,is_archived boolean NOT NULL DEFAULT false);
CREATE TABLE statuses(id text PRIMARY KEY,name text,is_done boolean DEFAULT false,auto_start boolean DEFAULT false);
CREATE TABLE tasks(id text PRIMARY KEY,task_key text,project_id text REFERENCES projects(id),title text,status_id text REFERENCES statuses(id),
  priority text,requires_approval boolean NOT NULL DEFAULT false,started_at text,completed_at text,
  creator_id text,assignee_id text,reviewer_id text,due_date text);
CREATE TABLE system_settings(key text PRIMARY KEY,value jsonb);
CREATE TABLE notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient_id text,sender_id text,type text,task_id text,content text);
CREATE TABLE status_logs(id text PRIMARY KEY,task_id text,from_status_id text,to_status_id text,changed_by text,changed_at text);
CREATE TABLE status_transition_rules(id text PRIMARY KEY,target_status_id text,required_status_id text);
CREATE TABLE activity_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id text,action text,task_id text,task_key text,detail text);
CREATE TABLE comments(id text PRIMARY KEY,task_id text,user_id text,content text,source text);
CREATE TABLE task_checks(id text PRIMARY KEY,task_id text);
CREATE TABLE task_todos(id text PRIMARY KEY,task_id text);
CREATE TABLE task_specs(id text PRIMARY KEY,task_id text);
CREATE TABLE task_deployments(id text PRIMARY KEY,task_id text);
CREATE TABLE task_attachments(id text PRIMARY KEY,task_id text);
CREATE TABLE sprints(id text PRIMARY KEY);
CREATE TABLE backup_settings(task_notify_types text[]);
CREATE TABLE external_account_bindings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),member_id text,platform text,platform_team_id text,platform_user_id text,is_verified boolean,verified_by text);
CREATE TABLE slack_thread_mappings(slack_team_id text,slack_channel_id text,slack_thread_ts text,task_id text,notification_type text,UNIQUE(slack_channel_id,slack_thread_ts));
CREATE FUNCTION current_member_id() RETURNS text LANGUAGE sql AS $$ SELECT id FROM members WHERE auth_id=auth.uid() AND is_active LIMIT 1 $$;
CREATE FUNCTION livo_slack_session() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
-- Fake capture records unexpected duplicate status/notification events.
CREATE TABLE capture_probe(kind text);
CREATE FUNCTION capture_probe_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF current_setting('livo.slack_silent',true) IS DISTINCT FROM 'true' THEN
    INSERT INTO capture_probe VALUES(TG_TABLE_NAME);
  END IF; RETURN NEW;
END; $$;
CREATE TRIGGER task_capture AFTER UPDATE OF status_id ON tasks FOR EACH ROW EXECUTE FUNCTION capture_probe_fn();
CREATE TRIGGER notification_capture AFTER INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION capture_probe_fn();
INSERT INTO members VALUES
  ('member','00000000-0000-0000-0000-000000000001','member','Example Member',true),
  ('admin','00000000-0000-0000-0000-000000000002','admin','Example Admin',true),
  ('super','00000000-0000-0000-0000-000000000003','super_admin','Example Owner',true),
  ('reviewer','00000000-0000-0000-0000-000000000004','member','Example Reviewer',true),
  ('inactive','00000000-0000-0000-0000-000000000005','admin','Inactive Example',false);
INSERT INTO projects VALUES('project','line','Example Project','EX',false);
INSERT INTO statuses VALUES('todo','To do',false,false),('doing','Doing',false,true),('done','Done',true,false);
INSERT INTO tasks(id,task_key,project_id,title,status_id,priority,requires_approval)
  SELECT 'task-'||n,'EX-'||n,'project','Example task '||n,'todo','medium',true FROM generate_series(1,20) n;
INSERT INTO system_settings VALUES('feature_toggles','{"approvals":true}'),
  ('slack_delivery','{"enabled":true,"teamId":"TEXAMPLE","dmEnabled":true,"routes":[{"projectId":"project","channelId":"CEXAMPLE"}]}');
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role,authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
CREATE SCHEMA approval_test;
CREATE TABLE approval_test.results(label text PRIMARY KEY);
CREATE TABLE approval_test.saved(label text PRIMARY KEY,data jsonb);
CREATE TABLE approval_test.races(label text PRIMARY KEY,outcome jsonb);
GRANT USAGE ON SCHEMA approval_test TO anon,authenticated,service_role;
GRANT ALL ON ALL TABLES IN SCHEMA approval_test TO anon,authenticated,service_role;
CREATE FUNCTION approval_test.check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERTION FAILED: %',label; END IF;
  INSERT INTO approval_test.results VALUES(label);
END; $$;
CREATE FUNCTION approval_test.expect_error(label text,statement text,expected_code text,expected_message text DEFAULT '')
RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE actual_code text; actual_message text;
BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_code=RETURNED_SQLSTATE,actual_message=MESSAGE_TEXT;
    IF actual_code<>expected_code OR position(expected_message IN actual_message)=0 THEN
      RAISE EXCEPTION 'ASSERTION FAILED: %; got [%] %, expected [%] %',label,actual_code,actual_message,expected_code,expected_message;
    END IF;
    INSERT INTO approval_test.results VALUES(label);RETURN;
  END;
  RAISE EXCEPTION 'ASSERTION FAILED: %; expected error, statement succeeded',label;
END; $$;
CREATE FUNCTION approval_test.command(actor text,command jsonb) RETURNS jsonb LANGUAGE sql SECURITY INVOKER AS $$
  SELECT livo_approval_command((SELECT auth_id FROM members WHERE id=actor),command,md5(command::text)||md5(command::text))
$$;
CREATE FUNCTION approval_test.slack_command(actor text,command jsonb,identity jsonb) RETURNS jsonb LANGUAGE sql SECURITY INVOKER AS $$
  SELECT livo_approval_command((SELECT auth_id FROM members WHERE id=actor),command,md5(command::text)||md5(command::text),identity)
$$;
CREATE FUNCTION approval_test.submit(cid text,task text,rule text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('commandId',cid,'operation','submit','taskId',task,'toStatusId','done','expectedRuleId',rule,
    'enableRequirement',false,'expected',jsonb_build_object('statusId','todo','requiresApproval',true,'currentApprovalId',null,'approvalStatus',null))
$$;
CREATE FUNCTION approval_test.decision(cid text,label text,op text DEFAULT 'approve') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('commandId',cid,'operation',op,'requestId',data->'request'->>'id',
    'expectedVersion',(data->'request'->>'version')::integer,'expectedStep',(data->'request'->>'current_step')::integer,'comment',null)
    FROM approval_test.saved WHERE saved.label=decision.label
$$;
CREATE FUNCTION approval_test.race(command jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE result jsonb;
BEGIN
  -- A member submits and an administrator decides: requesters never decide their own request.
  result:=approval_test.command(CASE WHEN command->>'operation'='submit' THEN 'member' ELSE 'admin' END,command);
  RETURN jsonb_build_object('status','ok','replayed',result->'replayed');
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('status','error','sqlstate',SQLSTATE);
END;
$$;
CREATE FUNCTION approval_test.race_clear() RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN
  PERFORM livo_jira_clear_tasks(); RETURN '{"status":"ok"}'::jsonb;
EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('status','error','sqlstate',SQLSTATE);
END; $$;
