// Optional PostgreSQL execution check. Supply a temporary PGlite module path:
// node scripts/lib/slack-sql-check.mjs /path/to/@electric-sql/pglite/dist/index.js
// PGlite (Apache-2.0/PostgreSQL license) is a test tool, not a shipped dependency.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : '@electric-sql/pglite');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sql = name => readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
const db = new PGlite();
let checks = 0;
const check = (value, expected) => { assert.deepEqual(value, expected); checks++; };
const scalar = async query => Object.values((await db.query(query)).rows[0])[0];
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('request.jwt.claims',true)::jsonb $$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated;`);
  await db.exec(sql('20260308173019_ad17e08d-5ca0-4d6d-b511-815ac2c1889f.sql').split('-- Enable RLS')[0]);
  await db.exec(sql('20260308191828_39c47e78-a353-41e8-842b-450be9247343.sql').split('ALTER TABLE')[0]);
  await db.exec(sql('20260308185150_14e0c414-7e18-4253-a8c2-85f36c2f244e.sql').split('ALTER TABLE')[0]);
  await db.exec(sql('20260310044327_7e8def58-e082-4b3a-a28a-7a89f825960b.sql').split('CREATE INDEX')[0]);
  await db.exec(sql('20260402_bidirectional_integration.sql').split('-- 互动按钮')[0]);
  await db.exec(`ALTER TABLE members ADD COLUMN auth_id uuid, ADD COLUMN is_active boolean NOT NULL DEFAULT true;
    ALTER TABLE tasks ADD COLUMN sprint_id uuid REFERENCES sprints(id);
    CREATE TABLE system_settings(key text PRIMARY KEY,value jsonb,updated_at timestamptz DEFAULT now());
    CREATE FUNCTION current_member_id() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
      SELECT id FROM members WHERE auth_id=auth.uid() LIMIT 1 $$;
    INSERT INTO members(id,name,avatar,email,auth_id) VALUES
      ('actor','Example Actor','','actor@example.com','00000000-0000-4000-8000-000000000001'),
      ('assignee','Example Assignee','','assignee@example.com',NULL),('reviewer','Example Reviewer','','reviewer@example.com',NULL);
    INSERT INTO product_lines(id,name) VALUES('example-line','Example');
    INSERT INTO projects(id,line_id,name,key) VALUES('example-project','example-line','Example','EX'),('hidden-project','example-line','Hidden','HID');
    INSERT INTO statuses(id,name,auto_start) VALUES('todo','Todo',true);
    INSERT INTO sprints(id,name) VALUES('00000000-0000-4000-8000-000000000003','Example sprint');
    INSERT INTO external_account_bindings(id,member_id,platform,platform_user_id,platform_team_id,is_verified)
      VALUES('00000000-0000-4000-8000-000000000002','actor','slack','UEXAMPLE','TEXAMPLE',true);
    INSERT INTO tasks(id,task_key,project_id,title,status_id,creator_id) VALUES('hidden-task','HID-1','hidden-project','Hidden','todo','actor');
    GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;`);
  for (const table of ['members','projects','statuses','tasks','sprints','task_specs','status_logs','comments','notifications','activity_logs',
    'system_settings','external_account_bindings','external_action_logs','slack_thread_mappings']) {
    await db.exec(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY fixture_read ON ${table} FOR SELECT TO authenticated USING (${table==='tasks' ? "project_id<>'hidden-project'" : table==='projects' ? "id<>'hidden-project'" : 'true'});`);
    if (!['slack_thread_mappings','system_settings','external_account_bindings'].includes(table)) {
      await db.exec(`CREATE POLICY fixture_write ON ${table} FOR INSERT TO authenticated WITH CHECK (${table==='tasks' ? "creator_id=current_member_id() AND project_id<>'hidden-project'" : table==='comments' ? 'user_id=current_member_id()' : 'true'});
        CREATE POLICY fixture_update ON ${table} FOR UPDATE TO authenticated USING (true) WITH CHECK (true);`);
    }
  }
  const migration = sql('20261002_slack_actions.sql');
  await db.exec(migration); await db.exec(migration); checks++;
  const claims = { sub: '00000000-0000-4000-8000-000000000001', role: 'authenticated', livo_slack_binding: '00000000-0000-4000-8000-000000000002' };
  await db.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify(claims)]);
  const asMember = () => db.exec('SET ROLE authenticated');
  const admin = async statement => { await db.exec('RESET ROLE'); await db.exec(statement); await asMember(); };
  await asMember();
  await assert.rejects(db.exec("INSERT INTO external_account_bindings(member_id,platform,platform_user_id,platform_team_id,is_verified) VALUES('actor','slack','UFORGED','TEXAMPLE',true)"),/managed by the server/); checks++;
  const source = { team:'TEXAMPLE',channel:'CEXAMPLE',thread:'1.0' };
  const fields = { title:'Example card',project_id:'example-project',status_id:'todo',priority:'medium',assignee_id:'assignee',
    content:'<p>Example requirement</p>',preview:'Example requirement',description:'Example requirement',due_date:'2026-10-10',mentioned_ids:[] };
  const commit = async (id, kind, data, origin=source) => (await db.query('SELECT livo_slack_commit($1,$2,$3,$4) AS result',[id,kind,data,origin])).rows[0].result;
  await assert.rejects(commit('request-off','create',fields), /disabled/); checks++;
  await admin(`INSERT INTO system_settings(key,value) VALUES('feature_toggles','{"slackActions":true}')`);
  await assert.rejects(commit('request-hidden','create',{...fields,project_id:'hidden-project'})); checks++;
  const first = await commit('request-create-1','create',fields);
  check(first.task.task_key,'EX-1'); check(first.task.creator_id,'actor'); check(first.task.sort_order,0);
  check(first.task.sprint_id,'00000000-0000-4000-8000-000000000003'); assert.ok(first.task.started_at); checks++;
  check(await scalar('SELECT requirement FROM task_specs'),fields.content);
  check(await scalar('SELECT count(*)::int FROM status_logs'),1);
  check(await scalar('SELECT task_id FROM slack_thread_mappings'),first.task.id);
  check((await commit('request-create-1','create',fields)).duplicate,true);
  check(await scalar('SELECT count(*)::int FROM tasks'),1); // RLS also hides the fixture's secret card.
  check((await commit('request-create-2','create',fields)).task.task_key,'EX-2');
  await admin(`UPDATE tasks SET reviewer_id='reviewer' WHERE id='${first.task.id}'`);
  const comment = { task_id:first.task.id,text:'Example comment',content:'<p>Example comment</p>',preview:'Example comment',mentioned_ids:['actor','assignee'] };
  await commit('request-comment-1','comment',comment);
  check(await scalar('SELECT comment_count FROM tasks WHERE id='+"'"+first.task.id+"'"),1);
  check(await scalar('SELECT source FROM comments'),'slack');
  check((await db.query('SELECT recipient_id,type FROM notifications ORDER BY recipient_id')).rows,
    [{recipient_id:'assignee',type:'mention'},{recipient_id:'reviewer',type:'comment'}]);
  check(await scalar("SELECT count(*)::int FROM activity_logs WHERE action='add_comment'"),1);
  check((await commit('request-comment-1','comment',comment)).duplicate,true);
  check(await scalar('SELECT count(*)::int FROM comments'),1);
  await assert.rejects(commit('request-hidden-comment','comment',{...comment,task_id:'hidden-task'})); checks++;
  await admin("ALTER TABLE notifications ADD CONSTRAINT fixture_fail CHECK (content<>'fail-transaction')");
  await assert.rejects(commit('request-rollback','comment',{...comment,preview:'fail-transaction'})); checks++;
  check(await scalar('SELECT count(*)::int FROM comments'),1);
  check(await scalar('SELECT comment_count FROM tasks WHERE id='+"'"+first.task.id+"'"),1);
  await admin("UPDATE members SET is_active=false WHERE id='actor'");
  await assert.rejects(commit('request-inactive','comment',comment),/unavailable/); checks++;
  await admin("UPDATE members SET is_active=true WHERE id='actor'; UPDATE external_account_bindings SET is_verified=false WHERE member_id='actor'");
  await assert.rejects(commit('request-unbound','comment',comment),/unavailable/); checks++;
  await admin("UPDATE external_account_bindings SET is_verified=true WHERE member_id='actor'; UPDATE system_settings SET value='{\"slackActions\":false}' WHERE key='feature_toggles'");
  await assert.rejects(commit('request-disabled','comment',comment),/disabled/); checks++;
  check(await scalar('SELECT count(*)::int FROM external_action_logs'),3);
  console.log(`PostgreSQL checks passed: ${checks} (idempotency, RLS, numbering, flags, atomic side effects)`);
} finally { await db.close(); }
