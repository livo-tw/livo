#!/usr/bin/env node
// Disposable local-only PostgreSQL, using the same ownership/cleanup runner as QA.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {IMAGE,runPostgres} from './test-qa-postgres.mjs';
import {buildUpgradeFile,lintUpgradeMigration} from './release-upgrades.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const BASE=['20261002_qa_workflow.sql','20261002_qa_workflow_settings.sql','20261006_deployment_environments.sql','20261007_qa_status_semantics.sql','20261002_knowledge_base.sql','20261007_knowledge_permissions.sql'];
const NEW=['20261009_knowledge_navigation.sql','20261010_knowledge_workflow.sql','20261011_knowledge_import.sql','20261012_knowledge_slack_search.sql','20261013_knowledge_import_maintenance.sql'];
const CASES=['knowledge-workflow-pg-security.sql','knowledge-navigation-pg.sql','knowledge-import-pg-security.sql','knowledge-slack-pg-security.sql','knowledge-import-maintenance-pg-security.sql'];
const read=(p)=>fs.readFileSync(path.join(ROOT,p),'utf8');
export function buildKnowledgePlan(){
  const source=[...BASE,...NEW].map(name=>{const sql=read(`supabase/migrations/${name}`);const problems=lintUpgradeMigration(sql);if(problems.length)throw new Error(`${name}: ${JSON.stringify(problems)}`);return{name,sql,sha256:createHash('sha256').update(sql).digest('hex')};});
  const migrations=source.map(({name,sql})=>buildUpgradeFile(name,sql)).join('\n');
  const available=CASES.filter(name=>fs.existsSync(path.join(ROOT,'scripts/lib',name)));
  const cases=available.map(name=>read(`scripts/lib/${name}`)).join('\n');
  const assertions=(cases.match(/SELECT\s+qa_test\.(?:check|expect_error)\s*\(/gi)||[]).length;
  if(!assertions)throw new Error('No knowledge PostgreSQL security assertions');
  const sql=['\\set ON_ERROR_STOP on','SET client_min_messages=warning;',read('scripts/lib/qa-postgres-fixture.sql'),read('scripts/lib/knowledge-workflow-pg-fixture.sql'),migrations,migrations,...source.filter(s=>NEW.includes(s.name)).map(s=>s.sql),cases,
    `RESET ROLE; SELECT jsonb_build_object('status','passed','assertions',(SELECT count(*) FROM qa_test.results));`].join('\n');
  return{sql,summary:{image:IMAGE,migrations:source.map(({name,sha256})=>({name,sha256})),migrationPasses:2,assertions,cases:available,missingCases:CASES.filter(n=>!available.includes(n)),scope:'Isolated PostgreSQL migrations twice, ACL, checklists, links, imports, preferences and Slack; no production or external Slack writes'}};
}
async function main(){const args=process.argv.slice(2);if(args.some((a,i)=>!['--run','--plan','--report'].includes(a)&&args[i-1]!=='--report'))throw new Error('Unknown option');const plan=buildKnowledgePlan();const reportPath=args.includes('--report')?args[args.indexOf('--report')+1]:undefined;const result=args.includes('--run')?await runPostgres(plan,reportPath):{...plan.summary,status:'not-run'};console.log(JSON.stringify(result));}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify(error.report??{status:'failed',error:error.message}));process.exitCode=1;});
