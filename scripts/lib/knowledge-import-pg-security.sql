-- Run after the workflow fixture/assertions. Only synthetic documents and actors.
RESET ROLE;
CREATE OR REPLACE FUNCTION qa_test.import_call(action text,actor_id text,payload jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.knowledge_import_db(action,actor_id,payload||jsonb_build_object('auth_id',(SELECT auth_id::text FROM public.members WHERE id=actor_id)));
$$;
SELECT set_config('request.jwt.claim.sub','',false);
UPDATE public.members SET job_title='PM',is_active=true WHERE id='m-member';
SET ROLE authenticated;
SELECT qa_test.expect_error('import raw job read forbidden',$$SELECT * FROM public.knowledge_import_jobs$$,'42501');
SELECT qa_test.expect_error('import raw policy read forbidden',$$SELECT * FROM public.knowledge_import_policy$$,'42501');
SELECT qa_test.expect_error('import RPC is service-only',$$SELECT qa_test.import_call('policy','m-super','{}')$$,'42501');
RESET ROLE;
SET ROLE service_role;
SELECT qa_test.check(qa_test.import_call('policy','m-super','{}')->>'version'='0','import default policy version');
SELECT qa_test.check(qa_test.import_call('save_policy','m-super','{"expected":0,"policy":{"version":1,"subjects":{"roles":["super_admin"],"positions":["PM"],"member_ids":[]},"notion_subjects":{"roles":["super_admin"],"positions":[],"member_ids":[]},"notion_pages":[]}}')='true','import highest admin configures grant');
SELECT qa_test.expect_error('import ordinary admin cannot change grant',$$SELECT qa_test.import_call('save_policy','m-admin','{"expected":1,"policy":{"version":2}}')$$,'40001','policy_changed');
SELECT qa_test.check(public.knowledge_import_can('m-member'),'import live PM matches grant');
SELECT qa_test.check(NOT public.knowledge_import_can('m-admin'),'import ordinary admin lacks implicit grant');
RESET ROLE;
INSERT INTO public.knowledge_import_jobs(id,actor_id,version,expires_at,data) VALUES('import-test-job','m-member',3,now()+interval '1 day',jsonb_build_object(
  'id','import-test-job','actor_id','m-member','source','md','status','committing','version',3,'policy_version',1,
  'created_at',now(),'expires_at',now()+interval '1 day','initial_parent','kw-private','items',jsonb_build_array(jsonb_build_object(
    'id','import-test-item','title','Reviewed meeting','source_key','file:example','source_hash',repeat('a',64),'status','ready',
    'original',jsonb_build_object('key','m-member/import-test-job/import-test-item/original','name','meeting.md','size',20,'type','text/markdown'),'assets','[]'::jsonb,
    'parsed',jsonb_build_object('body','<p>Source decision</p>','warnings','[]'::jsonb,'pages','[]'::jsonb,'parser_version','test','incomplete',false)))));
CREATE TEMP TABLE import_commit_request(data jsonb);
INSERT INTO import_commit_request VALUES('{"job_id":"import-test-job","job_version":3,"item_id":"import-test-item","mapping":{"reviewed":true,"confirm_audience":true,"allow_incomplete":false,"destination":{"mode":"create","parent_id":"kw-private","project_id":null,"category":"meeting","policy":{"mode":"inherit"}}},"source":{"id":"import-source-1","page_id":"import-created","snapshot_id":"import-snapshot-1"}}');
GRANT SELECT ON import_commit_request TO service_role;
SET ROLE service_role;
SELECT qa_test.check(qa_test.import_call('commit','m-member',(SELECT data FROM import_commit_request))->>'page_id'='import-created','import atomic page snapshot commit');
SELECT qa_test.check(qa_test.import_call('commit','m-member',(SELECT data FROM import_commit_request))->>'page_id'='import-created','import replay returns same page');
SELECT qa_test.check(jsonb_array_length(qa_test.import_call('sources','m-member','{"page_id":"import-created"}'))=1,'import replay creates one source');
SELECT qa_test.expect_error('import admin cannot read PM source',$$SELECT qa_test.import_call('sources','m-admin','{"page_id":"import-created"}')$$,'42501','import_forbidden');
RESET ROLE;
SELECT qa_test.check((SELECT count(*)=1 FROM public.kb_pages WHERE id='import-created'),'import creates one page');
SELECT qa_test.check((SELECT count(*)=1 FROM public.kb_source_snapshots WHERE id='import-snapshot-1'),'import creates immutable original');
SELECT qa_test.check((SELECT parent_id='kw-private' AND access_policy='{"mode":"inherit"}'::jsonb FROM public.kb_pages WHERE id='import-created'),'import inherits restricted parent atomically');
SELECT qa_test.check((SELECT body='<p>Source decision</p>' FROM public.kb_pages WHERE id='import-created'),'import converted body saved');
UPDATE public.members SET job_title='Engineer' WHERE id='m-member';
SET ROLE service_role;
SELECT qa_test.expect_error('import revoked grant blocks job preview',$$SELECT qa_test.import_call('get','m-member','{"id":"import-test-job"}')$$,'42501','import_forbidden');
SELECT qa_test.expect_error('import revoked position blocks download source',$$SELECT qa_test.import_call('sources','m-member','{"page_id":"import-created"}')$$,'42501','import_forbidden');
RESET ROLE;
CREATE OR REPLACE FUNCTION qa_test.import_call(action text,actor_id text,payload jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.knowledge_import_db(action,actor_id,payload||jsonb_build_object('auth_id',(SELECT auth_id::text FROM public.members WHERE id=actor_id)));
$$;
SELECT set_config('request.jwt.claim.sub','',false);
UPDATE public.members SET job_title='PM' WHERE id='m-member';
SELECT qa_test.check(NOT (SELECT public FROM storage.buckets WHERE id='kb-imports'),'import staging bucket private');
INSERT INTO storage.objects(bucket_id,name) VALUES('kb-imports','m-member/import-test-job/import-test-item/original');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
SELECT qa_test.check((SELECT count(*)=0 FROM storage.objects WHERE bucket_id='kb-imports'),'import broad storage policy cannot expose staging');
RESET ROLE;
