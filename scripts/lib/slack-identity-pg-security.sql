-- Fictional fixtures, disposable test database only.
-- Seeded before 20261017_slack_admin_binding_issuer.sql to exercise the backfill.
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',false);
SELECT set_config('request.jwt.claims','{}',false);
INSERT INTO public.members(id,auth_id,role,is_active,email,name) VALUES
 ('si-owner','c0300000-0000-0000-0000-000000000001','super_admin',true,'owner@example.com','Example Owner'),
 ('si-admin','c0300000-0000-0000-0000-000000000002','admin',true,'admin@example.com','Example Admin'),
 ('si-trusted','c0300000-0000-0000-0000-000000000003','member',true,'trusted@example.com','Example Trusted'),
 ('si-plain','c0300000-0000-0000-0000-000000000004','member',true,'plain@example.com','Example Plain'),
 ('si-legacy','c0300000-0000-0000-0000-000000000005','member',true,'legacy@example.com','Example Legacy'),
 ('si-email','c0300000-0000-0000-0000-000000000006','member',true,'email@example.com','Example Email'),
 ('si-owner2','c0300000-0000-0000-0000-000000000007','super_admin',true,'owner2@example.com','Example Owner Two'),
 ('si-later','c0300000-0000-0000-0000-000000000008','member',true,'later@example.com','Example Later'),
 ('si-owner3','c0300000-0000-0000-0000-000000000009','super_admin',true,'owner3@example.com','Example Owner Three'),
 ('si-gone','c0300000-0000-0000-0000-00000000000a','member',true,'gone@example.com','Example Gone');
INSERT INTO public.external_account_bindings(id,member_id,platform,platform_user_id,platform_team_id,is_verified,verified_by,verified_by_member_id) VALUES
 ('c0310000-0000-0000-0000-000000000003','si-trusted','slack','UTRUSTED','TEXAMPLE',true,'admin','si-owner'),
 ('c0310000-0000-0000-0000-000000000004','si-plain','slack','UPLAIN','TEXAMPLE',true,'admin','si-admin'),
 ('c0310000-0000-0000-0000-000000000005','si-legacy','slack','ULEGACY','TEXAMPLE',true,'admin',NULL),
 ('c0310000-0000-0000-0000-000000000006','si-email','slack','UEMAIL','TEXAMPLE',true,'email',NULL),
 ('c0310000-0000-0000-0000-000000000008','si-later','slack','ULATER','TEXAMPLE',true,'admin','si-owner2'),
 ('c0310000-0000-0000-0000-00000000000a','si-gone','slack','UGONE','TEXAMPLE',true,'admin','si-owner3'),
 ('c0310000-0000-0000-0000-0000000000f1','si-plain','gitlab','plain-gitlab','example',true,'admin',NULL);
-- @@ after migration @@
RESET ROLE;
CREATE FUNCTION qa_test.binding(p_id text) RETURNS public.external_account_bindings LANGUAGE sql STABLE AS $$
  SELECT * FROM public.external_account_bindings WHERE id::text=p_id $$;
CREATE FUNCTION qa_test.session(p_auth text,p_binding text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub',p_auth,false);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('livo_slack_binding',p_binding)::text,false);
  RETURN public.livo_slack_session();
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA qa_test TO authenticated,service_role;
GRANT SELECT ON public.external_account_bindings TO service_role;

-- Backfill: untrusted manual mappings are suspended, never deleted.
SELECT qa_test.check((SELECT NOT is_verified AND reconfirm_required AND verified_by='admin' AND verified_by_member_id='si-admin' FROM qa_test.binding('c0310000-0000-0000-0000-000000000004')),'plain-admin mapping suspended with issuer kept');
SELECT qa_test.check((SELECT NOT is_verified AND reconfirm_required AND verified_by='admin' FROM qa_test.binding('c0310000-0000-0000-0000-000000000005')),'legacy mapping without issuer suspended');
SELECT qa_test.check((SELECT is_verified AND NOT reconfirm_required FROM qa_test.binding('c0310000-0000-0000-0000-000000000003')),'owner-made mapping stays verified');
SELECT qa_test.check((SELECT is_verified AND NOT reconfirm_required FROM qa_test.binding('c0310000-0000-0000-0000-000000000006')),'email binding unaffected');
SELECT qa_test.check((SELECT is_verified FROM qa_test.binding('c0310000-0000-0000-0000-0000000000f1')),'other platforms unaffected');
SELECT qa_test.check((SELECT count(*)=7 FROM public.external_account_bindings WHERE id::text LIKE 'c0310000%'),'no binding deleted');
SELECT qa_test.check((SELECT count(*)=1 FROM public.livo_schema_migrations WHERE name='20261017_slack_admin_binding_issuer.sql'),'upgrade recorded once');

-- livo_slack_session (Slack commit/update RPCs, thread mappings, outbox triggers).
SET ROLE authenticated;
SELECT qa_test.check(qa_test.session('c0300000-0000-0000-0000-000000000003','c0310000-0000-0000-0000-000000000003'),'session accepts owner-made mapping');
SELECT qa_test.check(NOT qa_test.session('c0300000-0000-0000-0000-000000000004','c0310000-0000-0000-0000-000000000004'),'session refuses plain-admin mapping');
SELECT qa_test.check(NOT qa_test.session('c0300000-0000-0000-0000-000000000005','c0310000-0000-0000-0000-000000000005'),'session refuses legacy mapping');

-- kb_slack_search keeps its own rule and agrees.
SELECT set_config('request.jwt.claim.sub','c0300000-0000-0000-0000-000000000004',false);
SELECT set_config('request.jwt.claims','{"livo_slack_binding":"c0310000-0000-0000-0000-000000000004"}',false);
SELECT qa_test.expect_error('knowledge search refuses plain-admin mapping',$$SELECT public.kb_slack_search('Example')$$,'42501','knowledge_search_forbidden');
SELECT set_config('request.jwt.claim.sub','c0300000-0000-0000-0000-000000000003',false);
SELECT set_config('request.jwt.claims','{"livo_slack_binding":"c0310000-0000-0000-0000-000000000003"}',false);
SELECT qa_test.check(jsonb_typeof(public.kb_slack_search('Example')->'pages')='array','knowledge search accepts owner-made mapping');
SELECT set_config('request.jwt.claims','{}',false);

-- Service-only identity checks used by /livo docs|specs|drafts and QA commands.
RESET ROLE;
SET ROLE service_role;
SELECT qa_test.expect_error('private drafts refuse plain-admin mapping',
  $$SELECT public.kb_work_identity('c0300000-0000-0000-0000-000000000004','{"bindingId":"c0310000-0000-0000-0000-000000000004","teamId":"TEXAMPLE","userId":"UPLAIN"}')$$,'42501','knowledge_forbidden');
SELECT qa_test.expect_error('private drafts refuse legacy mapping',
  $$SELECT public.kb_work_identity('c0300000-0000-0000-0000-000000000005','{"bindingId":"c0310000-0000-0000-0000-000000000005","teamId":"TEXAMPLE","userId":"ULEGACY"}')$$,'42501','knowledge_forbidden');
SELECT qa_test.check(public.kb_work_identity('c0300000-0000-0000-0000-000000000003','{"bindingId":"c0310000-0000-0000-0000-000000000003","teamId":"TEXAMPLE","userId":"UTRUSTED"}')='si-trusted','private drafts accept owner-made mapping');
SELECT qa_test.check(public.kb_work_identity('c0300000-0000-0000-0000-000000000006','{"bindingId":"c0310000-0000-0000-0000-000000000006","teamId":"TEXAMPLE","userId":"UEMAIL"}')='si-email','private drafts accept email binding');
SELECT qa_test.expect_error('QA command refuses plain-admin mapping',
  $$SELECT public.livo_qa_live_actor('c0300000-0000-0000-0000-000000000004','{"bindingId":"c0310000-0000-0000-0000-000000000004","teamId":"TEXAMPLE","userId":"UPLAIN"}')$$,'42501','qa_forbidden');
SELECT qa_test.check(public.livo_qa_live_actor('c0300000-0000-0000-0000-000000000003','{"bindingId":"c0310000-0000-0000-0000-000000000003","teamId":"TEXAMPLE","userId":"UTRUSTED"}')='si-trusted','QA command accepts owner-made mapping');

-- Write guard: a manual mapping can be stored as verified only with an active owner as issuer.
INSERT INTO public.external_account_bindings(id,member_id,platform,platform_user_id,platform_team_id,is_verified,verified_by,verified_by_member_id) VALUES
 ('c0310000-0000-0000-0000-0000000000b1','si-admin','slack','UFORGED','TEXAMPLE',true,'admin','si-admin');
SELECT qa_test.check((SELECT NOT is_verified AND reconfirm_required FROM qa_test.binding('c0310000-0000-0000-0000-0000000000b1')),'service write of untrusted mapping is stored suspended');
UPDATE public.external_account_bindings SET is_verified=true WHERE id='c0310000-0000-0000-0000-000000000005';
SELECT qa_test.check((SELECT NOT is_verified AND reconfirm_required FROM qa_test.binding('c0310000-0000-0000-0000-000000000005')),'re-verifying without an owner stays suspended');
-- An owner maps the account again (slack-actions-config bind).
UPDATE public.external_account_bindings SET is_verified=true,verified_by='admin',verified_by_member_id='si-owner' WHERE id='c0310000-0000-0000-0000-000000000004';
SELECT qa_test.check((SELECT is_verified AND NOT reconfirm_required FROM qa_test.binding('c0310000-0000-0000-0000-000000000004')),'owner re-mapping restores the binding');
-- Slack email proves identity again (slack-interact actor upsert).
UPDATE public.external_account_bindings SET is_verified=true,verified_by='email' WHERE id='c0310000-0000-0000-0000-000000000005';
SELECT qa_test.check((SELECT is_verified AND NOT reconfirm_required FROM qa_test.binding('c0310000-0000-0000-0000-000000000005')),'email re-verification clears the hint');
-- Unbind keeps the row without the hint.
UPDATE public.external_account_bindings SET is_verified=false,reconfirm_required=false WHERE id='c0310000-0000-0000-0000-0000000000b1';
SELECT qa_test.check((SELECT NOT is_verified AND NOT reconfirm_required FROM qa_test.binding('c0310000-0000-0000-0000-0000000000b1')),'unbind clears the hint');
RESET ROLE;

-- Re-running the migration after owners re-mapped keeps their work.
-- @@ reapply migration @@
SELECT qa_test.check((SELECT is_verified AND NOT reconfirm_required FROM qa_test.binding('c0310000-0000-0000-0000-000000000004')),'re-run keeps an owner re-mapping');
SELECT qa_test.check((SELECT is_verified FROM qa_test.binding('c0310000-0000-0000-0000-000000000005')),'re-run keeps an email re-verification');
SELECT qa_test.check((SELECT NOT is_verified AND NOT reconfirm_required FROM qa_test.binding('c0310000-0000-0000-0000-0000000000b1')),'re-run keeps an unbind');

-- Members still cannot write Slack bindings or the new column.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','c0300000-0000-0000-0000-000000000004',false);
SELECT qa_test.expect_error('member cannot clear the hint',$$UPDATE public.external_account_bindings SET reconfirm_required=false WHERE member_id='si-plain'$$,'42501','managed by the server');
RESET ROLE;

-- Owner changes take effect in the same transaction, even through the member API role.
GRANT UPDATE(role,is_active,job_title) ON public.members TO authenticated;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','c0300000-0000-0000-0000-000000000001',false);
UPDATE public.members SET job_title='Owner' WHERE id='si-owner2';
SELECT qa_test.check((SELECT is_verified FROM qa_test.binding('c0310000-0000-0000-0000-000000000008')),'unrelated member edit keeps mappings');
UPDATE public.members SET role='admin' WHERE id='si-owner2';
SELECT qa_test.check((SELECT NOT is_verified AND reconfirm_required FROM qa_test.binding('c0310000-0000-0000-0000-000000000008')),'demoting the owner suspends their mappings');
SELECT qa_test.check(NOT qa_test.session('c0300000-0000-0000-0000-000000000008','c0310000-0000-0000-0000-000000000008'),'session refuses mapping of a demoted owner');
UPDATE public.members SET is_active=false WHERE id='si-owner';
SELECT qa_test.check((SELECT bool_and(NOT is_verified AND reconfirm_required) FROM public.external_account_bindings WHERE id IN ('c0310000-0000-0000-0000-000000000003','c0310000-0000-0000-0000-000000000004')),'deactivating the owner suspends their mappings');
SELECT qa_test.check((SELECT is_verified FROM qa_test.binding('c0310000-0000-0000-0000-000000000006')),'owner changes leave email bindings');
UPDATE public.members SET is_active=true WHERE id='si-owner';
SELECT qa_test.check((SELECT NOT is_verified FROM qa_test.binding('c0310000-0000-0000-0000-000000000003')),'reactivation needs an explicit re-mapping');
RESET ROLE;
DELETE FROM public.members WHERE id='si-owner3';
SELECT qa_test.check((SELECT NOT is_verified AND reconfirm_required FROM qa_test.binding('c0310000-0000-0000-0000-00000000000a')),'removing the owner suspends their mappings');
SET ROLE service_role;
SELECT qa_test.expect_error('QA command refuses mapping of a deactivated owner',
  $$SELECT public.livo_qa_live_actor('c0300000-0000-0000-0000-000000000003','{"bindingId":"c0310000-0000-0000-0000-000000000003","teamId":"TEXAMPLE","userId":"UTRUSTED"}')$$,'42501','qa_forbidden');
SELECT qa_test.expect_error('private drafts refuse mapping of a removed owner',
  $$SELECT public.kb_work_identity('c0300000-0000-0000-0000-00000000000a','{"bindingId":"c0310000-0000-0000-0000-00000000000a","teamId":"TEXAMPLE","userId":"UGONE"}')$$,'42501','knowledge_forbidden');
RESET ROLE;
SELECT qa_test.check(NOT has_function_privilege('authenticated','public.livo_slack_suspend_untrusted_bindings()','EXECUTE'),'suspension function is not callable by members');
