-- Fictional fixtures, disposable test database only.
-- Seeded before 20261022_slack_link_preferences.sql.
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',false);
SELECT set_config('request.jwt.claims','{}',false);
-- The real table (20260402_bidirectional_integration.sql) has these columns; the shared fixture omits them.
ALTER TABLE public.external_account_bindings ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE public.external_account_bindings ADD COLUMN IF NOT EXISTS bound_at timestamptz NOT NULL DEFAULT now();
INSERT INTO public.members(id,auth_id,role,is_active,email,name) VALUES
 ('sl-owner','c0400000-0000-0000-0000-000000000001','super_admin',true,'owner@example.com','Example Owner'),
 ('sl-member','c0400000-0000-0000-0000-000000000002','member',true,'member@example.com','Example Member'),
 ('sl-other','c0400000-0000-0000-0000-000000000003','member',true,'other@example.com','Example Other'),
 ('sl-former','c0400000-0000-0000-0000-000000000004','member',false,'former@example.com','Example Former');
INSERT INTO public.external_account_bindings(id,member_id,platform,platform_user_id,platform_team_id,is_verified,verified_by,display_name) VALUES
 ('c0410000-0000-0000-0000-000000000002','sl-member','slack','UMEMBER','TEXAMPLE',true,'email','Example Member'),
 ('c0410000-0000-0000-0000-000000000003','sl-other','slack','UOTHER','TEXAMPLE',true,'email','Example Other'),
 ('c0410000-0000-0000-0000-0000000000f2','sl-member','gitlab','member-gitlab','example',true,'admin',NULL);
-- @@ after migration @@
RESET ROLE;
CREATE FUNCTION qa_test.slack_binding(p_id text) RETURNS public.external_account_bindings LANGUAGE sql STABLE AS $$
  SELECT * FROM public.external_account_bindings WHERE id::text=p_id $$;
CREATE FUNCTION qa_test.as_member(p_auth text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub',p_auth,false), set_config('request.jwt.claims',jsonb_build_object('sub',p_auth)::text,false) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA qa_test TO authenticated,service_role;
SELECT qa_test.check((SELECT count(*)=1 FROM public.livo_schema_migrations WHERE name='20261022_slack_link_preferences.sql'),'upgrade recorded once');

-- A member sees their own state.
SET ROLE authenticated;
SELECT qa_test.as_member('c0400000-0000-0000-0000-000000000002');
SELECT qa_test.check((SELECT public.livo_slack_link_status() @> '{"disabled":false,"mode":"binding","linked":{"display_name":"Example Member","verified_by":"email"}}'),'status shows the email binding');

-- Unlinking suspends only the caller's Slack bindings and keeps the rows.
SELECT qa_test.check((SELECT public.livo_slack_link_set(false) @> '{"disabled":true,"linked":null}'),'unlink reports no linked account');
RESET ROLE;
SELECT qa_test.check((SELECT NOT is_verified AND NOT reconfirm_required FROM qa_test.slack_binding('c0410000-0000-0000-0000-000000000002')),'own Slack binding suspended');
SELECT qa_test.check((SELECT is_verified FROM qa_test.slack_binding('c0410000-0000-0000-0000-000000000003')),'another member keeps theirs');
SELECT qa_test.check((SELECT is_verified FROM qa_test.slack_binding('c0410000-0000-0000-0000-0000000000f2')),'other platforms unaffected');
SELECT qa_test.check((SELECT count(*)=3 FROM public.external_account_bindings WHERE id::text LIKE 'c0410000%'),'no binding deleted');

-- While unlinked nothing can verify the account again: the email match, an owner's mapping, a service write.
SET ROLE service_role;
SELECT qa_test.expect_error('email match cannot bind again',
  $$UPDATE public.external_account_bindings SET is_verified=true,verified_by='email' WHERE id='c0410000-0000-0000-0000-000000000002'$$,'42501','slack_link_disabled');
SELECT qa_test.expect_error('owner mapping cannot bind again',
  $$INSERT INTO public.external_account_bindings(member_id,platform,platform_user_id,platform_team_id,is_verified,verified_by,verified_by_member_id) VALUES('sl-member','slack','UMEMBER2','TEXAMPLE',true,'admin','sl-owner')$$,'42501','slack_link_disabled');
UPDATE public.external_account_bindings SET display_name='Renamed' WHERE id='c0410000-0000-0000-0000-000000000002';
SELECT qa_test.check((SELECT display_name='Renamed' AND NOT is_verified FROM qa_test.slack_binding('c0410000-0000-0000-0000-000000000002')),'unverified edits still allowed');
RESET ROLE;

-- Members cannot change the setting directly, or for someone else.
SET ROLE authenticated;
SELECT qa_test.as_member('c0400000-0000-0000-0000-000000000003');
SELECT qa_test.expect_error('no direct writes',$$INSERT INTO public.slack_link_preferences(member_id,linking_disabled) VALUES('sl-member',false)$$,'42501','permission denied');
SELECT qa_test.check((SELECT count(*)=0 FROM public.slack_link_preferences),'a member reads only their own row');
SELECT qa_test.as_member('c0400000-0000-0000-0000-000000000002');
SELECT qa_test.check((SELECT count(*)=1 FROM public.slack_link_preferences WHERE member_id='sl-member' AND linking_disabled),'the member reads their own row');
-- A former member and an unlinked login cannot use the RPCs.
SELECT qa_test.as_member('c0400000-0000-0000-0000-000000000004');
SELECT qa_test.expect_error('former member refused',$$SELECT public.livo_slack_link_set(true)$$,'42501','slack_link_forbidden');
SELECT qa_test.as_member('c0400000-0000-0000-0000-0000000000ff');
SELECT qa_test.expect_error('unlinked login refused',$$SELECT public.livo_slack_link_status()$$,'42501','slack_link_forbidden');
RESET ROLE;
SET ROLE anon;
SELECT qa_test.expect_error('anonymous refused',$$SELECT public.livo_slack_link_set(true)$$,'42501','permission denied');
RESET ROLE;

-- Allowing it again creates no binding; the next Slack action proves the email again.
SET ROLE authenticated;
SELECT qa_test.as_member('c0400000-0000-0000-0000-000000000002');
SELECT qa_test.check((SELECT public.livo_slack_link_set(true) @> '{"disabled":false,"linked":null}'),'relink leaves the binding to the next email match');
RESET ROLE;
SET ROLE service_role;
UPDATE public.external_account_bindings SET is_verified=true,verified_by='email' WHERE id='c0410000-0000-0000-0000-000000000002';
SELECT qa_test.check((SELECT is_verified FROM qa_test.slack_binding('c0410000-0000-0000-0000-000000000002')),'email match binds again after relinking');
RESET ROLE;

-- Re-running the migration keeps every choice.
SET ROLE authenticated;
SELECT qa_test.as_member('c0400000-0000-0000-0000-000000000003');
SELECT public.livo_slack_link_set(false);
RESET ROLE;
-- @@ reapply migration @@
SELECT qa_test.check((SELECT linking_disabled FROM public.slack_link_preferences WHERE member_id='sl-other'),'re-run keeps an unlink');
SELECT qa_test.check((SELECT NOT linking_disabled FROM public.slack_link_preferences WHERE member_id='sl-member'),'re-run keeps a relink');
-- Removing a member removes their setting with them.
DELETE FROM public.members WHERE id='sl-other';
SELECT qa_test.check((SELECT count(*)=0 FROM public.slack_link_preferences WHERE member_id='sl-other'),'setting follows the member');
