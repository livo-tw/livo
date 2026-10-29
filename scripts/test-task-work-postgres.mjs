#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {runPostgres} from './task-work-postgres-runtime.mjs';
import {buildTaskWorkPostgresCases} from './lib/task-work-postgres-cases.mjs';
import {buildSprintPostgresCases} from './lib/sprint-postgres-cases.mjs';
import {buildSprintClearPostgresCases} from './lib/sprint-clear-postgres-cases.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function buildTaskWorkPlan(){
 const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
 const names=['20260402_approval_workflow.sql','20260404_approval_requests_nullable_rule.sql','20261001_feature_toggles.sql','20261002_slack_actions.sql','20261003_slack_delivery_outbox.sql','20261004_slack_notification_parity.sql','20260713_permission_floor.sql','20261009_atomic_approval_commands.sql','20261010_task_reminder_preferences.sql','20261006_deployment_environments.sql','20261011_task_work_commands.sql',
  '20261017_notification_sender_guard.sql','20261018_notification_update_guard.sql','20261018_comment_author_guard.sql','20261017_task_work_project_move.sql','20261017_task_work_subtask_required_fields.sql','20261018_approval_rule_fk_and_subtask_move.sql','20261019_active_member_gate.sql','20261108_task_work_subtask_details.sql','20261108_zz_sprint_clear_guard_compat.sql','20261109_sprint_lifecycle.sql'];
 // Reapply every TaskWork migration with Windows CRLF to cover SQL-body anchor portability.
 const workStart=names.indexOf('20261011_task_work_commands.sql');
 const migrations=names.map(name=>({name,sql:read('supabase/migrations/'+name)}));
 // The shipped install default (title/project/dueDate required), not a test-only '{}'.
 const shippedRequired=read('supabase/migrations/20260327_add_required_fields_and_theme.sql').match(/'required_fields',\s*'(\{[^']*\})'/)?.[1];
 if(!shippedRequired)throw new Error('Shipped required_fields default not found');
 const cases=buildTaskWorkPostgresCases({shippedRequired}),sprints=buildSprintPostgresCases(),clear=buildSprintClearPostgresCases({read}),prior=migrations.slice(0,workStart),work=migrations.slice(workStart);
 return {
  sql:["SET client_min_messages=warning; SET statement_timeout='20s'; SET lock_timeout='3s';",read('scripts/lib/task-work-postgres-fixture.sql'),
   ...prior.map(m=>m.sql),"INSERT INTO slack_delivery_outbox(event_key,team_id,task_id,target_type,target_id,payload) VALUES('legacy-before-rerun','TTEST','t-1','member','member','{\"kind\":\"personal\",\"recipientRules\":[{\"role\":\"assignee\",\"code\":\"assigned\"}]}');",...work.map(m=>m.sql),"INSERT INTO work_test.saved SELECT 'sprint-cancel-first',jsonb_build_object('s7',(SELECT is_cancelled FROM statuses WHERE id='s7'),'namespaced',(SELECT is_cancelled FROM statuses WHERE id='aabbccdd-s7'),'custom',(SELECT is_cancelled FROM statuses WHERE id='made-up-s7')); UPDATE statuses SET is_cancelled=false WHERE id='s7';",...work.map(m=>m.sql.replace(/\r?\n/g,'\r\n')),'SET check_function_bodies=on;',cases.sql,sprints.sql,clear.sql].join('\n'),
  summary:{assertions:cases.labels.length+sprints.labels.length+clear.labels.length,sprintAssertions:sprints.labels.length,sprintMigrationApplications:2,engine:'native PostgreSQL 15.8',migrations:migrations.map(m=>({name:m.name,sha256:createHash('sha256').update(m.sql).digest('hex')})),roles:['member','admin','super_admin'],taskWorkMigrationApplications:2,taskWorkMigrationLineEndings:['source','CRLF'],realTwoSessionRaces:cases.races+sprints.races+clear.races,sprintRealTwoSessionRaces:sprints.races,clearRealTwoSessionRaces:clear.races,clearAssertions:clear.labels.length,clearReleasedSourceFiles:clear.files,
   fixture:'synthetic relevant typed tables + actual permission-floor, approval, planning, TaskWork migrations and released QA/release/KB clear chain; not full production bootstrap',authorization:'service-only RPC explicit live business floor; authenticated direct-write RLS tested separately',
   excluded:['GoTrue/PostgREST HTTP authentication','Slack delivery','unrelated digest/delivery function bodies','multi-workspace PostgreSQL (single-workspace schema)']}
 };
}
async function main(){
 const args=process.argv.slice(2),plan=buildTaskWorkPlan();
 const result=args.includes('--run')?await runPostgres(plan,args.includes('--report')?(args.includes('--report')?args[args.indexOf('--report')+1]:undefined):undefined):plan.summary;
 console.log(JSON.stringify(result));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(JSON.stringify(e.report??{status:'failed',error:e.message}));process.exitCode=1;});
