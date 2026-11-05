import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPostgres } from './task-work-postgres-runtime.mjs';
import { runNativePostgres } from './native-postgres-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const internal = '00000000-0000-0000-0000-000000000001';
const external = '00000000-0000-0000-0000-000000000002';
const inactive = '00000000-0000-0000-0000-000000000003';
const unlinked = '00000000-0000-0000-0000-000000000004';
const replacement = '00000000-0000-0000-0000-000000000005';
const claims = (sub, extra = {}) => quote(JSON.stringify({ role: 'authenticated', sub, ...extra })) + '::jsonb';
const row = (suffix, value) => `INSERT INTO realtime.subscription(subscription_id,entity,claims,action_filter)
  VALUES('00000000-0000-0000-0000-${String(suffix).padStart(12,'0')}', 'public.tasks'::regclass, ${value}, 'DELETE');`;

export function plan() {
  const fixture = fs.readFileSync(path.join(root, 'scripts/lib/external-qa-realtime-fixture.sql'), 'utf8');
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261114_external_qa_realtime_guard.sql'), 'utf8');
  const sql = [fixture];
  let assertions = 0;
  const check = (label, predicate) => {
    assertions++;
    sql.push(`SELECT realtime_test.check((${predicate}),${quote(label)});`);
  };
  const denied = (label, statement) => {
    assertions++;
    sql.push(`SELECT realtime_test.expect_error(${quote(label)},${quote(statement)});`);
  };
  sql.push(`INSERT INTO public.members(id,auth_id,is_active) VALUES
    ('internal','${internal}',true),('inactive','${inactive}',false);
    INSERT INTO public.external_qa_accounts(id,auth_id) VALUES('external','${external}');`);
  sql.push(row(1, claims(internal)), row(2, claims(external)), row(3, claims(inactive)),
    row(4, claims(unlinked)), row(5, "'{\"role\":\"anon\"}'::jsonb"),
    row(6, claims(internal, { role: 'service_role' })), migration, migration);
  check('upgrade reconciles only noninternal subscriptions',
    "(SELECT count(*)=1 AND bool_and(claims->>'sub'='" + internal + "') FROM realtime.subscription)");
  check('presence policy remains installed',
    "EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='realtime.messages'::regclass AND polname='existing_presence_policy')");
  sql.push('SET ROLE supabase_realtime_admin;',
    "SELECT set_config('request.jwt.claims'," + quote(JSON.stringify({ role: 'authenticated', sub: internal })) + ",false);");
  denied('external cannot register using internal request context', row(10, claims(external)));
  denied('anonymous cannot register', row(11, "'{\"role\":\"anon\"}'::jsonb"));
  denied('unlinked login cannot register', row(12, claims(unlinked)));
  denied('inactive internal cannot register', row(13, claims(inactive)));
  denied('service key cannot register internal changes', row(14, claims(internal, { role: 'service_role' })));
  denied('external marker cannot be masked by member claim', row(15, claims(internal, { app_metadata: { livo_external_qa: true } })));
  denied('malformed subject cannot register', row(16, claims('invalid-uuid')));
  denied('missing subject cannot register', row(17, "'{\"role\":\"authenticated\"}'::jsonb"));
  denied('existing subscription cannot change into external identity',
    `UPDATE realtime.subscription SET claims=${claims(external)} WHERE subscription_id='00000000-0000-0000-0000-000000000001'`);
  sql.push(row(18, claims(internal)),
    `UPDATE realtime.subscription SET claims=${claims(internal, { exp: 9999999999 })} WHERE subscription_id='00000000-0000-0000-0000-000000000018';`,
    'RESET ROLE;');
  check('internal subscriber inserts and token refresh remains valid', '(SELECT count(*)=2 FROM realtime.subscription)');
  check('API callers cannot execute privileged membership or cleanup helpers',
    "NOT EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) caller(role) " +
      "CROSS JOIN unnest(ARRAY['public.livo_realtime_internal_claims(jsonb)'," +
      "'public.livo_reconcile_realtime_subscriptions()']) routine(signature) " +
      "WHERE has_function_privilege(caller.role,routine.signature,'EXECUTE'))");
  sql.push("UPDATE public.members SET is_active=false WHERE id='internal';");
  check('deactivation removes existing subscriptions', '(SELECT count(*)=0 FROM realtime.subscription)');
  sql.push("UPDATE public.members SET is_active=true WHERE id='internal';", row(19, claims(internal)),
    `UPDATE public.members SET auth_id='${replacement}' WHERE id='internal';`);
  check('rebind removes subscriptions for the old login', '(SELECT count(*)=0 FROM realtime.subscription)');
  sql.push(row(20, claims(replacement)), "DELETE FROM public.members WHERE id='internal';");
  check('member deletion removes existing subscriptions', '(SELECT count(*)=0 FROM realtime.subscription)');
  sql.push("SELECT jsonb_build_object('status','passed','assertions',n) FROM realtime_test.assertions;");
  return { sql: sql.join('\n') + '\n', summary: { assertions, migrationApplications: 2,
    pinnedRealtimeVersion: '2.76.5', migrations: ['20261114_external_qa_realtime_guard.sql'] } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const current = plan();
  const pending = args.includes('--native') ? runNativePostgres(current, {
    binaryDir: option('--pg-bin'), clientPackage: option('--pg-client-package'), reportPath: option('--report'),
  }) : args.includes('--run') ? runPostgres(current, option('--report')) : Promise.resolve(current.summary);
  pending.then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify(error.report ?? { error: error.message }));
    process.exitCode = 1;
  });
}
