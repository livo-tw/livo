-- Run after fixture + original KB migration + new permissions migration twice.
BEGIN;
CREATE FUNCTION public.kb_test_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERT: %',label; END IF; END$$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',true) IS NOT NULL;
INSERT INTO public.kb_pages(id,title,body,access_policy) VALUES ('pm-root','Private meeting','Sensitive body','{"mode":"custom","view":{"roles":[],"positions":["PM"],"member_ids":[]},"edit":{"roles":[],"positions":["PM"],"member_ids":[]},"comment":{"roles":[],"positions":["PM"],"member_ids":[]}}');
INSERT INTO public.kb_pages(id,title,body,parent_id,category) VALUES ('pm-child','Child meeting','Child sensitive body','pm-root','meeting');
INSERT INTO public.kb_pages(id,title) VALUES ('ordinary','Open guide');
INSERT INTO public.field_locks VALUES ('kb:pm-root','pm-admin',now()+interval '30 seconds');
UPDATE public.kb_pages SET body='Updated sensitive body' WHERE id='pm-root';
DELETE FROM public.field_locks WHERE lock_key='kb:pm-root';
INSERT INTO public.kb_comments(id,page_id,body) VALUES ('secret-comment','pm-child','Sensitive discussion');
INSERT INTO public.kb_attachments(id,page_id,file_name,file_size,storage_path) VALUES ('secret-file','pm-child','meeting.pdf',10,'kb/pm-child/meeting.pdf');
INSERT INTO storage.objects(bucket_id,name) VALUES ('kb-files','kb/pm-child/meeting.pdf');
SELECT public.kb_test_assert((SELECT NOT public FROM storage.buckets WHERE id='kb-files'),'private bucket');

-- All three system roles must be denied if no role/position/member grant matches.
DO $$DECLARE user_id text; BEGIN FOREACH user_id IN ARRAY ARRAY['10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004'] LOOP
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',user_id,'role','authenticated')::text,true);
 PERFORM public.kb_test_assert((SELECT count(*)=0 FROM public.kb_pages WHERE id LIKE 'pm-%'),'hidden titles/body');
 PERFORM public.kb_test_assert((SELECT count(*)=0 FROM public.kb_revisions),'hidden history');
 PERFORM public.kb_test_assert((SELECT count(*)=0 FROM public.kb_comments),'hidden comments');
 PERFORM public.kb_test_assert((SELECT count(*)=0 FROM public.kb_attachments),'hidden attachments');
 PERFORM public.kb_test_assert((SELECT count(*)=0 FROM storage.objects WHERE bucket_id='kb-files'),'hidden storage despite broad policy');
 PERFORM public.kb_test_assert(NOT public.kb_has_permission('pm-child','view'),'inherited view deny');
 PERFORM public.kb_test_assert((SELECT count(*)=1 FROM public.kb_pages WHERE id='ordinary'),'ordinary default retained');
 BEGIN INSERT INTO public.kb_comments(page_id,body) VALUES ('pm-child','forged'); RAISE EXCEPTION 'ASSERT unauthorized comment'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'kb_forbidden%' THEN RAISE; END IF; WHEN insufficient_privilege THEN NULL; END;
 BEGIN INSERT INTO public.field_locks VALUES ('kb:pm-child',public.current_member_id(),now()+interval '30 seconds'); RAISE EXCEPTION 'ASSERT unauthorized lock'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'kb_forbidden%' THEN RAISE; END IF; END;
END LOOP; END$$;
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000005","role":"authenticated"}',true) IS NOT NULL;
SELECT public.kb_test_assert((SELECT count(*)=2 FROM public.kb_pages WHERE id LIKE 'pm-%'),'PM reads parent and child');
SELECT public.kb_test_assert((SELECT count(*)=1 FROM public.kb_revisions),'PM reads history');
INSERT INTO public.kb_comments(id,page_id,body,created_by) VALUES ('own-comment','pm-child','Confirmed action','forged-author');
SELECT public.kb_test_assert((SELECT created_by='pm-member' FROM public.kb_comments WHERE id='own-comment'),'author enforced');
INSERT INTO public.field_locks VALUES ('kb:pm-child','pm-member',now()+interval '30 seconds');
DO $$BEGIN
 BEGIN UPDATE public.kb_pages SET parent_id=NULL WHERE id='pm-child'; RAISE EXCEPTION 'ASSERT parent escape'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'kb_forbidden%' THEN RAISE; END IF; END;
 BEGIN UPDATE public.kb_pages SET access_policy='{"mode":"inherit"}' WHERE id='pm-root'; RAISE EXCEPTION 'ASSERT ACL escape'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'kb_forbidden%' THEN RAISE; END IF; END;
END$$;
DELETE FROM public.field_locks WHERE lock_key='kb:pm-child';
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',true) IS NOT NULL;
INSERT INTO public.kb_pages(id,title,access_policy) VALUES ('mixed-grants','Role and named member','{"mode":"custom","view":{"roles":["admin"],"positions":[],"member_ids":["engineer"]},"edit":{"roles":[],"positions":["PM"],"member_ids":[]},"comment":{"roles":[],"positions":[],"member_ids":["engineer"]}}');
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated"}',true) IS NOT NULL;
SELECT public.kb_test_assert(public.kb_has_permission('mixed-grants','view') AND public.kb_has_permission('mixed-grants','comment') AND NOT public.kb_has_permission('mixed-grants','edit'),'named member can comment but not edit');
INSERT INTO public.kb_comments(page_id,body) VALUES ('mixed-grants','Named member permitted');
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000003","role":"authenticated"}',true) IS NOT NULL;
SELECT public.kb_test_assert(public.kb_has_permission('mixed-grants','view') AND NOT public.kb_has_permission('mixed-grants','comment') AND NOT public.kb_has_permission('mixed-grants','edit'),'role grant view only');
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000005","role":"authenticated"}',true) IS NOT NULL;
SELECT public.kb_test_assert(NOT public.kb_has_permission('mixed-grants','view') AND NOT public.kb_has_permission('mixed-grants','edit'),'edit selector cannot override missing view');
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated"}',true) IS NOT NULL;
SELECT public.kb_test_assert(NOT public.kb_has_permission('mixed-grants','view'),'admin role grant does not imply superadmin grant');
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000006","role":"authenticated"}',true) IS NOT NULL;
SELECT public.kb_test_assert((SELECT count(*)=0 FROM public.kb_pages),'inactive denied');
DO $$BEGIN
 BEGIN INSERT INTO public.kb_pages(id,title) VALUES ('inactive-created','Should fail'); RAISE EXCEPTION 'ASSERT inactive insert'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'kb_forbidden%' THEN RAISE; END IF; END;
END$$;
RESET ROLE;
SELECT set_config('request.jwt.claims','',true) IS NOT NULL;
UPDATE public.members SET job_title='Engineer' WHERE id='pm-member';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000005","role":"authenticated"}',true) IS NOT NULL;
SELECT public.kb_test_assert((SELECT count(*)=0 FROM public.kb_comments),'live position revocation');
RESET ROLE;
SELECT public.kb_test_assert((SELECT bool_and(relreplident='d') FROM pg_class WHERE relname IN ('kb_pages','kb_comments','kb_revisions','kb_attachments')),'realtime old payloads limited to primary key');
SELECT set_config('request.jwt.claims','',true) IS NOT NULL;
INSERT INTO public.members(id,role,job_title,email) VALUES ('self-link','member','Engineer','self@example.com');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000003","role":"authenticated"}',true) IS NOT NULL;
DO $$BEGIN
 BEGIN UPDATE public.members SET job_title='PM' WHERE id='engineer'; RAISE EXCEPTION 'ASSERT admin position grant'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE public.members SET auth_id=auth.uid() WHERE id='engineer'; RAISE EXCEPTION 'ASSERT admin login takeover'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN UPDATE public.members SET auth_id=auth.uid() WHERE id='self-link'; RAISE EXCEPTION 'ASSERT unclaimed login takeover'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END$$;
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000007","email":"self@example.com","role":"authenticated"}',true) IS NOT NULL;
UPDATE public.members SET auth_id=auth.uid() WHERE id='self-link';
SELECT public.kb_test_assert(public.current_member_id()='self-link','verified email first-login self-link retained');
DO $$BEGIN
 BEGIN UPDATE public.members SET auth_id='10000000-0000-0000-0000-000000000002' WHERE id='self-link'; RAISE EXCEPTION 'ASSERT wrong self identity'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END$$;
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated"}',true) IS NOT NULL;
UPDATE public.members SET job_title='PM' WHERE id='engineer';
SELECT public.kb_test_assert((SELECT job_title='PM' FROM public.members WHERE id='engineer'),'superadmin manages positions');
RESET ROLE;
ROLLBACK;
SELECT 'Knowledge PostgreSQL security assertions passed' AS result;
