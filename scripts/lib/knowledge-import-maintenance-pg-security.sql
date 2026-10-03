-- Isolated PostgreSQL only. No original company records or external storage calls.
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',false);
SELECT set_config('request.jwt.claims','{}',false);
UPDATE public.members SET is_active=false WHERE id='m-member';
INSERT INTO public.knowledge_import_jobs(id,actor_id,version,expires_at,data) VALUES
 ('maintenance-inactive','m-member',4,now()-interval '1 hour',jsonb_build_object('id','maintenance-inactive','source','pdf','version',4,'status','parsing','items',jsonb_build_array(jsonb_build_object('parsed',jsonb_build_object('body','PRIVATE EXPIRED PREVIEW'))))),
 ('maintenance-deleted','no-such-member',4,now()-interval '1 hour',jsonb_build_object('id','maintenance-deleted','source','md','version',4,'status','uploaded','items','[]'::jsonb)),
 ('maintenance-fresh','no-such-member',4,now()+interval '1 hour',jsonb_build_object('id','maintenance-fresh','source','md','version',4,'items','[]'::jsonb));
INSERT INTO public.knowledge_import_sources(id,page_id,snapshot_id,job_id,item_id,source_key,source_hash,version,original,assets,created_by)
 VALUES('maintenance-source','import-created','import-snapshot-1','maintenance-inactive','maintenance-item','file:fixture','hash',1,
   '{"key":"m-member/maintenance-inactive/original"}',
   '[{"key":"m-member/maintenance-inactive/asset"}]','another-creator');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
SELECT qa_test.expect_error('maintenance member cannot invoke service RPC',$$SELECT public.knowledge_import_cleanup('claim','{"token":"unauthorized"}')$$,'42501');
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
SELECT qa_test.expect_error('maintenance admin cannot invoke service RPC',$$SELECT public.knowledge_import_cleanup('claim','{"token":"unauthorized"}')$$,'42501');
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false);
SELECT qa_test.expect_error('maintenance superadmin cannot invoke service RPC',$$SELECT public.knowledge_import_cleanup('claim','{"token":"unauthorized"}')$$,'42501');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',false);
SELECT set_config('request.jwt.claims','{}',false);
CREATE TEMP TABLE maintenance_claims(data jsonb);
GRANT SELECT,INSERT ON maintenance_claims TO service_role;
SET ROLE service_role;
INSERT INTO maintenance_claims SELECT public.knowledge_import_cleanup('claim','{"token":"worker-a","limit":20}');
SELECT qa_test.check((SELECT jsonb_array_length(data)=2 FROM maintenance_claims),'maintenance claims inactive and deleted actors without member authorization');
SELECT qa_test.check(public.knowledge_import_cleanup('claim','{"token":"worker-b","limit":20}')='[]'::jsonb,'maintenance concurrent worker cannot duplicate active lease');
SELECT qa_test.check(public.knowledge_import_cleanup('owns','{"job_id":"maintenance-inactive","token":"worker-a"}')='true','maintenance owner has live lease');
SELECT qa_test.check(public.knowledge_import_cleanup('owns','{"job_id":"maintenance-inactive","token":"worker-b"}')='false','maintenance stale worker cannot take lease');
SELECT qa_test.check(public.knowledge_import_cleanup('retained','{"job_id":"maintenance-inactive","token":"worker-a","keys":["m-member/maintenance-inactive/original","m-member/maintenance-inactive/asset","m-member/maintenance-inactive/unused"]}') @> '["m-member/maintenance-inactive/original","m-member/maintenance-inactive/asset"]'::jsonb,'maintenance protects private committed references of another creator');
SELECT qa_test.check(jsonb_array_length(public.knowledge_import_cleanup('retained','{"job_id":"maintenance-inactive","token":"worker-a","keys":["m-member/maintenance-inactive/unused"]}'))=0,'maintenance unused objects are not retained');
SELECT qa_test.expect_error('maintenance stale worker cannot finalize',$$SELECT public.knowledge_import_cleanup('finish','{"job_id":"maintenance-inactive","token":"worker-b"}')$$,'40001','cleanup_lease_lost');
RESET ROLE;
SELECT qa_test.check((SELECT version=5 AND (data->>'version')::integer=5 FROM public.knowledge_import_jobs WHERE id='maintenance-inactive'),'maintenance claim fences old parser and commit version');
SELECT qa_test.check((SELECT version=4 FROM public.knowledge_import_jobs WHERE id='maintenance-fresh'),'maintenance preserves unexpired work');
SET ROLE service_role;
SELECT qa_test.check(public.knowledge_import_cleanup('finish','{"job_id":"maintenance-inactive","token":"worker-a"}')='true','maintenance first sweep finalizes');
SELECT qa_test.check(public.knowledge_import_cleanup('finish','{"job_id":"maintenance-deleted","token":"worker-a"}')='true','maintenance deleted actor first sweep finalizes');
SELECT qa_test.check(public.knowledge_import_cleanup('claim','{"token":"worker-c"}')='[]'::jsonb,'maintenance delays second sweep for late storage writes');
RESET ROLE;
SELECT qa_test.check((SELECT data->'items'='[]'::jsonb AND data::text NOT LIKE '%PRIVATE EXPIRED PREVIEW%' FROM public.knowledge_import_jobs WHERE id='maintenance-inactive'),'maintenance tombstone contains no preview body');
SELECT qa_test.check((SELECT count(*)=1 FROM public.knowledge_import_sources WHERE id='maintenance-source'),'maintenance does not delete source metadata');
UPDATE public.knowledge_import_jobs SET data=data||jsonb_build_object('cleanup_completed_at',now()-interval '16 minutes','cleanup_after',now()-interval '1 minute')
 WHERE id IN ('maintenance-inactive','maintenance-deleted');
SET ROLE service_role;
SELECT qa_test.check(jsonb_array_length(public.knowledge_import_cleanup('claim','{"token":"worker-d"}'))=2,'maintenance retries tombstones after settling');
SELECT qa_test.check(public.knowledge_import_cleanup('finish','{"job_id":"maintenance-inactive","token":"worker-d"}')='true','maintenance second successful sweep removes job');
SELECT qa_test.check(public.knowledge_import_cleanup('finish','{"job_id":"maintenance-deleted","token":"worker-d"}')='true','maintenance second sweep works for deleted actor');
RESET ROLE;
SELECT qa_test.check((SELECT count(*)=0 FROM public.knowledge_import_jobs WHERE id IN ('maintenance-inactive','maintenance-deleted')),'maintenance expired job metadata removed');
SELECT qa_test.check((SELECT count(*)=1 FROM public.knowledge_import_sources WHERE id='maintenance-source'),'maintenance retained source survives job removal');
UPDATE public.members SET is_active=true WHERE id='m-member';

-- Only new provenance is compacted. Original converted body remains intact.
INSERT INTO public.kb_source_snapshots(id,workspace_id,page_id,source_kind,source_title,source_key,body,body_hash,page_version,provenance,created_by)
 VALUES('maintenance-provenance','default','import-created','pdf','Synthetic provenance fixture','file:provenance','<p>Exact converted source</p>',repeat('e',64),1,
   '{"pages":[{"page":1,"state":"needs_review","confidence":82,"text":"DUPLICATE OCR TEXT","low_confidence":[{"text":"word"}]}],"historical":true}','m-member');
SELECT qa_test.check((SELECT body='<p>Exact converted source</p>' AND provenance->'pages'='[{"page":1,"state":"needs_review","confidence":82}]'::jsonb FROM public.kb_source_snapshots WHERE id='maintenance-provenance'),'maintenance compact provenance preserves exact original body');

-- Legacy versions could upload before saving the job. Only the dedicated
-- import bucket is eligible; ordinary knowledge attachments are never targets.
INSERT INTO storage.buckets(id,name,public) VALUES('kb-files','kb-files',false) ON CONFLICT DO NOTHING;
INSERT INTO storage.objects(bucket_id,name,created_at,updated_at) VALUES
 ('kb-imports','gone/legacy-old/original',now()-interval '30 hours',now()-interval '30 hours'),
 ('kb-imports','m-member/maintenance-inactive/original',now()-interval '30 hours',now()-interval '30 hours'),
 ('kb-imports','m-member/maintenance-inactive/asset',now()-interval '30 hours',now()-interval '30 hours'),
 ('kb-imports','gone/maintenance-fresh/original',now()-interval '30 hours',now()-interval '30 hours'),
 ('kb-imports','gone/young/original',now()-interval '1 hour',now()-interval '1 hour'),
 ('kb-imports','gone/unknown-created/original',NULL,now()-interval '30 hours'),
 ('kb-imports','gone/unknown-updated/original',now()-interval '30 hours',NULL),
 ('kb-imports','gone/rewritten/original',now()-interval '30 hours',now()-interval '1 hour'),
 ('kb-imports','../outside/original',now()-interval '30 hours',now()-interval '30 hours'),
 ('kb-files','gone/ordinary/original',now()-interval '30 hours',now()-interval '30 hours');
CREATE TEMP TABLE orphan_inventory(stage text PRIMARY KEY,data jsonb);
GRANT SELECT,INSERT ON orphan_inventory TO service_role;
SET ROLE authenticated;
SELECT qa_test.expect_error('maintenance member cannot scan orphan inventory',$$SELECT public.knowledge_import_cleanup('orphan_scan')$$,'42501');
SELECT qa_test.expect_error('maintenance member cannot probe orphan eligibility',$$SELECT public.knowledge_import_orphan_allowed('00000000-0000-0000-0000-000000000000')$$,'42501');
SELECT qa_test.expect_error('maintenance member cannot read cleanup cursor',$$SELECT * FROM public.knowledge_import_cleanup_cursors$$,'42501');
SET ROLE service_role;
INSERT INTO orphan_inventory SELECT 'initial',public.knowledge_import_cleanup('orphan_scan');
SELECT qa_test.check((SELECT data->>'done'='true' AND jsonb_array_length(data->'objects')=1 AND data->'objects'->0->>'key'='gone/legacy-old/original' FROM orphan_inventory WHERE stage='initial'),'maintenance only old no-job unreferenced import object is eligible');
SELECT qa_test.check(public.knowledge_import_cleanup('orphan_check',(SELECT data->'objects'->0 FROM orphan_inventory WHERE stage='initial'))='true','maintenance immediately rechecks eligible orphan identity');
RESET ROLE;
SELECT qa_test.check(NOT EXISTS(SELECT 1 FROM storage.objects WHERE name IN ('gone/young/original','gone/unknown-created/original','gone/unknown-updated/original','gone/rewritten/original','../outside/original','gone/ordinary/original') AND public.knowledge_import_orphan_allowed(id)),'maintenance preserves young unknown rewritten malformed and ordinary files');
SELECT qa_test.check(NOT EXISTS(SELECT 1 FROM storage.objects WHERE name IN ('m-member/maintenance-inactive/original','m-member/maintenance-inactive/asset','gone/maintenance-fresh/original') AND public.knowledge_import_orphan_allowed(id)),'maintenance preserves durable original asset and existing-job files');
UPDATE public.knowledge_import_sources SET assets=assets||'[{"key":"gone/legacy-old/original"}]'::jsonb WHERE id='maintenance-source';
SET ROLE service_role;
SELECT qa_test.check(public.knowledge_import_cleanup('orphan_check',(SELECT data->'objects'->0 FROM orphan_inventory WHERE stage='initial'))='false','maintenance new durable reference revokes stale orphan inventory');
RESET ROLE;
UPDATE public.knowledge_import_sources SET assets=assets-1 WHERE id='maintenance-source';
INSERT INTO public.knowledge_import_jobs(id,actor_id,version,expires_at,data) VALUES('legacy-old','gone',1,now()+interval '1 hour','{"items":[]}');
SET ROLE service_role;
SELECT qa_test.check(public.knowledge_import_cleanup('orphan_check',(SELECT data->'objects'->0 FROM orphan_inventory WHERE stage='initial'))='false','maintenance new job revokes stale orphan inventory');
RESET ROLE;
DELETE FROM public.knowledge_import_jobs WHERE id='legacy-old';
UPDATE storage.objects SET updated_at=now() WHERE bucket_id='kb-imports' AND name='gone/legacy-old/original';
SET ROLE service_role;
SELECT qa_test.check(public.knowledge_import_cleanup('orphan_check',(SELECT data->'objects'->0 FROM orphan_inventory WHERE stage='initial'))='false','maintenance object rewrite revokes stale orphan inventory');
RESET ROLE;

-- A full first page of retained source files must not starve the next orphan.
INSERT INTO storage.objects(bucket_id,name,created_at,updated_at)
 SELECT 'kb-imports','gone/cursor-'||lpad(n::text,3,'0')||'/original',now()-interval '48 hours'+n*interval '1 second',now()-interval '48 hours'+n*interval '1 second' FROM generate_series(1,101) n;
UPDATE public.knowledge_import_sources SET assets=assets||(SELECT jsonb_agg(jsonb_build_object('key','gone/cursor-'||lpad(n::text,3,'0')||'/original')) FROM generate_series(1,100) n) WHERE id='maintenance-source';
SET ROLE service_role;
INSERT INTO orphan_inventory SELECT 'full-retained',public.knowledge_import_cleanup('orphan_scan');
SELECT qa_test.check((SELECT (data->>'visited')::integer=100 AND data->>'done'='false' AND data->'objects'='[]'::jsonb FROM orphan_inventory WHERE stage='full-retained'),'maintenance bounded first page advances over 100 retained objects');
INSERT INTO orphan_inventory SELECT 'next',public.knowledge_import_cleanup('orphan_scan');
SELECT qa_test.check((SELECT data->'objects' @> '[{"key":"gone/cursor-101/original"}]'::jsonb FROM orphan_inventory WHERE stage='next'),'maintenance cursor reaches orphan after full retained page');
SELECT qa_test.check((SELECT data->>'done'='true' AND (data->>'visited')::integer<100 FROM orphan_inventory WHERE stage='next'),'maintenance end of inventory resets bounded cursor');
RESET ROLE;
