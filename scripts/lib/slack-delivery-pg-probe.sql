-- Run only in a disposable database initialized with the real installation schema.
-- Every member, project, binding and notice below is synthetic.
CREATE SCHEMA IF NOT EXISTS slack_test;
CREATE TABLE slack_test.results(label text PRIMARY KEY);
CREATE OR REPLACE FUNCTION slack_test.check(label text, ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Slack delivery assertion failed: %',label; END IF;
INSERT INTO slack_test.results VALUES(label); END; $$;
GRANT USAGE ON SCHEMA slack_test TO authenticated;
GRANT SELECT,INSERT ON slack_test.results TO authenticated;
GRANT EXECUTE ON FUNCTION slack_test.check(text,boolean) TO authenticated;

SELECT set_config('livo.slack_silent','true',false);
INSERT INTO public.members(id,name,avatar,role,email,is_active) VALUES
 ('slack-member','Example Member','EM','member','member@example.com',true),
 ('slack-admin','Example Admin','EA','admin','admin@example.com',true),
 ('slack-owner','Example Owner','EO','super_admin','owner@example.com',true),
 ('slack-reporter','Example Reporter','ER','member','reporter@example.com',true);
INSERT INTO auth.users(id,email) VALUES
 ('00000000-0000-4000-8000-000000000001','member@example.com'),
 ('00000000-0000-4000-8000-000000000002','admin@example.com'),
 ('00000000-0000-4000-8000-000000000003','owner@example.com');
UPDATE public.members SET auth_id=('00000000-0000-4000-8000-'||CASE id WHEN 'slack-member' THEN '000000000001' WHEN 'slack-admin' THEN '000000000002' ELSE '000000000003' END)::uuid
 WHERE id IN ('slack-member','slack-admin','slack-owner');
INSERT INTO public.product_lines(id,name) VALUES('slack-line','Example line');
INSERT INTO public.projects(id,line_id,name,key) VALUES('slack-project','slack-line','Example project','EX');
INSERT INTO public.statuses(id,name,is_done) VALUES('slack-todo','Todo',false);
INSERT INTO public.tasks(id,task_key,project_id,title,status_id,creator_id,assignee_id,priority,due_date) VALUES
 ('slack-task-member','EX-1','slack-project','Example member task','slack-todo','slack-reporter','slack-member','high','2026-10-06'),
 ('slack-task-admin','EX-2','slack-project','Example admin task','slack-todo','slack-reporter','slack-admin','high','2026-10-06'),
 ('slack-task-owner','EX-3','slack-project','Example owner task','slack-todo','slack-reporter','slack-owner','high','2026-10-06');
INSERT INTO public.system_settings(key,value) VALUES
 ('feature_toggles','{"qa":true,"slackActions":true}'),
 ('slack_delivery','{"enabled":true,"teamId":"TEXAMPLE","dmEnabled":true,"routes":[{"lineId":"slack-line","channelId":"CTASK"}],"qaRoutes":[{"lineId":"slack-line","channelId":"CBUG"}],"weekly":{"enabled":false}}');
INSERT INTO public.qa_issues(id,project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data)
 VALUES('slack-issue','slack-project','triaged','slack-member','slack-admin','slack-reporter','Example Bug',2,now(),
 '{"id":"slack-issue","workspaceId":"default","projectId":"slack-project","title":"Example Bug","state":"triaged","assigneeId":"slack-member","qaOwnerId":"slack-admin","reporterId":"slack-reporter","version":2}');
SELECT set_config('livo.slack_silent','false',false);

SELECT slack_test.check('task route is isolated', (SELECT array_agg(channel_id) FROM public.livo_slack_delivery_channels('slack-project'))=ARRAY['CTASK']);
SELECT slack_test.check('bug route is isolated', (SELECT array_agg(channel_id) FROM public.livo_slack_qa_channels('slack-project'))=ARRAY['CBUG']);
SELECT slack_test.check('weekly remains disabled', public.livo_slack_queue_weekly('2026-10-05 09:00:00+08')=0);

BEGIN;
INSERT INTO public.qa_events(id,issue_id,actor_id,type,detail,version,created_at)
 VALUES('slack-event','slack-issue','slack-reporter','triage','Example responsibility change',2,now());
INSERT INTO public.notifications(recipient_id,sender_id,type,content)
 VALUES('slack-member','slack-reporter','qa_update','{"kind":"qa","issueId":"slack-issue","event":"triage"}');
COMMIT;
SELECT slack_test.check('Bug event enters only Bug channel', (SELECT count(*) FROM public.slack_delivery_outbox WHERE event_key='qa-event:slack-event' AND target_type='channel' AND target_id='CBUG')=1);
SELECT slack_test.check('Bug event never enters task channel', NOT EXISTS(SELECT 1 FROM public.slack_delivery_outbox WHERE payload->>'recordType'='qa' AND target_id='CTASK'));
SELECT slack_test.check('committed QA responsibility enters personal queue', (SELECT count(*) FROM public.slack_delivery_outbox WHERE payload->>'recordType'='qa' AND target_type='member' AND target_id='slack-member')=1);
INSERT INTO public.notifications(recipient_id,sender_id,type,content)
 VALUES('slack-admin','slack-reporter','qa_update','{"kind":"qa","issueId":"slack-issue","event":"triage"}');
SELECT slack_test.check('forged QA in-app notice does not enqueue a DM', NOT EXISTS(SELECT 1 FROM public.slack_delivery_outbox WHERE payload->>'recordType'='qa' AND target_type='member' AND target_id='slack-admin'));

BEGIN;
INSERT INTO public.qa_comments(id,issue_id,actor_id,body,created_at) VALUES('slack-comment','slack-issue','slack-reporter','Example comment',now());
INSERT INTO public.notifications(recipient_id,sender_id,type,content)
 VALUES('slack-member','slack-reporter','qa_update','{"kind":"qa","issueId":"slack-issue","event":"comment"}');
COMMIT;
SELECT slack_test.check('Bug comment enters a single Bug-channel delivery', (SELECT count(*) FROM public.slack_delivery_outbox WHERE event_key='qa-comment:slack-comment' AND target_id='CBUG')=1);
SELECT slack_test.check('QA personal comment requires the same committed comment', (SELECT count(*) FROM public.slack_delivery_outbox WHERE target_type='member' AND payload->>'eventType'='comment' AND payload->>'recordType'='qa')=1);

INSERT INTO public.external_account_bindings(member_id,platform,platform_user_id,platform_team_id,is_verified,verified_by,verified_by_member_id)
 VALUES('slack-member','slack','UEXAMPLE','TEXAMPLE',true,'admin','slack-owner');
SELECT public.livo_qa_commit('00000000-0000-4000-8000-000000000001','slack-issue','slack-comment-command',repeat('a',64),2,'comment',
 jsonb_build_object('id','slack-comment-from-slack','body','Example Slack comment','createdAt',now()),
 jsonb_build_object('type','comment','recipients',jsonb_build_array('slack-admin'),'slackIdentity',jsonb_build_object('bindingId',(SELECT id FROM public.external_account_bindings WHERE member_id='slack-member'),
 'teamId','TEXAMPLE','userId','UEXAMPLE'),'slackSource',jsonb_build_object('channel','CBUG')));
SELECT slack_test.check('Slack QA comment is not echoed to its source channel', NOT EXISTS(SELECT 1 FROM public.slack_delivery_outbox WHERE event_key='qa-comment:slack-comment-from-slack' AND target_type='channel'));
SELECT slack_test.check('Slack QA comment still notifies its responsible recipient', (SELECT count(*) FROM public.slack_delivery_outbox WHERE payload->>'eventType'='comment' AND target_type='member' AND target_id='slack-admin')=1);
SELECT slack_test.check('Slack source context does not persist across commands', COALESCE(current_setting('livo.qa_slack_channel',true),'')='');

UPDATE public.system_settings SET value=jsonb_set(jsonb_set(value,'{routes}','[]'),'{qaRoutes}','[]') WHERE key='slack_delivery';
INSERT INTO public.notifications(recipient_id,sender_id,type,task_id,content)
 VALUES('slack-member','slack-reporter','mention','slack-task-member','Example mention');
SELECT slack_test.check('task DM does not require a Slack channel route', (SELECT count(*) FROM public.slack_delivery_outbox WHERE task_id='slack-task-member' AND target_type='member')=1);
BEGIN;
INSERT INTO public.qa_events(id,issue_id,actor_id,type,detail,version,created_at) VALUES('slack-event-no-channel','slack-issue','slack-reporter','edit','Example edit',2,now());
INSERT INTO public.notifications(recipient_id,sender_id,type,content) VALUES('slack-member','slack-reporter','qa_update','{"kind":"qa","issueId":"slack-issue","event":"edit"}');
COMMIT;
SELECT slack_test.check('QA DM does not require a Slack channel route', (SELECT count(*) FROM public.slack_delivery_outbox WHERE target_type='member' AND payload->>'eventType'='edit')=1);
SELECT slack_test.check('no route means no QA channel posts', NOT EXISTS(SELECT 1 FROM public.slack_delivery_outbox WHERE event_key='qa-event:slack-event-no-channel' AND target_type='channel'));

SELECT set_config('livo.slack_silent','true',false);
INSERT INTO public.qa_events(id,issue_id,actor_id,type,detail,version,created_at) VALUES('slack-restore-event','slack-issue','slack-reporter','edit','Example restored history',2,now());
SELECT set_config('livo.slack_silent','false',false);
SELECT slack_test.check('restore stays silent', NOT EXISTS(SELECT 1 FROM public.slack_delivery_outbox WHERE event_key='qa-event:slack-restore-event'));

CREATE POLICY slack_test_tasks ON public.tasks AS RESTRICTIVE FOR SELECT TO authenticated USING(assignee_id=public.current_member_id());
SET ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
SELECT slack_test.check('member RLS reads own task only', (SELECT array_agg(id) FROM public.tasks)=ARRAY['slack-task-member']);
SELECT slack_test.check('member cannot run delivery RPC', NOT has_function_privilege(current_user,'public.livo_slack_claim_delivery(uuid)','EXECUTE'));
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}',false);
SELECT slack_test.check('admin RLS still applies', (SELECT array_agg(id) FROM public.tasks)=ARRAY['slack-task-admin']);
SELECT slack_test.check('admin cannot run delivery RPC', NOT has_function_privilege(current_user,'public.livo_slack_finish_delivery(bigint,uuid,text,text,text,text,text,integer)','EXECUTE'));
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}',false);
SELECT slack_test.check('super_admin RLS still applies', (SELECT array_agg(id) FROM public.tasks)=ARRAY['slack-task-owner']);
SELECT slack_test.check('super_admin cannot read outbox', NOT has_table_privilege(current_user,'public.slack_delivery_outbox','SELECT'));
RESET ROLE;
SELECT set_config('request.jwt.claims','{}',false);

UPDATE public.slack_delivery_outbox SET status='sending',lease_owner='00000000-0000-4000-8000-000000000099',lease_expires_at=now()+interval '2 minutes'
 WHERE event_key='qa-event:slack-event' AND target_type='channel';
SELECT slack_test.check('QA delivery commits Slack receipt', public.livo_slack_finish_delivery((SELECT id FROM public.slack_delivery_outbox WHERE event_key='qa-event:slack-event' AND target_type='channel'),
 '00000000-0000-4000-8000-000000000099','sent','CBUG','1791158400.000001','1791158400.000001'));
SELECT slack_test.check('QA root mapping supports actions and replies', (SELECT count(*) FROM public.qa_slack_links WHERE issue_id='slack-issue' AND channel_id='CBUG' AND thread_ts='1791158400.000001' AND card_ts=thread_ts)=1);
SELECT slack_test.check('QA receipt never becomes a task mapping', NOT EXISTS(SELECT 1 FROM public.slack_thread_mappings WHERE task_id='qa:slack-issue'));
SELECT slack_test.check('duplicate finish cannot renew mapping', NOT public.livo_slack_finish_delivery((SELECT id FROM public.slack_delivery_outbox WHERE event_key='qa-event:slack-event' AND target_type='channel'),
 '00000000-0000-4000-8000-000000000099','sent','CBUG','1791158400.000002','1791158400.000001'));
DELETE FROM public.qa_slack_links WHERE issue_id='slack-issue';
DELETE FROM public.qa_events WHERE issue_id='slack-issue';
DELETE FROM public.qa_comments WHERE issue_id='slack-issue';
DELETE FROM public.qa_commands WHERE issue_id='slack-issue';
DELETE FROM public.qa_issues WHERE id='slack-issue';
SELECT slack_test.check('Bug deletion cleans only its own queue', NOT EXISTS(SELECT 1 FROM public.slack_delivery_outbox WHERE payload->>'issueId'='slack-issue'));
SELECT slack_test.check('Bug deletion preserves ordinary task queue', EXISTS(SELECT 1 FROM public.slack_delivery_outbox WHERE task_id='slack-task-member'));
SELECT jsonb_build_object('status','passed','assertions',(SELECT count(*) FROM slack_test.results));
