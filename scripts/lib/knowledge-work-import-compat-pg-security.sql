-- Combined Phase5 owner-only draft ACL and main import-retention boundaries.
-- No real documents, storage transport or external services.
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}',false);
SET ROLE service_role;
SELECT set_config('livo.knowledge_command','on',false);
INSERT INTO public.kb_pages(id,title,body,created_by,updated_by,private_draft_owner_id)
 VALUES('compat-private','Synthetic private draft','<p>Private body remains private</p>','m-member','m-member','m-member');
SELECT set_config('livo.knowledge_command','off',false);
INSERT INTO public.kb_source_snapshots(id,workspace_id,page_id,source_kind,source_title,source_key,body,body_hash,page_version,provenance,created_by)
 VALUES('compat-snapshot','default','compat-private','md','Synthetic source','file:private-compat','<p>Exact private source</p>',repeat('f',64),1,'{"pages":[{"page":1,"state":"ready","confidence":100,"text":"Duplicate removed"}]}','m-member');
INSERT INTO public.knowledge_import_jobs(id,actor_id,version,expires_at,data)
 VALUES('compat-job','m-member',1,now()-interval '1 hour','{"id":"compat-job","source":"md","version":1,"status":"succeeded","items":[]}');
INSERT INTO public.knowledge_import_sources(id,page_id,snapshot_id,job_id,item_id,source_key,source_hash,version,original,assets,created_by)
 VALUES('compat-source','compat-private','compat-snapshot','compat-job','compat-item','file:private-compat','hash',1,'{"key":"m-member/compat-job/original"}','[{"key":"m-member/compat-job/asset"}]','m-member');
RESET ROLE;
INSERT INTO storage.objects(bucket_id,name,created_at,updated_at)
 VALUES('kb-imports','m-member/compat-job/original',now()-interval '2 days',now()-interval '2 days'),
 ('kb-imports','m-member/compat-job/asset',now()-interval '2 days',now()-interval '2 days');
SET ROLE authenticated;
SELECT qa_test.check(EXISTS(SELECT 1 FROM public.kb_pages WHERE id='compat-private'),'compat owner can read private draft with import source');
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}',false);
SELECT qa_test.check(NOT EXISTS(SELECT 1 FROM public.kb_pages WHERE id='compat-private'),'compat admin cannot read private draft after maintenance migration');
SELECT qa_test.check(NOT EXISTS(SELECT 1 FROM public.kb_source_snapshots WHERE id='compat-snapshot'),'compat admin cannot read private imported snapshot');
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false);
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000000003","role":"authenticated"}',false);
SELECT qa_test.check(NOT EXISTS(SELECT 1 FROM public.kb_pages WHERE id='compat-private'),'compat superadmin cannot read private draft after maintenance migration');
SET ROLE service_role;
SELECT qa_test.expect_error('compat import source API applies owner-only gate',$$SELECT qa_test.import_call('sources','m-super','{"page_id":"compat-private"}')$$,'42501','import_forbidden');
SELECT qa_test.check(jsonb_array_length(public.knowledge_import_cleanup('claim','{"token":"compat-worker"}'))=1,'compat maintenance can claim expired private import job');
SELECT qa_test.check(public.knowledge_import_cleanup('retained','{"job_id":"compat-job","token":"compat-worker","keys":["m-member/compat-job/original","m-member/compat-job/asset"]}') @> '["m-member/compat-job/original","m-member/compat-job/asset"]'::jsonb,'compat cleanup retains both private owner-only source objects');
SELECT qa_test.check(public.knowledge_import_cleanup('finish','{"job_id":"compat-job","token":"compat-worker"}')='true','compat private import gets content-free tombstone');
RESET ROLE;
SELECT qa_test.check((SELECT private_draft_owner_id='m-member' AND title='Synthetic private draft' AND body='<p>Private body remains private</p>' AND version=1 FROM public.kb_pages WHERE id='compat-private'),'compat cleanup cannot rewrite private owner title body or version');
SELECT qa_test.check((SELECT body='<p>Exact private source</p>' AND provenance->'pages'='[{"page":1,"state":"ready","confidence":100}]'::jsonb FROM public.kb_source_snapshots WHERE id='compat-snapshot'),'compat compact provenance preserves private exact source body');
SELECT qa_test.check(NOT EXISTS(SELECT 1 FROM storage.objects WHERE name LIKE 'm-member/compat-job/%' AND public.knowledge_import_orphan_allowed(id)),'compat private durable sources remain ineligible after cleanup');
SELECT qa_test.check((SELECT data->'items'='[]'::jsonb FROM public.knowledge_import_jobs WHERE id='compat-job'),'compat completed maintenance returns no draft source body');
