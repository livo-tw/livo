-- Fictional fixtures, disposable test database only.
-- Seeded before 20261027_slack_delivery_settings_owner.sql.
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','',false);
SELECT set_config('request.jwt.claims','{}',false);
INSERT INTO public.members(id,auth_id,role,is_active,email,name) VALUES
 ('sd-owner','c0500000-0000-0000-0000-000000000001','super_admin',true,'owner@example.com','Example Owner'),
 ('sd-admin','c0500000-0000-0000-0000-000000000002','admin',true,'admin@example.com','Example Admin'),
 ('sd-member','c0500000-0000-0000-0000-000000000003','member',true,'member@example.com','Example Member'),
 ('sd-former','c0500000-0000-0000-0000-000000000004','super_admin',false,'former@example.com','Example Former');
INSERT INTO public.system_settings(key,value) VALUES
 ('slack_delivery','{"enabled":true,"teamId":"TEXAMPLE","dmEnabled":true,"routes":[{"lineId":"line-example","channelId":"CTASK"}]}')
 ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;
-- @@ after migration @@
RESET ROLE;
CREATE FUNCTION qa_test.as_member(p_auth text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub',p_auth,false), set_config('request.jwt.claims',jsonb_build_object('sub',p_auth)::text,false) $$;
CREATE FUNCTION qa_test.delivery() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT value FROM public.system_settings WHERE key='slack_delivery' $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA qa_test TO authenticated,service_role;
SELECT qa_test.check((SELECT count(*)=1 FROM public.livo_schema_migrations WHERE name='20261027_slack_delivery_settings_owner.sql'),'upgrade recorded once');
SELECT qa_test.check((SELECT count(*)=1 FROM pg_trigger WHERE tgname='livo_guard_slack_delivery_setting' AND NOT tgisinternal),'one guard trigger after two runs');

-- Admins and members cannot change Slack delivery, whatever the table grants say.
SET ROLE authenticated;
SELECT qa_test.as_member('c0500000-0000-0000-0000-000000000002');
SELECT qa_test.expect_error('admin cannot turn personal messages off',
  $$UPDATE public.system_settings SET value=value||'{"dmEnabled":false}' WHERE key='slack_delivery'$$,'42501','slack_delivery_settings_forbidden');
SELECT qa_test.expect_error('admin cannot delete the setting',
  $$DELETE FROM public.system_settings WHERE key='slack_delivery'$$,'42501','slack_delivery_settings_forbidden');
SELECT qa_test.expect_error('admin cannot rename it away',
  $$UPDATE public.system_settings SET key='slack_delivery_x' WHERE key='slack_delivery'$$,'42501','slack_delivery_settings_forbidden');
SELECT qa_test.expect_error('admin cannot insert it under another row',
  $$UPDATE public.system_settings SET key='slack_delivery' WHERE key='feature_toggles'$$,'42501','slack_delivery_settings_forbidden');
SELECT qa_test.as_member('c0500000-0000-0000-0000-000000000003');
SELECT qa_test.expect_error('member cannot change routes',
  $$UPDATE public.system_settings SET value=value||'{"routes":[]}' WHERE key='slack_delivery'$$,'42501','slack_delivery_settings_forbidden');
SELECT qa_test.as_member('c0500000-0000-0000-0000-000000000004');
SELECT qa_test.expect_error('deactivated super_admin cannot change it',
  $$UPDATE public.system_settings SET value=value||'{"dmEnabled":false}' WHERE key='slack_delivery'$$,'42501','slack_delivery_settings_forbidden');
SELECT set_config('request.jwt.claim.sub','',false); SELECT set_config('request.jwt.claims','{}',false);
SELECT qa_test.expect_error('no login cannot change it',
  $$UPDATE public.system_settings SET value=value||'{"dmEnabled":false}' WHERE key='slack_delivery'$$,'42501','slack_delivery_settings_forbidden');
-- Other settings keep their old rules.
SELECT qa_test.as_member('c0500000-0000-0000-0000-000000000002');
UPDATE public.system_settings SET value=value||'{"approvals":true}' WHERE key='feature_toggles';
SELECT qa_test.check((SELECT value->'approvals'='true'::jsonb FROM public.system_settings WHERE key='feature_toggles'),'admin still changes other settings');
SELECT qa_test.check((SELECT qa_test.delivery()->'dmEnabled'='true'::jsonb),'slack_delivery unchanged by refused writes');

-- A super_admin changes it; malformed personal-message settings are refused.
SELECT qa_test.as_member('c0500000-0000-0000-0000-000000000001');
UPDATE public.system_settings SET value=value||'{"dmEnabled":true,"dmMemberIds":["sd-member","sd-admin"]}' WHERE key='slack_delivery';
SELECT qa_test.check((SELECT qa_test.delivery()->'dmMemberIds'='["sd-member","sd-admin"]'::jsonb),'super_admin limits personal messages to a list');
UPDATE public.system_settings SET value=value-'dmMemberIds' WHERE key='slack_delivery';
SELECT qa_test.check((SELECT NOT (qa_test.delivery() ? 'dmMemberIds')),'super_admin removes the list');
SELECT qa_test.check((SELECT qa_test.delivery()->'routes'->0->>'channelId'='CTASK'),'routes kept');
SELECT qa_test.expect_error('dmEnabled must be a boolean',
  $$UPDATE public.system_settings SET value=value||'{"dmEnabled":"yes"}' WHERE key='slack_delivery'$$,'22023','invalid_slack_delivery_settings');
SELECT qa_test.expect_error('dmMemberIds must be an array',
  $$UPDATE public.system_settings SET value=value||'{"dmMemberIds":"sd-member"}' WHERE key='slack_delivery'$$,'22023','invalid_slack_delivery_settings');
SELECT qa_test.expect_error('dmMemberIds holds ids only',
  $$UPDATE public.system_settings SET value=value||'{"dmMemberIds":["sd-member",3]}' WHERE key='slack_delivery'$$,'22023','invalid_slack_delivery_settings');
SELECT qa_test.expect_error('the value stays an object',
  $$UPDATE public.system_settings SET value='[]' WHERE key='slack_delivery'$$,'22023','invalid_slack_delivery_settings');
SELECT qa_test.expect_error('the key cannot be renamed',
  $$UPDATE public.system_settings SET key='slack_delivery_old' WHERE key='slack_delivery'$$,'22023','slack_delivery_setting_key_immutable');
RESET ROLE;

-- The delivery service and SQL maintenance are not members.
SET ROLE service_role;
UPDATE public.system_settings SET value=value||'{"dmEnabled":false}' WHERE key='slack_delivery';
SELECT qa_test.check((SELECT qa_test.delivery()->'dmEnabled'='false'::jsonb),'service role may write');
RESET ROLE;
UPDATE public.system_settings SET value=value||'{"dmEnabled":true}' WHERE key='slack_delivery';
SELECT qa_test.check((SELECT qa_test.delivery()->'dmEnabled'='true'::jsonb),'superuser maintenance may write');
