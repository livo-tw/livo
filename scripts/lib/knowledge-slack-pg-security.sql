-- Fictional fixtures, disposable test database only.
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',false);
SELECT set_config('request.jwt.claims','{}',false);
INSERT INTO public.members(id,auth_id,role,job_title,is_active) VALUES
 ('ks-reader','c0200000-0000-0000-0000-000000000001','member','Engineer',true),
 ('ks-owner','c0200000-0000-0000-0000-000000000002','super_admin','Engineer',true),
 ('ks-planner','c0200000-0000-0000-0000-000000000003','member','PM',true),
 ('ks-legacy','c0200000-0000-0000-0000-000000000004','member','PM',true);
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000006',false);
INSERT INTO public.kb_pages(id,title,body,created_by,updated_by) VALUES ('ks-public','Release guide','Public release reference','ks-owner','ks-owner');
INSERT INTO public.kb_pages(id,title,body,created_by,updated_by,access_policy) VALUES
 ('ks-private','RestrictedOnly release','RestrictedOnly body','ks-owner','ks-owner','{"mode":"custom","view":{"roles":[],"positions":["PM"],"member_ids":[]},"edit":{"roles":[],"positions":["PM"],"member_ids":[]},"comment":{"roles":[],"positions":["PM"],"member_ids":[]}}');
INSERT INTO public.kb_pages(id,title,body,parent_id,category,created_by,updated_by) VALUES
 ('ks-child','RestrictedOnly child','RestrictedOnly child body','ks-private','meeting','ks-owner','ks-owner');
INSERT INTO public.external_account_bindings(id,member_id,platform,platform_user_id,is_verified,verified_by,verified_by_member_id) VALUES
 ('c0210000-0000-0000-0000-000000000001','ks-reader','slack','U-EX-READER',true,'email',NULL),
 ('c0210000-0000-0000-0000-000000000002','ks-owner','slack','U-EX-OWNER',true,'email',NULL),
 ('c0210000-0000-0000-0000-000000000003','ks-planner','slack','U-EX-PLANNER',true,'admin','ks-owner'),
 ('c0210000-0000-0000-0000-000000000004','ks-legacy','slack','U-EX-LEGACY',true,'admin',NULL);
INSERT INTO public.system_settings(key,value) VALUES ('feature_toggles','{"slackActions":true}') ON CONFLICT(key) DO UPDATE SET value=system_settings.value||excluded.value;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','c0200000-0000-0000-0000-000000000001',false);
SELECT set_config('request.jwt.claims','{}',false);
SELECT qa_test.expect_error('Slack requires internal verified binding claim',$$SELECT public.kb_slack_search('Release')$$,'42501','knowledge_search_forbidden');
SELECT set_config('request.jwt.claims','{"livo_slack_binding":"c0210000-0000-0000-0000-000000000001"}',false);
SELECT qa_test.check(jsonb_array_length(public.kb_slack_search('RestrictedOnly')->'pages')=0 AND (public.kb_slack_search('RestrictedOnly')->>'hasMore')='false','Slack hides private ancestor titles and counts');
SELECT qa_test.check(jsonb_array_length(public.kb_slack_search('Release guide')->'pages')=1 AND NOT (public.kb_slack_search('Release guide')->'pages'->0 ? 'body'),'Slack returns safe public metadata');
SELECT qa_test.expect_error('Slack raw binding certification is server-only',$$UPDATE public.external_account_bindings SET verified_by_member_id='ks-owner' WHERE member_id='ks-reader'$$,'42501','managed by the server');
SELECT set_config('request.jwt.claim.sub','c0200000-0000-0000-0000-000000000002',false);
SELECT set_config('request.jwt.claims','{"livo_slack_binding":"c0210000-0000-0000-0000-000000000002"}',false);
SELECT qa_test.check(jsonb_array_length(public.kb_slack_search('RestrictedOnly')->'pages')=0,'Slack highest role cannot bypass KB ACL');
SELECT set_config('request.jwt.claim.sub','c0200000-0000-0000-0000-000000000004',false);
SELECT set_config('request.jwt.claims','{"livo_slack_binding":"c0210000-0000-0000-0000-000000000004"}',false);
SELECT qa_test.expect_error('Slack legacy manual binding needs owner confirmation',$$SELECT public.kb_slack_search('RestrictedOnly')$$,'42501','knowledge_search_forbidden');
SELECT set_config('request.jwt.claim.sub','c0200000-0000-0000-0000-000000000003',false);
SELECT set_config('request.jwt.claims','{"livo_slack_binding":"c0210000-0000-0000-0000-000000000003"}',false);
SELECT qa_test.check(jsonb_array_length(public.kb_slack_search('RestrictedOnly')->'pages')=2,'Slack certified PM sees permitted parent and child');
SELECT qa_test.check(jsonb_array_length(public.kb_slack_search('RestrictedOnly',0,'meeting')->'pages')=1,'Slack category filter preserves permissions');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',false);
UPDATE public.members SET job_title='Engineer' WHERE id='ks-planner';
SELECT set_config('request.jwt.claim.sub','c0200000-0000-0000-0000-000000000003',false);
SET ROLE authenticated;
SELECT qa_test.check(jsonb_array_length(public.kb_slack_search('RestrictedOnly')->'pages')=0,'Slack position revocation takes effect on next query');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',false);
UPDATE public.members SET job_title='PM' WHERE id='ks-planner';
SELECT set_config('request.jwt.claim.sub','c0200000-0000-0000-0000-000000000003',false);
UPDATE public.members SET role='admin' WHERE id='ks-owner';
SET ROLE authenticated;
SELECT qa_test.expect_error('Slack issuer downgrade invalidates manual certification',$$SELECT public.kb_slack_search('RestrictedOnly')$$,'42501','knowledge_search_forbidden');
RESET ROLE;
UPDATE public.members SET role='super_admin' WHERE id='ks-owner';
UPDATE public.members SET is_active=false WHERE id='ks-planner';
SET ROLE authenticated;
SELECT qa_test.expect_error('Slack inactive member cannot search',$$SELECT public.kb_slack_search('RestrictedOnly')$$,'42501','knowledge_search_forbidden');
RESET ROLE;
UPDATE public.members SET is_active=true WHERE id='ks-planner';
UPDATE public.system_settings SET value=value||'{"slackActions":false}' WHERE key='feature_toggles';
SET ROLE authenticated;
SELECT qa_test.expect_error('Slack disabled interaction cannot search',$$SELECT public.kb_slack_search('Release')$$,'42501','knowledge_search_forbidden');
RESET ROLE;
