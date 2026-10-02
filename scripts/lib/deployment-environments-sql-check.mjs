// Isolated PostgreSQL contract checks; no Docker server, Slack or remote access.
// Run: node scripts/lib/deployment-environments-sql-check.mjs [PGlite index.js]
// Emit the same fixture/cases for a disposable PostgreSQL runner: --sql <file>.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { lintUpgradeMigration } from '../release-upgrades.mjs';

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '../..');
const migrationName = '20261006_deployment_environments.sql';
const migration = name => readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${quote(JSON.stringify(value))}::jsonb`;
const auth = {
  member: '00000000-0000-0000-0000-000000000001',
  admin: '00000000-0000-0000-0000-000000000002',
  super: '00000000-0000-0000-0000-000000000003',
};

export function buildDeploymentEnvironmentSql() {
  const upgrade = migration(migrationName);
  assert.deepEqual(lintUpgradeMigration(upgrade), [], 'non-destructive migration lint');
  const sql = [readFileSync(path.join(root, 'scripts/lib/qa-postgres-fixture.sql'), 'utf8'), `
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
ALTER TABLE public.members ADD COLUMN email text NOT NULL DEFAULT '';
CREATE ROLE environment_outsider NOLOGIN;
GRANT USAGE ON SCHEMA public,auth,qa_test TO environment_outsider;
GRANT ALL ON public.system_settings TO environment_outsider;
GRANT INSERT,SELECT ON qa_test.results TO environment_outsider;
CREATE FUNCTION public.current_member_id() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT id FROM public.members WHERE auth_id=auth.uid() LIMIT 1
$$;
CREATE TYPE public.deploy_environment AS ENUM ('Dev','QA','Stage','Live Staging','Prod');
CREATE TYPE public.deploy_status AS ENUM ('scheduled','deployed');
CREATE TABLE public.task_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task_id text NOT NULL REFERENCES public.tasks(id),
  environment public.deploy_environment NOT NULL,status public.deploy_status NOT NULL DEFAULT 'scheduled',deploy_date text
);
GRANT ALL ON public.task_deployments TO authenticated,service_role;
GRANT SELECT ON public.members,public.tasks TO authenticated,environment_outsider;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_deployments ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_settings_read ON public.system_settings FOR SELECT TO authenticated USING(true);
CREATE POLICY fixture_deployments_read ON public.task_deployments FOR SELECT TO authenticated USING(true);
INSERT INTO public.tasks(id,project_id) VALUES('t-other','p-test');
INSERT INTO public.task_deployments(id,task_id,environment) VALUES('10000000-0000-0000-0000-000000000001','t-test','Dev');
`, migration('20260713_permission_floor.sql'), migration('20261002_qa_workflow.sql'), upgrade, upgrade];
  let checks = 0;
  const check = (label, condition) => {
    sql.push(`SELECT qa_test.check((${condition}),${quote(label)});`); checks++;
  };
  const error = (label, statement, code, message = '') => {
    sql.push(`SELECT qa_test.expect_error(${quote(label)},${quote(statement)},${quote(code)},${quote(message)});`); checks++;
  };
  const as = (role = null, actor = null) => {
    sql.push(`RESET ROLE; SET "request.jwt.claim.sub"=${quote(actor ? auth[actor] : '')};`);
    if (role) sql.push(`SET ROLE ${role};`);
  };
  const config = values => ({ version: 1, values });
  const save = value => `INSERT INTO public.system_settings(key,value) VALUES('deployment_environments',${json(value)})
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  const deployment = environment => `INSERT INTO public.task_deployments(task_id,environment) VALUES('t-test',${quote(environment)})`;
  const values = () => 'to_jsonb(public.livo_deployment_environment_values())';
  const defaults = ['Dev', 'QA', 'Stage', 'Live Staging', 'Prod'];
  check('migration twice preserves deployment row', `(SELECT environment='Dev' AND status='scheduled' FROM task_deployments WHERE id='10000000-0000-0000-0000-000000000001')`);
  check('enum column becomes text', `(SELECT udt_name='text' FROM information_schema.columns WHERE table_schema='public' AND table_name='task_deployments' AND column_name='environment')`);
  check('missing setting returns defaults', `${values()}=${json(defaults)}`);
  check('migration does not materialize default setting', `NOT EXISTS(SELECT 1 FROM system_settings WHERE key='deployment_environments')`);
  check('read helper is volatile', `(SELECT provolatile='v' FROM pg_proc WHERE oid='public.livo_deployment_environment_values()'::regprocedure)`);
  check('QA RPC remains invoker', `(SELECT NOT prosecdef FROM pg_proc WHERE oid='public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb)'::regprocedure)`);
  check('browser cannot call QA RPC', `NOT has_function_privilege('authenticated','public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb)','EXECUTE')`);
  as('authenticated', 'member');
  check('member reads defaults', `${values()}=${json(defaults)}`);
  sql.push(deployment('QA'));
  check('member creates default deployment', `(SELECT count(*) FROM task_deployments WHERE environment='QA')=1`);
  error('member cannot upsert environment settings', save(config(['QA'])), '42501', 'deployment_environment_settings_forbidden');
  error('member cannot insert unknown environment', deployment('Unknown'), '23514', 'deployment_environment_unavailable');
  as('anon');
  error('anonymous cannot read environment helper', 'SELECT public.livo_deployment_environment_values()', '42501');
  // PostgreSQL may reject the RLS helper's member lookup before the row trigger.
  // Both paths must deny the anonymous write with insufficient_privilege.
  error('anonymous missing JWT does not bypass settings guard', save(config(['QA'])), '42501');
  as('environment_outsider', 'admin');
  error('unprivileged SQL role with admin subject cannot save', save(config(['QA'])), '42501', 'deployment_environment_settings_forbidden');
  as('authenticated', 'admin');
  sql.push(save(config(['QA', 'Preview', 'Prod'])));
  check('admin saves ordered shared list through upsert', `${values()}=${json(['QA', 'Preview', 'Prod'])}`);
  error('protected setting cannot be renamed away', "UPDATE system_settings SET key='renamed' WHERE key='deployment_environments'", '22023', 'deployment_environment_setting_key_immutable');
  for (const [label, invalid] of [
    ['null', null], ['array', []], ['missing version', { values: ['QA'] }],
    ['version string', { version: '1', values: ['QA'] }], ['unknown version', { version: 2, values: ['QA'] }],
    ['values not array', { version: 1, values: 'QA' }], ['empty list', config([])],
    ['overlong list', config(Array.from({ length: 31 }, (_, i) => `Env ${i}`))],
    ['null item', config([null])], ['numeric item', config([1])], ['empty item', config([''])],
    ['leading space', config([' QA'])], ['trailing space', config(['QA '])],
    ['Unicode outer whitespace', config(['\u3000QA'])], ['BOM outer whitespace', config(['QA\ufeff'])],
    ['control newline', config(['Q\nA'])], ['control DEL', config(['Q\u007fA'])],
    ['overlong item', config(['x'.repeat(121)])], ['duplicate item', config(['QA', 'QA'])],
    ['extra property', { version: 1, values: ['QA'], extra: true }],
  ]) error(`setting rejects ${label}`, save(invalid), '22023', 'invalid_deployment_environments');
  sql.push(save(config(['QA', 'qa', 'x'.repeat(120)])));
  check('case-sensitive choices and 120-character boundary accepted', `${values()}=${json(['QA', 'qa', 'x'.repeat(120)])}`);
  sql.push(save(config(Array.from({ length: 30 }, (_, i) => `Env ${i}`))));
  check('30-choice boundary accepted', `cardinality(public.livo_deployment_environment_values())=30`);
  as('authenticated', 'super');
  sql.push(save(config(['QA', 'Preview'])));
  check('super admin saves settings', `${values()}=${json(['QA', 'Preview'])}`);
  as();
  sql.push("UPDATE public.members SET is_active=false WHERE id IN ('m-admin','m-super');");
  for (const actor of ['admin', 'super']) {
    as('authenticated', actor);
    error(`inactive ${actor} cannot save`, save(config(['QA'])), '42501', 'deployment_environment_settings_forbidden');
  }
  as();
  sql.push("UPDATE public.members SET is_active=true WHERE id IN ('m-admin','m-super');");
  as('authenticated', 'member');
  sql.push("UPDATE task_deployments SET status='deployed',deploy_date='2026-10-06' WHERE id='10000000-0000-0000-0000-000000000001';");
  check('member retains retired environment while editing status/date', `(SELECT environment='Dev' AND status='deployed' AND deploy_date='2026-10-06' FROM task_deployments WHERE id='10000000-0000-0000-0000-000000000001')`);
  error('retired value cannot be newly inserted', deployment('Dev'), '23514', 'deployment_environment_unavailable');
  error('retired row cannot move to another task', "UPDATE task_deployments SET task_id='t-other' WHERE id='10000000-0000-0000-0000-000000000001'", '23514', 'deployment_environment_unavailable');
  error('retired row cannot change identity', "UPDATE task_deployments SET id='10000000-0000-0000-0000-000000000099' WHERE id='10000000-0000-0000-0000-000000000001'", '23514', 'deployment_environment_unavailable');
  error('deployment cannot change to unknown environment', "UPDATE task_deployments SET environment='Unknown' WHERE id='10000000-0000-0000-0000-000000000001'", '23514', 'deployment_environment_unavailable');
  sql.push("UPDATE task_deployments SET environment='Preview' WHERE id='10000000-0000-0000-0000-000000000001';");
  check('existing deployment can move to active custom environment', `(SELECT environment='Preview' FROM task_deployments WHERE id='10000000-0000-0000-0000-000000000001')`);
  as();
  sql.push("UPDATE members SET is_active=false WHERE id='m-member';");
  as('authenticated', 'member');
  sql.push("UPDATE task_deployments SET deploy_date='2030-01-01' WHERE id='10000000-0000-0000-0000-000000000001';");
  check('inactive member cannot update deployments', `(SELECT deploy_date='2026-10-06' FROM task_deployments WHERE id='10000000-0000-0000-0000-000000000001')`);
  as();
  sql.push("UPDATE members SET is_active=true WHERE id='m-member';");
  sql.push(save(config(['QA', 'Preview'])));
  check('privileged maintenance still validates and saves', `${values()}=${json(['QA', 'Preview'])}`);
  error('privileged maintenance rejects invalid setting', save(config([''])), '22023', 'invalid_deployment_environments');
  as('service_role');
  sql.push(save(config(['QA', 'Preview'])));
  check('service role saves through same guard', `${values()}=${json(['QA', 'Preview'])}`);
  error('service role cannot bypass invalid settings', save(config([''])), '22023', 'invalid_deployment_environments');
  error('service role cannot insert retired deployment', deployment('Dev'), '23514', 'deployment_environment_unavailable');

  // Exercise the real QA transaction, its replay contract and unchanged restore.
  const base = { id: 'issue-env', workspaceId: 'default', projectId: 'p-test', state: 'new',
    assigneeId: null, qaOwnerId: null, reporterId: 'm-member', title: 'Example defect', actual: 'Example result',
    observedEnvironment: 'QA', severity: 'untriaged', priority: 3, fixCycle: 0,
    version: 1, createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z',
    targets: [], runs: [], taskIds: [] };
  let sequence = 0;
  const commit = (data, type = 'created', kind = 'create', expected = null, command = null) => {
    sequence++;
    return `public.livo_qa_commit(${quote(auth.member)}::uuid,${quote(data.id)},${quote(command ?? `command-env-${sequence}`)},
      ${quote('a'.repeat(64))},${expected ?? 'null'},${quote(kind)},${json(data)},${json({ id: `event-env-${sequence}`, type, detail: '', recipients: [] })})`;
  };
  // Test-only maintenance seeds rows as if they predated the new write guard.
  // Reapplying the upgrade must preserve the bytes/JSON while reads fail closed.
  for (const [index, [label, invalid]] of [
    ['SQL null', undefined], ['JSON null', null], ['scalar', 'QA'],
    ['wrong version', { version: 2, values: ['QA'] }],
    ['missing values', { version: 1 }], ['wrong values shape', { version: 1, values: 'QA' }],
    ['duplicate choices', config(['QA', 'QA'])], ['control characters', config(['QA', 'Q\nA'])],
    ['untrimmed choice', config(['QA', ' Preview'])], ['extra properties', { ...config(['QA']), extra: true }],
  ].entries()) {
    as();
    sql.push('ALTER TABLE public.system_settings DISABLE TRIGGER livo_guard_deployment_environment_setting;');
    sql.push(invalid === undefined
      ? "UPDATE public.system_settings SET value=NULL WHERE key='deployment_environments'"
      : save(invalid));
    sql.push('ALTER TABLE public.system_settings ENABLE TRIGGER livo_guard_deployment_environment_setting;');
    sql.push(upgrade);
    check(`upgrade preserves preexisting ${label}`, `(SELECT value ${invalid === undefined ? 'IS NULL' : `=${json(invalid)}`} FROM system_settings WHERE key='deployment_environments')`);
    as('authenticated', 'member');
    check(`preexisting ${label} exposes no active environments`, `${values()}='[]'::jsonb`);
    error(`task rejects preexisting ${label}`, deployment('QA'), '23514', 'deployment_environment_unavailable');
    as('service_role');
    error(`QA rejects preexisting ${label}`, `SELECT ${commit({ ...base, id: `issue-malformed-${index}` })}`, '22023', 'qa_invalid_environment');
  }
  check('malformed setting attempts leave no QA issues or receipts', '(SELECT count(*) FROM qa_issues)=0 AND (SELECT count(*) FROM qa_commands)=0');
  sql.push(save(config(['QA', 'Preview'])));
  const initial = commit(base, 'created', 'create', null, 'command-env-create');
  check('QA creates with active observed environment', `${initial}->>'id'='issue-env'`);
  error('QA rejects unknown observed environment', `SELECT ${commit({ ...base, id: 'issue-rejected', observedEnvironment: 'Unknown' })}`, '22023', 'qa_invalid_environment');
  sql.push(save(config(['Preview'])));
  check('QA committed request replays after environment retirement', `${initial}=${json(base)}`);
  const edited = { ...base, title: 'Edited without changing history', version: 2 };
  check('QA edit retains original retired observation', `${commit(edited, 'edit', 'command', 1)}->>'observedEnvironment'='QA'`);
  error('QA edit rejects changing observation to inactive value', `SELECT ${commit({ ...edited, version: 3, observedEnvironment: 'Dev' }, 'edit', 'command', 2)}`, '22023', 'qa_invalid_environment');
  const active = { ...edited, version: 3, observedEnvironment: 'Preview' };
  check('QA edit accepts current active environment', `${commit(active, 'edit', 'command', 2)}->>'observedEnvironment'='Preview'`);
  const triaged = { ...active, version: 4, state: 'triaged', assigneeId: 'm-member', qaOwnerId: 'm-member' };
  // Existing command authorization allows an admin to perform first triage.
  const triage = commit(triaged, 'triage', 'command', 3).replace(`${quote(auth.member)}::uuid`, `${quote(auth.admin)}::uuid`);
  check('QA prepares an assigned issue', `${triage}->>'state'='triaged'`);
  const submitted = { ...triaged, version: 5, state: 'verification', targets: [{ id: 'target-preview', environment: 'Preview' }] };
  error('QA fix rejects inactive target environment', `SELECT ${commit({ ...submitted, targets: [{ environment: 'QA' }] }, 'submit_fix', 'command', 4)}`, '22023', 'qa_invalid_environment');
  error('QA fix rejects missing target environment', `SELECT ${commit({ ...submitted, targets: [{}] }, 'submit_fix', 'command', 4)}`, '22023', 'qa_invalid_environment');
  check('QA fix accepts active target environment', `${commit(submitted, 'submit_fix', 'command', 4)}->>'version'='5'`);
  check('rejected QA attempts leave no issue', `NOT EXISTS(SELECT 1 FROM qa_issues WHERE id='issue-rejected')`);
  const restored = { ...base, id: 'issue-env-restored', observedEnvironment: 'Historical Label' };
  const tables = Object.fromEntries(['qa_issues', 'qa_commands', 'qa_events', 'qa_comments', 'qa_uploads', 'qa_attachments', 'qa_slack_links'].map(t => [t, []]));
  tables.qa_issues.push({ id: restored.id, workspace_id: 'default', project_id: 'p-test', state: 'new',
    assignee_id: null, qa_owner_id: null, reporter_id: 'm-member', title: restored.title, version: 1,
    updated_at: restored.updatedAt, data: restored });
  check('QA restore preserves historical environment text', `public.livo_qa_restore(${quote(auth.super)}::uuid,${json(tables)},false)->>'inserted'='1'`);
  check('historical environment restored unchanged', `(SELECT data->>'observedEnvironment'='Historical Label' FROM qa_issues WHERE id='issue-env-restored')`);
  as();
  sql.push("DELETE FROM system_settings WHERE key='deployment_environments';");
  check('privileged reset restores defaults', `${values()}=${json(defaults)}`);
  sql.push(`SELECT count(*) AS checks FROM qa_test.results;`);
  // Helpers are also embedded as dynamic SQL and intentionally omit a final
  // semicolon. Separate top-level chunks explicitly, including after comments.
  return { sql: sql.join('\n;\n') + '\n;', checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  const built = buildDeploymentEnvironmentSql();
  if (process.argv[2] === '--sql') {
    if (!process.argv[3]) throw new Error('--sql requires a destination file');
    writeFileSync(process.argv[3], built.sql, 'utf8');
    console.log(`Deployment environment SQL emitted: ${built.checks} checks`);
  } else {
    const { PGlite } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : '@electric-sql/pglite');
    const db = new PGlite();
    try {
      await db.exec(built.sql);
      const actual = Number((await db.query('SELECT count(*) AS checks FROM qa_test.results')).rows[0].checks);
      assert.equal(actual, built.checks);
      console.log(`Deployment environment SQL: ${actual} checks passed; migration applied twice`);
    } finally { await db.close(); }
  }
}
