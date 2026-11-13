import { addAssignmentCases } from './lib/external-qa-assignment-postgres.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan as qaPlan } from './test-qa-auto-close-postgres.mjs';
import { runPostgres } from './task-work-postgres-runtime.mjs';
import { runNativePostgres } from './native-postgres-runtime.mjs';
import { addAuthRecoveryCases } from './lib/external-qa-auth-recovery-postgres.mjs';
import { addMemberDisplayOrderCases } from './lib/qa-member-display-order-postgres.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = name => fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const json = value => quote(JSON.stringify(value)) + '::jsonb';
const auth = "'00000000-0000-0000-0000-000000000011'::uuid";
const admin = "'00000000-0000-0000-0000-000000000003'::uuid";
const actor = 'eqa-example';
const names = ['20261110_external_qa_scope.sql', '20261110_qa_external_reads.sql', '20261111_external_qa_admin.sql',
  '20261112_external_qa_gateway_privacy.sql', '20261113_external_qa_auth_recovery.sql', '20261116_external_qa_assignment_directory.sql',
  '20261117_qa_participant_display.sql', '20261122_qa_member_display_order.sql'];

export function plan() {
  const baseline = qaPlan();
  const migrations = names.map(migration).join('\n');
  // Deletion now exercises dependencies the inherited auto-close suite did not
  // call. Keep their released definitions and ACLs, not a substitute helper.
  const recordDelete = migration('20261025_record_delete.sql');
  const helperStart = recordDelete.indexOf('CREATE OR REPLACE FUNCTION public.livo_qa_notification_issue(');
  const helperEnd = recordDelete.indexOf('CREATE OR REPLACE FUNCTION public.livo_qa_delete(');
  const activity = migration('20260310044327_7e8def58-e082-4b3a-a28a-7a89f825960b.sql');
  const publicationStart = activity.indexOf('ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_logs;');
  if (helperStart < 0 || helperEnd <= helperStart || publicationStart < 0) throw new Error('Released QA deletion fixture dependencies changed');
  const cases = [];
  let assertions = baseline.summary.assertions;
  const check = (label, sql) => { assertions++; cases.push("SELECT qa_test.check((" + sql + ")," + quote(label) + ");"); };
  const error = (label, sql, code, message) => {
    assertions++;
    cases.push("SELECT qa_test.expect_error(" + [label, sql, code, message].map(quote).join(',') + ");");
  };
  const read = (action, input = {}) => "public.livo_qa_external_read(" + [auth, quote(action), json(input)].join(',') + ")";
  const comment = (issue, command) => "public.livo_qa_commit(" + [auth, quote(issue), quote(command), quote('a'.repeat(64)), 'NULL',
    "'comment'", json({ id: 'external-comment', body: 'Example test', createdAt: '2026-11-04T01:00:00Z' }),
    json({ id: 'external-comment-event', type: 'comment', recipients: [] })].join(',') + ")";
  const adminCall = (who, action) => "public.livo_external_qa_admin(" + [who, quote(action), quote(actor), auth,
    "'Example external'", "'external@example.com'", 'true', "ARRAY['p-test']", 'NULL'].join(',') + ")";
  const adminUpdate = (who, projects, revision, active = true) => "public.livo_external_qa_admin(" +
    [who, "'update'", quote(actor), 'NULL', "'Example external'", 'NULL', String(active), projects, revision].join(',') + ")";
  const storagePath = 'default/example-stale/external-upload';

  cases.push(
    "SET ROLE service_role;",
    "INSERT INTO public.projects(id,name,line_id,color) VALUES('p-other','Example other','line-test','#222222');",
    "INSERT INTO public.tasks(id,project_id,task_key,title) VALUES('task-other','p-other','EX-2','Restricted example');",
  );
  error('ordinary member cannot provision external identities', 'SELECT ' + adminCall(auth, 'create'), '42501', 'external_qa_forbidden');
  error('admin cannot provision external identities', 'SELECT ' + adminCall("'00000000-0000-0000-0000-000000000002'::uuid", 'create'),
    '42501', 'external_qa_forbidden');
  check('super admin creates an external principal scoped to one project', adminCall(admin, 'create') + "->>'id'=" + quote(actor));
  check('internal QA can find a project-granted external candidate', "public.livo_qa_internal_external_people(" + admin +
    ",'p-test','',0)->'members'->0->>'id'=" + quote(actor));
  check('internal QA cannot assign this external candidate in another project', "jsonb_array_length(public.livo_qa_internal_external_people(" +
    admin + ",'p-other','',0)->'members')=0");
  check('external login is not a normal member', "NOT EXISTS (SELECT 1 FROM members WHERE auth_id=" + auth + ")");
  error('ordinary member binding refuses the same login',
    "INSERT INTO members(id,auth_id,role) VALUES('m-invalid'," + auth + ",'member')", '42501', 'qa_external_identity_conflict');
  error('external identity refuses an existing member login',
    "INSERT INTO external_qa_accounts(id,auth_id,name) VALUES('eqa-conflict'," + admin + ",'Conflict')", '42501', 'qa_external_identity_conflict');
  cases.push("INSERT INTO qa_issues(id,project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data) SELECT 'issue-external-other','p-other',state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data || '{\"id\":\"issue-external-other\",\"projectId\":\"p-other\"}'::jsonb FROM qa_issues WHERE id='example-stale';");
  check('profile lists only granted projects', read('profile') + "->'projects'->0->>'id'='p-test' AND jsonb_array_length(" + read('profile') + "->'projects')=1");
  addMemberDisplayOrderCases({ cases, check, error, auth, admin, quote, json });
  addAssignmentCases({ cases, check, error, auth, quote, json });
  check('mixed project query cannot count other project', read('list', { projectIds: ['p-other'] }) + "->>'total'='0'");
  check('current issue read works inside project', read('issue', { id: 'example-stale' }) + "->>'id'='example-stale'");
  error('known issue outside scope is hidden', 'SELECT ' + read('issue', { id: 'issue-external-other' }), 'P0002', 'qa_issue_not_found');
  error('known task project cannot return references', 'SELECT ' + read('task_references', { projectId: 'p-other' }), 'P0002', 'qa_project_unavailable');
  error('external comment denied outside project', 'SELECT ' + comment('issue-external-other', 'external-other-comm'), '42501', 'qa_forbidden');
  check('external comment commits within allowed project with own identity', comment('example-stale', 'external-comment-command') + "->>'id'='external-comment'");
  const verifyData = "q.data || jsonb_build_object('state','closed','resolution','fixed','closedAt','2026-11-02T01:01:00.000Z','closedBy'," + quote(actor) +
    ",'updatedAt','2026-11-02T01:01:00.000Z','version',2,'runs',(q.data->'runs') || " +
    json([{ id: 'external-pass', sequence: 2, fixCycle: 1, targetId: 'prod', environment: 'Prod', component: 'app', build: 'example-build',
      result: 'pass', note: '', testerId: actor, createdAt: '2026-11-02T01:01:00.000Z' }]) + ")";
  const verify = "SELECT public.livo_qa_commit(" + auth + ",'example-stale','external-verify-command'," + quote('c'.repeat(64)) +
    ",1,'command'," + verifyData + ",'{\"type\":\"record_verification\",\"id\":\"external-verify-event\",\"recipients\":[]}') FROM qa_issues q WHERE q.id='example-stale'";
  error('external verifier still needs ordinary QA ownership', verify, '42501', 'member_inactive');
  cases.push("UPDATE qa_issues SET qa_owner_id=" + quote(actor) + ",data=jsonb_set(data,'{qaOwnerId}',to_jsonb(" +
    quote(actor) + "::text)) WHERE id='example-stale';");
  check('assigned external QA verifies the deployed target and closes with actual actor', "(" + verify + ")->>'closedBy'=" + quote(actor));
  check('matching receipt is available within project', read('receipt', { id: 'example-stale', commandId: 'external-comment-command' }) + "->>'actor_id'=" + quote(actor));
  error('external move requires destination grant', "SELECT public.livo_qa_commit(" + auth + ",'example-stale','external-move-attempt'," +
    quote('b'.repeat(64)) + ",1,'command','{\"projectId\":\"p-other\"}','{\"type\":\"update_fields\"}')", '42501', 'qa_forbidden');
  check('external attachment reservation succeeds on project', "public.livo_qa_external_reserve_upload(" + auth +
    ",'example-stale','external-upload','example.txt','text/plain',7)->>'actor_id'=" + quote(actor));
  cases.push("INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('qa-evidence'," + quote(storagePath) +
    ",'{\"size\":7,\"mimetype\":\"text/plain\"}');");
  check('attachment finalized with actual external uploader', "public.livo_qa_finalize_upload(" + auth +
    ",'external-upload')->>'uploaded_by'=" + quote(actor));
  check('attachment lookup returns the scoped object path', read('attachment', { attachmentId: 'external-upload' }) + "->>'storage_path'=" + quote(storagePath));
  check('external QA can reserve another attachment before scope changes', "public.livo_qa_external_reserve_upload(" + auth +
    ",'example-stale','external-pending','example.txt','text/plain',7)->>'actor_id'=" + quote(actor));

  cases.push('RESET ROLE;', migrations, 'SET ROLE service_role;');
  check('second application keeps grants and command receipts', read('receipt', { id: 'example-stale', commandId: 'external-comment-command' }) + "->>'actor_id'=" + quote(actor));
  check('second application preserves published commit OID owner ACL and dependency guard',
    "(SELECT p.oid=b.oid AND p.proowner=b.proowner AND p.proacl=b.proacl FROM pg_proc p CROSS JOIN qa_test.commit_identity b WHERE p.oid='public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb)'::regprocedure) AND COALESCE(current_setting('livo.qa_assignment_enforce',true),'false')<>'true'");
  check('super admin revokes projects and increments the revision', adminUpdate(admin, 'ARRAY[]::text[]', 1) + "->>'revision'='2'");
  error('stale admin revision cannot overwrite a revocation', 'SELECT ' + adminUpdate(admin, "ARRAY['p-test']", 1), 'PT409', 'external_qa_stale');
  check('revoked account profile has no granted projects', "jsonb_array_length(" + read('profile') + "->'projects')=0");
  check('revoked account has no assignment directory through profile', "jsonb_array_length(" + read('profile') + "->'members')=0");
  error('same login loses the project assignment directory after revocation', 'SELECT ' + read('members', { projectId: 'p-test' }), 'P0002', 'qa_project_unavailable');
  cases.push("UPDATE external_qa_accounts SET is_active=false WHERE id='eqa-example';");
  error('disabled external login cannot read even the profile directory', 'SELECT ' + read('profile'), '42501', 'qa_forbidden');
  cases.push("UPDATE external_qa_accounts SET is_active=true WHERE id='eqa-example';");
  error('revocation invalidates a signed upload reservation at object write',
    "INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('qa-evidence','default/example-stale/external-pending','{\"size\":7,\"mimetype\":\"text/plain\"}')",
    '42501', 'qa_upload_unavailable');
  check('revoked account cannot get old receipt', read('receipt', { id: 'example-stale', commandId: 'external-comment-command' }) + " IS NULL");
  error('revoked account cannot replay a committed comment', 'SELECT ' + comment('example-stale', 'external-comment-command'), '42501', 'qa_forbidden');
  error('revoked account cannot replay an attachment finalization', "SELECT public.livo_qa_finalize_upload(" + auth + ",'external-upload')", '42501', 'qa_forbidden');
  cases.push("RESET ROLE; SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub'," + auth.replace('::uuid', '') + ",false);");
  error('external JWT cannot query grant table directly', 'SELECT * FROM public.external_qa_project_grants', '42501', 'permission denied');
  error('external JWT cannot call scoped service RPC directly', 'SELECT ' + read('profile'), '42501', 'permission denied');
  check('external JWT fails ordinary workspace membership gate', 'NOT public.livo_is_active_member()');
  check('external JWT cannot enumerate legacy internal task assets', "(SELECT count(*) FROM storage.objects WHERE bucket_id='task-images')=0");
  check('external JWT cannot read internal Presence even with a permissive old policy', "(SELECT count(*) FROM realtime.messages)=0");
  error('external JWT cannot publish internal Presence', "INSERT INTO realtime.messages(extension) VALUES('presence')", '42501', 'row-level security');
  cases.push("SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);");
  check('internal member can read legacy task asset via authenticated Storage', "(SELECT count(*) FROM storage.objects WHERE bucket_id='task-images')=1");
  check('internal member can read private Presence', "(SELECT count(*) FROM realtime.messages)=1");
  cases.push("RESET ROLE; SET ROLE anon; SELECT set_config('request.jwt.claim.sub','',false);");
  check('anonymous client cannot enumerate legacy task assets', "(SELECT count(*) FROM storage.objects WHERE bucket_id='task-images')=0");
  check('anonymous client cannot read private Presence', "(SELECT count(*) FROM realtime.messages)=0");
  cases.push("RESET ROLE;");
  check('legacy task assets are no longer public', "(SELECT NOT public FROM storage.buckets WHERE id='task-images')");
  check('create and revoke each produced one actor-attributed audit event',
    "(SELECT count(*) FROM public.external_qa_admin_events WHERE account_id='eqa-example' AND actor_id='m-super')=2");
  addAuthRecoveryCases({ cases, check, error, admin, quote, json, migrations });
  cases.push("RESET ROLE; SELECT json_build_object('status','passed','assertions',(SELECT count(*) FROM qa_test.results));");

  const fixture = [
    'RESET ROLE;',
    // The shared base fixture intentionally retains the released original
    // NOT NULL column. Load the real upgrade before exercising QA recipients.
    migration('20261017_notifications_task_optional.sql'),
    recordDelete.slice(helperStart, helperEnd),
    // This isolated plan has no Realtime publication. The complete original
    // table, UUID default, indexes and RLS policies still apply unchanged.
    activity.slice(0, publicationStart),
    'GRANT ALL ON TABLE public.activity_logs TO service_role;',
    "ALTER TABLE members ADD COLUMN email text NOT NULL DEFAULT '', ADD COLUMN name text NOT NULL DEFAULT 'Example member', ADD COLUMN avatar text NOT NULL DEFAULT '', ADD COLUMN color text NOT NULL DEFAULT '', ADD COLUMN job_title text NOT NULL DEFAULT '', ADD COLUMN is_qa_admin boolean NOT NULL DEFAULT false, ADD COLUMN sort_order integer;",
    "ALTER TABLE projects ADD COLUMN name text NOT NULL DEFAULT 'Example project', ADD COLUMN line_id text NOT NULL DEFAULT 'line-test', ADD COLUMN color text NOT NULL DEFAULT '';",
    "ALTER TABLE tasks ADD COLUMN task_key text NOT NULL DEFAULT 'EX-1', ADD COLUMN title text NOT NULL DEFAULT 'Example task';",
    "CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,encrypted_password text,raw_app_meta_data jsonb NOT NULL DEFAULT '{}',raw_user_meta_data jsonb NOT NULL DEFAULT '{}',last_sign_in_at timestamptz,updated_at timestamptz); INSERT INTO auth.users(id,email) VALUES (" + auth + ",'external@example.com');",
    "CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid); CREATE TABLE auth.refresh_tokens(id bigint PRIMARY KEY,user_id text);",
    "CREATE TABLE auth.audit_log_entries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),payload jsonb);",
    "INSERT INTO storage.buckets(id,name,public) VALUES ('task-images','task-images',true) ON CONFLICT(id) DO UPDATE SET public=true;",
    "INSERT INTO storage.objects(bucket_id,name) VALUES ('task-images','internal/example.png');",
    "CREATE SCHEMA realtime; CREATE TABLE realtime.messages(extension text NOT NULL); ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;",
    "GRANT USAGE ON SCHEMA realtime TO anon,authenticated; GRANT SELECT,INSERT ON realtime.messages TO anon,authenticated;",
    "CREATE POLICY legacy_presence_all ON realtime.messages TO anon,authenticated USING(true) WITH CHECK(true);",
    "INSERT INTO realtime.messages VALUES ('presence');",
    migration('20261015_qa_custom_fields.sql'),
    "CREATE TABLE qa_test.commit_identity AS SELECT oid,proowner,proacl FROM pg_proc WHERE oid='public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb)'::regprocedure; GRANT SELECT ON qa_test.commit_identity TO service_role;",
    `CREATE FUNCTION qa_test.commit_by_dependency(a uuid,b text,c text,d text,e integer,f text,g jsonb,h jsonb)
      RETURNS jsonb LANGUAGE sql BEGIN ATOMIC SELECT public.livo_qa_commit(a,b,c,d,e,f,g,h); END;
      REVOKE ALL ON FUNCTION qa_test.commit_by_dependency(uuid,text,text,text,integer,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
      GRANT EXECUTE ON FUNCTION qa_test.commit_by_dependency(uuid,text,text,text,integer,text,jsonb,jsonb) TO service_role;`,
    migration('20261019_active_member_gate.sql'),
    migrations,
    `CREATE TABLE qa_test.member_order_identity AS SELECT oid,proowner,proacl,
      (SELECT count(*) FROM members) AS roster_count FROM pg_proc WHERE oid IN (
      'public.livo_qa_external_read(uuid,text,jsonb)'::regprocedure,
      'public.livo_qa_member_display_page(uuid,text,text,integer)'::regprocedure);
      GRANT SELECT ON qa_test.member_order_identity TO service_role;`,
    migration('20261122_qa_member_display_order.sql'),
  ];
  return { sql: [baseline.sql, ...fixture, ...cases].join('\n'), summary: { assertions, migrationApplications: 2, migrations: names } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const current = plan();
  const pending = args.includes('--native') ? runNativePostgres(current, {
    binaryDir: option('--pg-bin'), clientPackage: option('--pg-client-package'), reportPath: option('--report'),
  }) : args.includes('--run') ? runPostgres(current, option('--report')) : Promise.resolve(current.summary);
  pending.then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify(error.report ?? { error: error.message }));
    process.exitCode = 1;
  });
}
