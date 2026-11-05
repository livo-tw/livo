export function addAuthRecoveryCases({ cases, check, error, admin, quote, json, migrations }) {
  const requestId = '00000000-0000-4000-8000-000000000021';
  const conflictId = '00000000-0000-4000-8000-000000000022';
  const loginId = '00000000-0000-4000-8000-000000000031';
  const conflictAuth = '00000000-0000-4000-8000-000000000032';
  const q = quote;
  const reg = action => 'public.livo_external_qa_registration(p_admin_auth=>' + admin
    + ',p_action=>' + q(action) + ',p_registration_id=>' + q(requestId) + '::uuid';
  const reserve = (id, email, name = 'Recovery example') =>
    'public.livo_external_qa_registration(p_admin_auth=>' + admin + ",p_action=>'reserve',p_request_id=>"
    + q(id) + '::uuid,p_name=>' + q(name) + ',p_email=>' + q(email)
    + ",p_active=>true,p_project_ids=>ARRAY['p-test'])";
  const metadata = "raw_app_meta_data->>'livo_external_qa_password_change_required'";
  const uid = q(loginId) + '::uuid';
  const aid = "(SELECT account_id FROM public.external_qa_registrations WHERE id=" + q(requestId) + '::uuid)';
  const revision = '(SELECT revision FROM public.external_qa_accounts WHERE id=' + aid + ')';
  const recovery = (version = revision, password = 'Example-password-9') => reg('recover')
    + ',p_account_id=>' + aid + ',p_revision=>' + version + ',p_initial_password=>' + q(password) + ')';
  cases.push('RESET ROLE;');
  check('reserves a new registration before creating a login', reserve(requestId, 'recovery@example.com') + "->>'authRequired'='true'");
  check('same registration retry does not create another identity', reserve(requestId, 'recovery@example.com') + "->>'authRequired'='false'");
  error('retry cannot change the reserved payload', 'SELECT ' + reserve(requestId, 'recovery@example.com', 'Changed name'), 'PT409', 'external_qa_stale');
  check('reserves a second synthetic identity', reserve(conflictId, 'unrelated@example.com') + "->>'authRequired'='true'");
  cases.push("INSERT INTO auth.users(id,email,encrypted_password) VALUES(" + q(conflictAuth)
    + "::uuid,'unrelated@example.com','unrelated-hash');");
  error('email alone never adopts an existing login', "SELECT public.livo_external_qa_registration(p_admin_auth=>"
    + admin + ",p_action=>'reconcile',p_registration_id=>" + q(conflictId) + '::uuid)', 'PT409', 'external_qa_email_in_use');
  check('unrelated login remained outside the external account table',
    "NOT EXISTS(SELECT 1 FROM public.external_qa_accounts WHERE auth_id=" + q(conflictAuth) + '::uuid)');
  cases.push("INSERT INTO auth.users(id,email,encrypted_password,raw_app_meta_data,raw_user_meta_data) SELECT "
    + uid + ",'recovery@example.com','original-hash',jsonb_build_object('livo_external_qa',true,"
    + "'livo_external_qa_registration',id::text,'livo_external_qa_nonce',nonce::text),"
    + "'{\"livo_password_change_required\":true}'::jsonb FROM public.external_qa_registrations WHERE id=" + q(requestId) + '::uuid;');
  check('new external login receives a server-owned initial gate',
    '(SELECT ' + metadata + "='true' AND raw_user_meta_data->>'livo_password_change_required'='true' FROM auth.users WHERE id=" + uid + ')');
  check('only the exact reserved login reconciles into a granted account',
    reg('reconcile') + ")->'account'->>'id'=" + aid);
  check('pending initial credential is explicitly recoverable',
    "EXISTS(SELECT 1 FROM jsonb_array_elements(public.livo_external_qa_registration_list(" + admin
      + ")) a WHERE a->>'id'=" + aid + " AND a->>'credentialRecoveryAvailable'='true')");
  cases.push("UPDATE auth.users SET raw_user_meta_data='{\"livo_password_change_required\":false}' WHERE id=" + uid + ';');
  check('user-editable metadata alone cannot clear either initial gate',
    '(SELECT ' + metadata + "='true' AND raw_user_meta_data->>'livo_password_change_required'='true' FROM auth.users WHERE id=" + uid + ')');
  cases.push("UPDATE auth.users SET encrypted_password='hash-rekey-only' WHERE id=" + uid + ';');
  check('hash rotation alone does not count as onboarding',
    '(SELECT ' + metadata + "='true' FROM auth.users WHERE id=" + uid + ')');
  error('recovery checks the exact account revision', 'SELECT ' + recovery('999'), 'PT409', 'external_qa_stale');
  error('recovery enforces the UTF8 password byte limit', 'SELECT ' + recovery(revision, '界'.repeat(25)), '22023', 'external_qa_invalid_password');
  cases.push('INSERT INTO auth.sessions(id,user_id) VALUES(gen_random_uuid(),' + uid + ');',
    "INSERT INTO auth.refresh_tokens(id,user_id) VALUES(1," + q(loginId) + ');');
  check('explicit recovery reissues only the never-onboarded credential', recovery() + "->'account'->>'credentialRecoveryAvailable'='true'");
  check('reissued credentials retain mandatory first password change',
    '(SELECT ' + metadata + "='true' AND raw_user_meta_data->>'livo_password_change_required'='true' FROM auth.users WHERE id=" + uid + ')');
  check('reissue invalidates old login sessions and refresh tokens',
    'NOT EXISTS(SELECT 1 FROM auth.sessions WHERE user_id=' + uid + ') AND NOT EXISTS(SELECT 1 FROM auth.refresh_tokens WHERE user_id=' + q(loginId) + ')');
  check('reissued credential is actually the requested password',
    "(SELECT encrypted_password=extensions.crypt('Example-password-9',encrypted_password) FROM auth.users WHERE id=" + uid + ')');
  const audit = actorId => "INSERT INTO auth.audit_log_entries(payload) VALUES("
    + json({ action: 'user_updated_password', actor_id: actorId }) + ");";
  cases.push(audit(loginId));
  check('password audit alone cannot clear a gate without a same-transaction hash write',
    '(SELECT ' + metadata + "='true' FROM auth.users WHERE id=" + uid + ')');
  cases.push('BEGIN;', "UPDATE auth.users SET encrypted_password='another-rekey-only' WHERE id=" + uid + ';',
    audit(conflictAuth));
  check('password audit for another actor cannot consume the hash-write marker',
    '(SELECT ' + metadata + "='true' FROM auth.users WHERE id=" + uid + ')');
  cases.push('COMMIT;', "UPDATE auth.users SET raw_user_meta_data='{\"livo_password_change_required\":false}' WHERE id=" + uid + ';');
  check('metadata-only request after a committed rekey cannot complete onboarding',
    '(SELECT ' + metadata + "='true' AND raw_user_meta_data->>'livo_password_change_required'='true' FROM auth.users WHERE id=" + uid + ')');
  cases.push('BEGIN;', 'SELECT ' + recovery() + ';', audit(loginId));
  check('administrative reissue does not make a later audit event prove onboarding',
    '(SELECT ' + metadata + "='true' FROM auth.users WHERE id=" + uid + ')');
  cases.push('COMMIT;', 'BEGIN;', "UPDATE auth.users SET encrypted_password='rolled-back-password' WHERE id=" + uid + ';',
    audit(loginId), 'ROLLBACK;');
  check('a rolled-back password request cannot complete onboarding',
    '(SELECT ' + metadata + "='true' FROM auth.users WHERE id=" + uid + ')');
  // Match GoTrue v2.186 UserUpdate: hash write, trusted audit INSERT, then
  // UpdateUserMetaData in the same transaction (not one combined UPDATE).
  cases.push('BEGIN;',
    "UPDATE auth.users SET encrypted_password=extensions.crypt('Own-changed-password-9',extensions.gen_salt('bf',10)) WHERE id=" + uid + ';');
  check('password hash write keeps the gate until its trusted audit is committed',
    '(SELECT ' + metadata + "='true' FROM auth.users WHERE id=" + uid + ')');
  cases.push(audit(loginId),
    "UPDATE auth.users SET raw_user_meta_data='{\"livo_password_change_required\":false}' WHERE id=" + uid + ';');
  check('actual GoTrue two-statement password lifecycle clears and preserves the trusted gate',
    '(SELECT ' + metadata + "='false' AND raw_user_meta_data->>'livo_password_change_required'='false'"
      + " AND raw_app_meta_data ? 'livo_external_qa_onboarded_at' FROM auth.users WHERE id=" + uid + ')');
  cases.push('COMMIT;');
  error('already onboarded identity cannot have its password reissued',
    'SELECT ' + recovery(), 'PT409', 'external_qa_already_onboarded');
  check('onboarded account is no longer offered credential recovery',
    "EXISTS(SELECT 1 FROM jsonb_array_elements(public.livo_external_qa_registration_list(" + admin
      + ")) a WHERE a->>'id'=" + aid + " AND a->>'credentialRecoveryAvailable'='false')");
  cases.push(migrations);
  check('reapplying migrations preserves completed onboarding',
    '(SELECT ' + metadata + "='false' FROM auth.users WHERE id=" + uid + ')');
  cases.push('SET ROLE authenticated;');
  error('members cannot forge password audit events', audit(loginId), '42501', 'permission denied');
  error('members cannot enumerate registration nonces', 'SELECT * FROM public.external_qa_registrations', '42501', 'permission denied');
  error('members cannot call credential recovery RPC', 'SELECT ' + recovery(), '42501', 'permission denied');
  cases.push('RESET ROLE;');
}
