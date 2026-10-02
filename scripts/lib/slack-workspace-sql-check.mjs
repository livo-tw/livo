// Run real migrations in disposable local PostgreSQL; never contacts Slack or HT.
// Optional argument: path to a temporary @electric-sql/pglite/dist/index.js.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : '@electric-sql/pglite');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sql = name => readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
const db = new PGlite();
let checks = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const scalar = async (statement, params = []) => Object.values((await db.query(statement, params)).rows[0])[0];
const expected = (id = 'task') => scalar(`SELECT jsonb_build_object('status_id',status_id,'assignee_id',NULLIF(assignee_id,''),
  'reviewer_id',NULLIF(reviewer_id,''),'due_date',NULLIF(due_date,''),'priority',priority) FROM tasks WHERE id=$1`, [id]);
const source = { team: 'TEXAMPLE', channel: 'CEXAMPLE' };
const update = (request, changes, snapshot, task = 'task', origin = source) => scalar('SELECT livo_slack_update($1,$2,$3,$4,$5)', [request, task, snapshot, changes, origin]);
const reject = async (promise, message, code) => {
  await assert.rejects(promise, error => error.message === message && error.code === code); checks++;
};
const asMember = () => db.exec('SET ROLE authenticated');
const admin = async statement => {
  await db.exec('RESET ROLE');
  const savedClaims = await scalar("SELECT current_setting('request.jwt.claims',true)");
  // Maintenance has no member JWT; production member guards still apply to RPCs.
  await db.query("SELECT set_config('request.jwt.claims',$1,false)", ['{}']);
  try { await db.exec(statement); }
  finally {
    await db.query("SELECT set_config('request.jwt.claims',$1,false)", [savedClaims]);
    await asMember();
  }
};
const counts = async () => {
  // The outbox deliberately has no member SELECT policy; audit it as the fixture owner.
  await db.exec('RESET ROLE');
  try { return await scalar(`SELECT jsonb_build_object('status',(SELECT count(*) FROM status_logs),
    'activity',(SELECT count(*) FROM activity_logs),'outbox',(SELECT count(*) FROM slack_delivery_outbox),
    'actions',(SELECT count(*) FROM external_action_logs))`); }
  finally { await asMember(); }
};
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claims',true)::jsonb $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
    CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql AS $$ SELECT auth.jwt()->>'email' $$;
    GRANT USAGE ON SCHEMA auth TO authenticated;`);
  for (const [name, split] of [
    ['20260308173019_ad17e08d-5ca0-4d6d-b511-815ac2c1889f.sql', '-- Enable RLS'],
    ['20260308191828_39c47e78-a353-41e8-842b-450be9247343.sql', 'ALTER TABLE'],
    ['20260308185150_14e0c414-7e18-4253-a8c2-85f36c2f244e.sql', 'ALTER TABLE'],
    ['20260310044327_7e8def58-e082-4b3a-a28a-7a89f825960b.sql', 'CREATE INDEX'],
    ['20260402_bidirectional_integration.sql', '-- 互动按钮'],
  ]) await db.exec(sql(name).split(split)[0]);
  await db.exec("ALTER TYPE app_member_role ADD VALUE IF NOT EXISTS 'super_admin'");
  await db.exec(`ALTER TABLE members ADD COLUMN auth_id uuid, ADD COLUMN is_active boolean NOT NULL DEFAULT true;
    ALTER TABLE tasks ADD COLUMN sprint_id uuid REFERENCES sprints(id);
    CREATE TABLE system_settings(key text PRIMARY KEY,value jsonb,updated_at timestamptz DEFAULT now());
    CREATE TABLE backup_settings(task_notify_types text[]);
    CREATE FUNCTION current_member_id() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
      SELECT id FROM members WHERE auth_id=auth.uid() LIMIT 1 $$;
    INSERT INTO members(id,name,avatar,auth_id) VALUES
      ('actor','Actor','','00000000-0000-4000-8000-000000000001'),('other','Other','',NULL),('inactive','Inactive','',NULL);
    UPDATE members SET is_active=false WHERE id='inactive';
    INSERT INTO product_lines(id,name) VALUES('line','Example');
    INSERT INTO projects(id,line_id,name,key) VALUES('project','line','Example','EX'),('hidden-project','line','Hidden','HID');
    INSERT INTO statuses(id,name,is_done,auto_start) VALUES('todo','Todo',false,false),('doing','Doing',false,true),
      ('review','待驗收',false,false),('done','Done',true,false);
    INSERT INTO system_settings(key,value) VALUES('feature_toggles','{"slackActions":true,"approvals":true}'),
      ('slack_delivery','{"enabled":true,"teamId":"TEXAMPLE","dmEnabled":true,"routes":[{"lineId":"line","channelId":"CEXAMPLE"}]}');`);
  for (const name of ['20260402_approval_workflow.sql', '20260404_task_requires_approval.sql',
    '20260402_add_status_transition_rules.sql', '20261001_feature_toggles.sql', '20261002_slack_actions.sql',
    '20261002_slack_manual_binding.sql', '20261003_slack_delivery_outbox.sql', '20261003_slack_required_fields.sql',
    '20261004_slack_notification_parity.sql']) {
      await db.exec(sql(name));
      if (name.startsWith('20261003_') || name.startsWith('20261004_')) { await db.exec(sql(name)); checks++; }
    }
  await db.exec(`INSERT INTO external_account_bindings(id,member_id,platform,platform_user_id,platform_team_id,is_verified)
    VALUES('00000000-0000-4000-8000-000000000002','actor','slack','UEXAMPLE','TEXAMPLE',true);
    INSERT INTO tasks(id,task_key,project_id,title,status_id,creator_id,assignee_id) VALUES
      ('task','EX-1','project','Example task','todo','actor','actor'),
      ('hidden-task','HID-1','hidden-project','Hidden task','todo','actor','actor');
    GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;`);
  for (const table of ['members', 'projects', 'statuses', 'tasks', 'sprints', 'task_specs', 'status_logs', 'comments',
    'notifications', 'activity_logs', 'system_settings', 'external_account_bindings', 'external_action_logs', 'slack_thread_mappings']) {
    await db.exec(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY fixture_read ON ${table} FOR SELECT TO authenticated USING (${table === 'tasks' ? "project_id<>'hidden-project'" : table === 'projects' ? "id<>'hidden-project'" : 'true'});
      CREATE POLICY fixture_insert ON ${table} FOR INSERT TO authenticated WITH CHECK (${table === 'external_action_logs' ? 'member_id=current_member_id()' : 'true'});
      CREATE POLICY fixture_update ON ${table} FOR UPDATE TO authenticated USING (true) WITH CHECK (true);`);
  }
  // Replace fixture writes with the same role floor used by deployed installations.
  await db.exec(sql('20260713_permission_floor.sql'));
  const migration = sql('20261005_slack_task_workspace.sql');
  await db.exec(migration); await db.exec(migration); checks++;
  check(await scalar("SELECT prosecdef FROM pg_proc WHERE proname='livo_slack_update'"), false, 'RPC keeps caller RLS');
  check(await scalar("SELECT has_function_privilege('anon','livo_slack_update(text,text,jsonb,jsonb,jsonb)','EXECUTE')"), false, 'anonymous execution denied');
  const claims = { sub: '00000000-0000-4000-8000-000000000001', role: 'authenticated',
    livo_slack_binding: '00000000-0000-4000-8000-000000000002', livo_slack_source: source };
  await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify(claims)]);
  await asMember();
  // Slack modal metadata normalizes legacy empty optional values to null.
  await admin("UPDATE tasks SET due_date='' WHERE id='task'");
  const legacyEmptySnapshot = await expected();
  check(legacyEmptySnapshot.due_date, null);
  check((await update('request-legacy-empty', { priority: 'low' }, legacyEmptySnapshot)).task.priority, 'low', 'legacy empty date accepts normalized UI snapshot');
  await reject(update('request-legacy-stale', { priority: 'high' }, legacyEmptySnapshot), 'slack_task_conflict', '40001');
  await admin("UPDATE tasks SET due_date=NULL,priority='medium' WHERE id='task'");
  const initial = await expected();
  await reject(update('request-hidden', { priority: 'high' }, initial, 'hidden-task'), 'slack_task_unavailable', '42501');
  await reject(update('request-team', { priority: 'high' }, initial, 'task', { team: 'TWRONG' }), 'slack_session_unavailable', '42501');
  await reject(update('request-empty', {}, initial), 'slack_update_invalid', '22023');
  await reject(update('request-short', { priority: 'high' }, { priority: 'medium' }), 'slack_update_invalid', '22023');
  await reject(update('request-extra', { title: 'Forbidden field' }, initial), 'slack_update_invalid', '22023');
  await reject(update('request-type', { priority: ['high'] }, initial), 'slack_update_invalid', '22023');
  await reject(update('request-unknown', { status_id: 'missing' }, initial), 'slack_status_unavailable', '23514');
  await reject(update('request-null-status', { status_id: null }, initial), 'slack_update_invalid', '22023');
  await reject(update('request-bad-priority', { priority: 'urgent' }, initial), 'slack_update_invalid', '22023');
  await reject(update('request-inactive', { assignee_id: 'inactive' }, initial), 'slack_member_unavailable', '23514');
  await reject(update('request-empty-member', { reviewer_id: '' }, initial), 'slack_update_invalid', '22023');
  for (const due of ['2026-02-30', '2026-1-02', 'tomorrow', '0000-01-01']) {
    await reject(update(`request-date-${due}`, { due_date: due }, initial), 'slack_invalid_date', '22023');
  }
  const before = await counts();
  const changes = { status_id: 'doing', assignee_id: 'other', reviewer_id: 'actor', due_date: '2026-10-09', priority: 'high' };
  const first = await update('request-five', changes, initial);
  check(first.kind, 'update'); check(first.task.status_id, 'doing'); check(first.task.assignee_id, 'other');
  check(first.task.reviewer_id, 'actor'); check(first.task.due_date, '2026-10-09'); check(first.task.priority, 'high');
  assert.ok(first.task.started_at); checks++;
  check((await counts()).status, before.status + 1, 'one status history row');
  check((await counts()).activity, before.activity + 5, 'one audit record per changed field');
  check((await counts()).outbox, before.outbox + 3, 'one channel notification and deduplicated role DMs');
  const afterFirst = await counts();
  check((await update('request-five', changes, initial)).duplicate, true, 'replay succeeds even after snapshot changes');
  check(await counts(), afterFirst, 'replay produces no side effects');
  await reject(update('request-five', { priority: 'low' }, initial), 'slack_request_conflict', '22023');
  await reject(update('request-stale', { priority: 'low' }, initial), 'slack_task_conflict', '40001');
  check(await counts(), afterFirst, 'stale modal and collision cause no writes');
  const beforeNoop = await counts();
  check((await update('request-noop', { priority: 'high' }, await expected())).unchanged, true);
  check((await counts()).outbox, beforeNoop.outbox, 'no-op emits no notification');
  check((await counts()).activity, beforeNoop.activity, 'no-op emits no task audit');
  const completed = await update('request-done', { status_id: 'done' }, await expected());
  assert.ok(completed.task.completed_at); checks++;
  check((await update('request-reopen', { status_id: 'todo' }, await expected())).task.completed_at, null, 'reopen clears completion');
  await admin("INSERT INTO status_transition_rules(target_status_id,required_status_id) VALUES('done','review')");
  await reject(update('request-prerequisite', { status_id: 'done' }, await expected()), 'slack_transition_prerequisite', '23514');
  await update('request-reviewed', { status_id: 'review' }, await expected());
  check((await update('request-done-after-review', { status_id: 'done' }, await expected())).task.status_id, 'done');
  await admin("UPDATE tasks SET requires_approval=true WHERE id='task'");
  await reject(update('request-approval-card', { status_id: 'todo' }, await expected()), 'slack_approval_required', '23514');
  check((await update('request-approval-ordinary', { priority: 'low' }, await expected())).task.priority, 'low', 'approval card still allows ordinary fields');
  await admin(`UPDATE tasks SET requires_approval=false WHERE id='task';
    INSERT INTO approval_rules(id,project_id,from_status,to_status,created_by)
      VALUES('00000000-0000-4000-8000-000000000010','project','done','todo','actor')`);
  await reject(update('request-approval-rule', { status_id: 'todo' }, await expected()), 'slack_approval_required', '23514');
  await admin(`UPDATE approval_rules SET is_active=false WHERE id='00000000-0000-4000-8000-000000000010';
    INSERT INTO approval_requests(task_id,rule_id,requested_by,from_status,to_status)
      VALUES('task','00000000-0000-4000-8000-000000000010','actor','done','todo')`);
  await reject(update('request-approval-pending', { status_id: 'todo' }, await expected()), 'slack_approval_required', '23514');
  await admin(`UPDATE approval_requests SET status='cancelled' WHERE task_id='task';
    INSERT INTO system_settings(key,value) VALUES('required_fields','{"dueDate":true,"assignee":true,"reviewer":true}')`);
  for (const field of ['due_date', 'assignee_id', 'reviewer_id']) {
    await reject(update(`request-required-${field}`, { [field]: null }, await expected()), 'slack_required_field', '23514');
  }
  await admin("UPDATE system_settings SET value='{}' WHERE key='required_fields'");
  const cleared = await update('request-clear', { due_date: null, assignee_id: null, reviewer_id: null }, await expected());
  check(cleared.task.due_date, null); check(cleared.task.assignee_id, null); check(cleared.task.reviewer_id, null);
  const snapshotBeforeWeb = await expected();
  await admin("UPDATE tasks SET reviewer_id='other' WHERE id='task'");
  await reject(update('request-web-race', { priority: 'medium' }, snapshotBeforeWeb), 'slack_task_conflict', '40001');
  await admin("UPDATE projects SET is_archived=true WHERE id='project'");
  await reject(update('request-archived', { priority: 'medium' }, await expected()), 'slack_task_unavailable', '42501');
  await admin("UPDATE projects SET is_archived=false WHERE id='project'; ALTER TABLE activity_logs ADD CONSTRAINT fixture_failure CHECK(action<>'update_priority') NOT VALID");
  const rollbackSnapshot = await expected(); const beforeRollback = await counts();
  await assert.rejects(update('request-rollback', { priority: 'medium' }, rollbackSnapshot), /fixture_failure/); checks++;
  check(await expected(), rollbackSnapshot, 'audit failure rolls back task');
  check(await counts(), beforeRollback, 'audit failure rolls back outbox and request receipt');
  await admin("ALTER TABLE activity_logs DROP CONSTRAINT fixture_failure; UPDATE members SET is_active=false WHERE id='actor'");
  await reject(update('request-disabled-member', { priority: 'medium' }, rollbackSnapshot), 'slack_session_unavailable', '42501');
  await admin("UPDATE members SET is_active=true WHERE id='actor'; UPDATE external_account_bindings SET is_verified=false WHERE member_id='actor'");
  await reject(update('request-unbound', { priority: 'medium' }, rollbackSnapshot), 'slack_session_unavailable', '42501');
  await admin(`UPDATE external_account_bindings SET is_verified=true WHERE member_id='actor';
    UPDATE system_settings SET value='{"slackActions":false,"approvals":true}' WHERE key='feature_toggles'`);
  await reject(update('request-disabled', { priority: 'medium' }, rollbackSnapshot), 'slack_session_unavailable', '42501');
  // Every application role uses the same member JWT, RLS and revocation gates.
  for (const role of ['member', 'admin', 'super_admin']) {
    await admin(`UPDATE members SET role='${role}',is_active=true WHERE id='actor';
      UPDATE external_account_bindings SET is_verified=true WHERE member_id='actor';
      UPDATE system_settings SET value='{"slackActions":true,"approvals":true}' WHERE key='feature_toggles'`);
    const current = await expected();
    check((await update(`matrix-${role}-allowed`, { priority: current.priority === 'high' ? 'low' : 'high' }, current)).kind, 'update', `${role} permitted update`);
    await reject(update(`matrix-${role}-hidden`, { priority: 'high' }, current, 'hidden-task'), 'slack_task_unavailable', '42501');
    check(await scalar('SELECT count(*)::int FROM slack_delivery_outbox'), 0, `${role} cannot read private delivery queue`);
    await assert.rejects(db.query('SELECT livo_slack_claim_delivery($1)', ['00000000-0000-4000-8000-000000000099']), error => error.code === '42501'); checks++;
    await admin("UPDATE external_account_bindings SET is_verified=false WHERE member_id='actor'");
    await reject(update(`matrix-${role}-revoked`, { priority: 'medium' }, await expected()), 'slack_session_unavailable', '42501');
    await admin("UPDATE external_account_bindings SET is_verified=true WHERE member_id='actor'; UPDATE members SET is_active=false WHERE id='actor'");
    await reject(update(`matrix-${role}-inactive`, { priority: 'medium' }, current), 'slack_session_unavailable', '42501');
    await admin(`UPDATE members SET is_active=true WHERE id='actor'; UPDATE system_settings SET value='{"slackActions":false}' WHERE key='feature_toggles'`);
    await reject(update(`matrix-${role}-feature-off`, { priority: 'medium' }, await expected()), 'slack_session_unavailable', '42501');
  }
  console.log(`Slack workspace PostgreSQL checks passed: ${checks} (RLS, identity, snapshots, replay, workflow, validation, atomic notifications)`);
} finally { await db.close(); }
