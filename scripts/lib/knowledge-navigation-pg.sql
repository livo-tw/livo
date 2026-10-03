-- Isolated fixture database only; all test data and helpers roll back.
BEGIN;
RESET ROLE;
INSERT INTO public.members(id,auth_id,role,job_title,is_active) VALUES
 ('nav-reader','c0100000-0000-0000-0000-000000000001','member','Engineer',true),
 ('nav-admin','c0100000-0000-0000-0000-000000000002','admin','Engineer',true),
 ('nav-super','c0100000-0000-0000-0000-000000000003','super_admin','Engineer',true),
 ('nav-planning','c0100000-0000-0000-0000-000000000004','admin','Planning',true);
CREATE FUNCTION public.nav_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'navigation assertion: %',label; END IF; END$$;
CREATE FUNCTION public.nav_actor(suffix text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
  PERFORM set_config('request.jwt.claim.sub','c0100000-0000-0000-0000-'||suffix,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub','c0100000-0000-0000-0000-'||suffix,'role','authenticated')::text,true);
END$$;
SET LOCAL ROLE authenticated;
SELECT public.nav_actor('000000000004');
INSERT INTO public.kb_pages(id,title,body) VALUES('nav-a','Example guide A','Example'),('nav-b','Example guide B','Example'),('nav-c','Example guide C','Example');
INSERT INTO public.kb_pages(id,title,parent_id) VALUES('nav-child','Example child','nav-a');
SELECT public.nav_actor('000000000001');
SELECT public.nav_assert(public.kb_preferences('pin','nav-a',true,NULL,'tree',0)#>'{items,nav-a}'='{"favorite":true,"pinned":true}'::jsonb,'pin implies favorite');
SELECT public.nav_assert(public.kb_preferences('read')->'pins'='["nav-a"]'::jsonb,'cross-request persistence');
SELECT public.kb_preferences('reorder','nav-b',NULL,'nav-a','tree',1);
SELECT public.nav_assert((public.kb_preferences('read')#>'{orders,"[null,null]"}')->>0='nav-b','same-parent ordering');
SELECT public.kb_preferences('collapse','nav-a',true,NULL,'tree',2);
DO $$BEGIN
  BEGIN PERFORM public.kb_preferences('pin','nav-b',true,NULL,'tree',0); RAISE EXCEPTION 'missing stale rejection';
    EXCEPTION WHEN serialization_failure THEN NULL; END;
  BEGIN PERFORM public.kb_preferences('reorder','nav-child',NULL,'nav-b','tree',3); RAISE EXCEPTION 'missing parent rejection';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM!='kb_invalid_request' THEN RAISE; END IF; END;
  BEGIN PERFORM 1 FROM public.kb_navigation_preferences; RAISE EXCEPTION 'raw identifiers exposed';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END$$;
SELECT public.nav_assert(public.kb_preferences('pin','nav-a',false,NULL,'tree',3)#>'{items,nav-a}'='{"favorite":true,"pinned":false,"collapsed":true}'::jsonb,'unpin preserves favorite');
SELECT public.kb_preferences('pin','nav-a',true,NULL,'tree',4);
SELECT public.nav_assert(public.kb_preferences('favorite','nav-a',false,NULL,'tree',5)->'pins'='[]'::jsonb,'unfavorite unpins');
SELECT public.nav_actor('000000000002');
SELECT public.nav_assert(public.kb_preferences('read')->'items'='{}'::jsonb,'admin cannot inherit another owner preferences');
SELECT public.nav_actor('000000000003');
SELECT public.nav_assert(public.kb_preferences('read')->'items'='{}'::jsonb,'super administrator preferences isolated');
SELECT public.kb_preferences('pin','nav-a',true,NULL,'tree',0);
SELECT public.nav_actor('000000000004');
INSERT INTO public.field_locks(lock_key,locked_by,expires_at) VALUES('kb:nav-a','nav-planning',now()+interval '5 minutes');
UPDATE public.kb_pages SET access_policy='{"mode":"custom","view":{"roles":[],"positions":["Planning"],"member_ids":[]},"edit":{"roles":[],"positions":["Planning"],"member_ids":[]},"comment":{"roles":[],"positions":["Planning"],"member_ids":[]}}' WHERE id='nav-a';
SELECT public.nav_actor('000000000003');
SELECT public.nav_assert(public.kb_preferences('read')->'pins'='[]'::jsonb AND public.kb_preferences('read')->'items'='{}'::jsonb,'revocation hides identifiers even for super administrator');
DO $$BEGIN
  BEGIN PERFORM public.kb_preferences('pin','nav-child',true,NULL,'tree',1); RAISE EXCEPTION 'ancestor bypass';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END$$;
RESET ROLE;
SELECT public.nav_assert((SELECT bool_and(sort_order=0 AND parent_id IS NULL) FROM public.kb_pages WHERE id IN ('nav-a','nav-b','nav-c')),'personal mutations preserved shared sorting and structure');
UPDATE public.members SET is_active=false WHERE id='nav-super';
SET LOCAL ROLE authenticated;
DO $$BEGIN
  BEGIN PERFORM public.kb_preferences('read'); RAISE EXCEPTION 'inactive actor accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END$$;
ROLLBACK;
