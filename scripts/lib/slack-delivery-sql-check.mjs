// Executes the real Docker migrations in disposable, local PostgreSQL (PGlite).
// Pass a temporary @electric-sql/pglite module path; this is not a shipped dependency.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : '@electric-sql/pglite');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sql = name => readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
const db = new PGlite();
let checks = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const scalar = async (query, params = []) => Object.values((await db.query(query, params)).rows[0])[0];
const count = (where = 'true') => scalar(`SELECT count(*)::int FROM slack_delivery_outbox WHERE ${where}`);
const personal = id => count(`task_id='${id}' AND target_type='member'`);
const config = { enabled: true, teamId: 'TEXAMPLE', dmEnabled: true, routes: [{ lineId: 'line', channelId: 'CEXAMPLE' }] };
const configure = value => db.query("INSERT INTO system_settings(key,value) VALUES('slack_delivery',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [JSON.stringify(value)]);
const create = (id, assignee = 'actor', reviewer = null, state = 'todo', due = null, project = 'project') => db.query(
  'INSERT INTO tasks(id,task_key,project_id,title,status_id,creator_id,assignee_id,reviewer_id,due_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [id, `EX-${id}`, project, `Example ${id}`, state, 'actor', assignee, reviewer, due]);
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claims',true)::jsonb $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;`);
  await db.exec(sql('20260308173019_ad17e08d-5ca0-4d6d-b511-815ac2c1889f.sql').split('-- Enable RLS')[0]);
  await db.exec(sql('20260308191828_39c47e78-a353-41e8-842b-450be9247343.sql').split('ALTER TABLE')[0]);
  await db.exec(sql('20260308185150_14e0c414-7e18-4253-a8c2-85f36c2f244e.sql').split('ALTER TABLE')[0]);
  await db.exec(sql('20260310044327_7e8def58-e082-4b3a-a28a-7a89f825960b.sql').split('CREATE INDEX')[0]);
  await db.exec(sql('20260402_bidirectional_integration.sql').split('-- 互动按钮')[0]);
  await db.exec(`ALTER TABLE members ADD COLUMN auth_id uuid, ADD COLUMN is_active boolean NOT NULL DEFAULT true;
    ALTER TABLE tasks ADD COLUMN sprint_id uuid REFERENCES sprints(id);
    CREATE TABLE system_settings(key text PRIMARY KEY,value jsonb,updated_at timestamptz DEFAULT now());
    CREATE TABLE backup_settings(task_notify_types text[]);
    CREATE FUNCTION current_member_id() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
      SELECT id FROM members WHERE auth_id=auth.uid() LIMIT 1 $$;
    INSERT INTO members(id,name,avatar,auth_id) VALUES('actor','Example Actor','','00000000-0000-4000-8000-000000000001'),('other','Other','','00000000-0000-4000-8000-000000000003');
    INSERT INTO product_lines(id,name) VALUES('line','Example'),('outside','Outside');
    INSERT INTO projects(id,line_id,name,key) VALUES('project','line','Example','EX'),('outside','outside','Outside','OTHER');
    INSERT INTO statuses(id,name,is_done) VALUES('todo','Todo',false),('review','待驗收',false),('discuss','待討論確認',false),('deploy','等待部署',false),('done','Done',true),('cancelled','已取消',false);
    INSERT INTO system_settings(key,value) VALUES('feature_toggles','{"slackActions":true}');`);
  for (const name of ['20261002_slack_actions.sql', '20261002_slack_manual_binding.sql', '20261003_slack_delivery_outbox.sql', '20261003_slack_required_fields.sql']) {
    await db.exec(sql(name));
    if (name.startsWith('20261003_')) { await db.exec(sql(name)); checks++; }
  }
  const migration = sql('20261004_slack_notification_parity.sql');
  await db.exec(migration); await db.exec(migration); checks++;
  await db.exec(`INSERT INTO external_account_bindings(id,member_id,platform,platform_user_id,platform_team_id,is_verified,verified_by)
    VALUES('00000000-0000-4000-8000-000000000002','actor','slack','UEXAMPLE','TEXAMPLE',true,'admin'),
      ('00000000-0000-4000-8000-000000000004','other','slack','UOTHER','TEXAMPLE',true,'email');`);
  const claims = { sub: '00000000-0000-4000-8000-000000000001', role: 'authenticated',
    livo_slack_binding: '00000000-0000-4000-8000-000000000002', livo_slack_source: { channel: 'CEXAMPLE' } };
  await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify(claims)]);
  await create('before'); check(await count(), 0, 'upgrade does not enable or backfill');
  await configure(config);
  await create('both', 'actor', 'actor');
  check(await personal('both'), 1, 'self assignment plus reviewer has one DM');
  check(await scalar("SELECT jsonb_array_length(payload->'recipientRules') FROM slack_delivery_outbox WHERE task_id='both' AND target_type='member'"), 2, 'both reasons retained');
  check(await count("task_id='both' AND target_type='channel'"), 1, 'channel event retained');
  const old = await count();
  await db.exec(`INSERT INTO notifications(recipient_id,sender_id,type,task_id,content) VALUES
    ('actor','actor','assign','both','Example'),('actor','actor','review','both','Example'),('actor','other','status_changed','both','Example');`);
  check(await count(), old, 'legacy UI inserts do not duplicate task DMs');
  await db.exec("INSERT INTO notifications(recipient_id,sender_id,type,task_id,content) VALUES('actor','actor','due_soon','both','Due soon')");
  check(await count(), old + 1, 'system reminder with same sender survives');
  await db.exec("UPDATE tasks SET title=title,assignee_id=assignee_id,reviewer_id=reviewer_id WHERE id='both'");
  check(await count(), old + 1, 'unchanged update is silent');
  let before = await personal('both');
  await db.exec("UPDATE tasks SET assignee_id='other' WHERE id='both'");
  check(await personal('both'), before + 1, 'API assignment creates one new recipient');
  check(await scalar("SELECT target_id FROM slack_delivery_outbox WHERE task_id='both' AND target_type='member' ORDER BY id DESC LIMIT 1"), 'other', 'old owner not re-notified');
  before = await personal('both');
  await db.exec("UPDATE tasks SET reviewer_id=NULL WHERE id='both'");
  check(await personal('both'), before, 'removal creates no assignment DM');
  await db.exec("UPDATE tasks SET reviewer_id='actor',status_id='review' WHERE id='both'");
  check(await personal('both'), before + 1, 'reviewer change plus handoff coalesces');
  check(await scalar("SELECT jsonb_array_length(payload->'recipientRules') FROM slack_delivery_outbox WHERE task_id='both' AND target_type='member' ORDER BY id DESC LIMIT 1"), 2, 'review reason and handoff retained');
  for (const state of ['discuss', 'deploy']) {
    await db.query("UPDATE tasks SET status_id=$1 WHERE id='both'", [state]);
    check(await scalar("SELECT target_id FROM slack_delivery_outbox WHERE task_id='both' AND target_type='member' ORDER BY id DESC LIMIT 1"), 'other', `${state} handoff uses assignee`);
  }
  await configure({ ...config, handoffRoles: { deploy: 'reviewer' } });
  check(await scalar("SELECT livo_slack_handoff_role('deploy',(SELECT value FROM system_settings WHERE key='slack_delivery'))"), 'reviewer', 'explicit status mapping');
  await configure(config);
  before = await count();
  await db.exec("BEGIN; UPDATE tasks SET assignee_id='actor' WHERE id='both'; ROLLBACK;");
  check(await count(), before, 'business rollback also rolls back notifications');
  await db.exec("SELECT set_config('livo.slack_silent','true',false); UPDATE tasks SET title='Silent import' WHERE id='both'; SELECT set_config('livo.slack_silent','false',false);");
  check(await count(), before, 'controlled import is silent');
  await configure({ ...config, dmEnabled: false });
  await create('off'); check(await personal('off'), 0, 'DM off');
  await configure(config); check(await personal('off'), 0, 'enabling does not backfill');
  await configure({ ...config, dmMemberIds: ['actor'] });
  await create('allowlist', 'other'); check(await personal('allowlist'), 0, 'recipient allowlist');
  await configure(config);
  await create('outside', 'actor', null, 'todo', null, 'outside'); check(await personal('outside'), 0, 'outside route');
  // Use the real Slack commit RPC and replay it: no frontend notification insertion.
  const args = ['parity-slack-create', 'create', JSON.stringify({ title: 'Slack created', project_id: 'project', status_id: 'todo', priority: 'medium', assignee_id: 'actor' }),
    JSON.stringify({ team: 'TEXAMPLE', channel: 'CEXAMPLE', thread: '' })];
  const result = await scalar('SELECT livo_slack_commit($1,$2,$3,$4)', args);
  check(await personal(result.task.id), 1, 'Slack-created self assignment');
  before = await count(); check((await scalar('SELECT livo_slack_commit($1,$2,$3,$4)', args)).duplicate, true, 'Slack request replay');
  check(await count(), before, 'replay creates no additional delivery');
  // Reports contain overdue and Mon-Sun tasks, with reviewer ownership in review.
  for (const values of [
    ['overdue', 'actor', null, 'todo', '2026-10-04'], ['sunday', 'actor', null, 'todo', '2026-10-11'],
    ['nextweek', 'actor', null, 'todo', '2026-10-12'], ['done', 'actor', null, 'done', '2026-10-06'],
    ['cancelled', 'actor', null, 'cancelled', '2026-10-06'], ['reviewing', 'other', 'actor', 'review', '2026-10-08'],
    ['unassigned', null, null, 'todo', '2026-10-07'], ['completed', 'actor', null, 'todo', '2026-10-07'],
  ]) await create(...values);
  await db.exec("UPDATE tasks SET completed_at='2026-10-01' WHERE id='completed'");
  const report = await scalar("SELECT livo_slack_weekly_tasks('actor','2026-10-05')");
  check(report.map(t => t.taskId), ['overdue', 'reviewing', 'sunday'], 'report scope and role');
  await configure({ ...config, weekly: { enabled: true, startDate: '2026-10-05' } });
  check(await scalar("SELECT livo_slack_queue_weekly('2026-10-05T08:59:59+08:00')"), 0, 'not before 09:00 Taipei');
  check(await scalar("SELECT livo_slack_queue_weekly('2026-09-28T09:00:00+08:00')"), 0, 'not before explicit start');
  check(await scalar("SELECT livo_slack_queue_weekly('2026-10-05T09:00:00+08:00')"), 1, 'one Monday report');
  check(await scalar("SELECT livo_slack_queue_weekly('2026-10-05T16:00:00+08:00')"), 0, 'Monday retries deduplicate');
  check(await scalar("SELECT livo_slack_queue_weekly('2026-10-06T09:00:00+08:00')"), 0, 'no Tuesday backlog');
  await db.exec("UPDATE projects SET is_archived=true WHERE id='project'");
  check(await scalar("SELECT livo_slack_weekly_tasks('actor','2026-10-05')"), [], 'archived project removed before send');
  await db.exec("UPDATE projects SET is_archived=false WHERE id='project'; UPDATE tasks SET assignee_id='other' WHERE id='overdue'");
  check((await scalar("SELECT livo_slack_weekly_tasks('actor','2026-10-05')")).map(t => t.taskId), ['reviewing', 'sunday'], 'late reassignment removed before send');
  // Existing durable receipt contract: replies preserve the original root row.
  const owner = '00000000-0000-4000-8000-000000000009';
  const first = await scalar('SELECT to_jsonb(q) FROM livo_slack_claim_delivery($1) q', [owner]);
  check(await scalar('SELECT livo_slack_finish_delivery($1,$2,$3,$4,$5,$6)', [first.id, owner, 'sent', 'CEXAMPLE', '1791158400.000001', '1791158400.000001']), true, 'receipt persisted');
  check(await scalar("SELECT count(*)::int FROM slack_thread_mappings WHERE slack_thread_ts='1791158400.000001'"), 1, 'one root mapping');
  for (const signature of ['livo_slack_queue_weekly(timestamp with time zone)', 'livo_slack_weekly_tasks(text,date)', 'livo_slack_claim_delivery(uuid)']) {
    check(await scalar("SELECT has_function_privilege('authenticated',$1,'EXECUTE')", [signature]), false, 'member cannot enqueue or drain private deliveries');
  }
  console.log(`PostgreSQL notification checks passed: ${checks} (real migrations, repeat upgrade, task/Slack entrypoints, private recipients, schedule, receipts)`);
} finally { await db.close(); }
