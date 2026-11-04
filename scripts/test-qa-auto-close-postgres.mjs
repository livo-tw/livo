import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runPostgres } from './task-work-postgres-runtime.mjs';
import { runNativePostgres } from './native-postgres-runtime.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const q=value=>"'"+String(value).replaceAll("'","''")+"'";
const j=value=>q(JSON.stringify(value))+'::jsonb';
export function plan(){
 const migrationName='20261102_qa_verification_auto_close.sql',migration=read('supabase/migrations/'+migrationName);
 const sql=[],labels=[];const raw=value=>sql.push(value);
 const check=(label,expression)=>{labels.push(label);raw(`SELECT qa_test.check((${expression}),${q(label)});`);};
 const error=(label,statement,code,message='')=>{labels.push(label);raw(`SELECT qa_test.expect_error(${q(label)},${q(statement)},${q(code)},${q(message)});`);};
 const at='2026-11-02T01:00:00.000Z',nextAt='2026-11-02T01:01:00.000Z';
 const ids={member:'m-member',admin:'m-admin',super:'m-super',outsider:'m-assignee'},uids={member:1,admin:2,super:3,outsider:4};
 const auth=actor=>q(`00000000-0000-0000-0000-00000000000${uids[actor]}`)+'::uuid';
 const target=id=>({id,environment:id==='stage'?'Stage':'Prod',component:'app',build:'example-build',required:true,deployedAt:at,deployedBy:'m-assignee',deploymentEvidence:''});
 const run=(targetId,sequence=1,result='pass',testerId='m-member',createdAt=at)=>({id:'example-run-'+sequence,sequence,fixCycle:1,targetId,environment:targetId==='stage'?'Stage':'Prod',component:'app',build:'example-build',result,note:'',testerId,createdAt});
 const before=id=>({id,workspaceId:'default',projectId:'p-test',state:'verification',reporterId:'m-member',assigneeId:'m-assignee',qaOwnerId:'m-member',title:'Example formal QA',actual:'Example report',observedEnvironment:'Stage',observedVersion:'example-build',steps:'',expected:'',component:'',severity:'high',priority:3,dueDate:null,fixCycle:1,fixSummary:'Example fix',targets:[target('stage'),target('prod')],runs:[run('stage')],taskIds:[],resolution:null,resolutionReason:'',duplicateOfId:null,closedAt:null,closedBy:null,reopenedAt:null,holdReason:'',reopenReason:'',version:1,createdAt:at,updatedAt:at,handoff:null,customFields:{}});
 const verify=(b,actor='member',targetId='prod',result='pass')=>{const a={...b,version:2,updatedAt:nextAt,runs:[...b.runs,run(targetId,Math.max(0,...b.runs.map(v=>v.sequence))+1,result,ids[actor],nextAt)]};
  const passed=a.targets.filter(t=>t.required).every(t=>t.deployedAt&&[...a.runs].reverse().find(v=>v.targetId===t.id&&v.fixCycle===a.fixCycle)?.result==='pass');
  if(result==='fail'){a.state='failed';a.reopenedAt=nextAt;}
  else if(result==='pass'&&passed){a.state='closed';a.resolution='fixed';a.closedAt=nextAt;a.closedBy=ids[actor];}
  else a.state=passed?'verified':'verification';return a;};
 const seed=b=>raw(`INSERT INTO qa_issues(id,project_id,state,reporter_id,assignee_id,qa_owner_id,title,version,updated_at,data) VALUES(${q(b.id)},'p-test',${q(b.state)},${q(b.reporterId)},${q(b.assigneeId)},${q(b.qaOwnerId)},${q(b.title)},1,${q(at)}::timestamptz,${j(b)});`);
 let sequence=0;
 const call=(b,a,actor='member',command='auto-close-command-'+(++sequence),expected=1,type='record_verification',hash='a'.repeat(64))=>`public.livo_qa_commit(${auth(actor)},${q(b.id)},${q(command)},${q(hash)},${expected},'command',${j(a)},${j({id:'event-'+command,type,detail:type==='record_verification'?'Formal verification; automatically closed after required PASS':'Manual state change',recipients:[]})})`;
 raw('SET ROLE service_role;');
 for(const actor of ['member','admin','super']){
  const b=before('example-final-'+actor),a=verify(b,actor);seed(b);const c=call(b,a,actor,'final-pass-'+actor);
  check(actor+' formal last PASS closes exact aggregate',`${c}=${j(a)}`);
  check(actor+' exact receipt replays once',`${c}=${j(a)}`);
  check(actor+' closure and original deployment evidence readback',`(SELECT state='closed' AND data=${j(a)} FROM qa_issues WHERE id=${q(b.id)})`);
  check(actor+' only one audit and receipt for final PASS',`(SELECT count(*) FROM qa_events WHERE issue_id=${q(b.id)} AND type='record_verification')=1 AND (SELECT count(*) FROM qa_commands WHERE issue_id=${q(b.id)})=1`);
  error(actor+' new close on already closed is a clear permission error','SELECT '+call(a,{...a,version:3},actor,'already-closed-'+actor,2,'close'),'42501','qa_forbidden');
 }
 const partial=before('example-partial');partial.runs=[];seed(partial);const partialAfter=verify(partial,'member','stage');
 check('partial PASS remains pending with no closure',`${call(partial,partialAfter)}=${j(partialAfter)} AND ${j(partialAfter)}->>'closedAt' IS NULL`);
 for(const result of ['fail','blocked']){const b=before('example-'+result);seed(b);const a=verify(b,'member','prod',result);check(result+' preserves open workflow without closure',`${call(b,a)}=${j(a)} AND ${j(a)}->>'closedAt' IS NULL`);}
 const invalids=[
  ['empty deployment',b=>{b.targets[1].deployedAt='';return b;},a=>a,'qa_not_deployed'],
  ['null run id',b=>b,a=>{a.runs.at(-1).id=null;return a;},'qa_invalid_request'],
  ['numeric run id',b=>b,a=>{a.runs.at(-1).id=123;return a;},'qa_invalid_request'],
  ['missing deployment',b=>{b.targets[1].deployedAt=null;return b;},a=>a,'qa_not_deployed'],
  ['wrong build',b=>b,a=>{a.runs.at(-1).build='stale-example';return a;},'qa_invalid_request'],
  ['old cycle',b=>b,a=>{a.runs.at(-1).fixCycle=0;return a;},'qa_invalid_request'],
  ['fake actor',b=>b,a=>{a.closedBy='m-assignee';return a;},'qa_invalid_request'],
  ['fake timestamp',b=>b,a=>{a.closedAt=at;return a;},'qa_invalid_request'],
  ['rewritten history',b=>b,a=>{a.runs[0]={...a.runs[0],note:'tampered'};return a;},'qa_invalid_request'],
  ['missing prior required PASS',b=>{b.runs=[];return b;},a=>({...a,state:'closed',resolution:'fixed',closedAt:nextAt,closedBy:'m-member'}),'qa_invalid_request'],
  ['old prior cycle',b=>{b.runs[0].fixCycle=0;return b;},a=>({...a,state:'closed',resolution:'fixed',closedAt:nextAt,closedBy:'m-member'}),'qa_invalid_request'],
  ['old prior build',b=>{b.runs[0].build='old-example';return b;},a=>({...a,state:'closed',resolution:'fixed',closedAt:nextAt,closedBy:'m-member'}),'qa_invalid_request'],
 ];
 for(const [label,changeBefore,changeAfter,message] of invalids){const b=changeBefore(before('example-invalid-'+(++sequence)));seed(b);const a=changeAfter(verify(b));
  error(label+' is rejected atomically','SELECT '+call(b,a),'22023',message);
  check(label+' leaves issue audit and receipt untouched',`(SELECT data=${j(b)} FROM qa_issues WHERE id=${q(b.id)}) AND (SELECT count(*) FROM qa_events WHERE issue_id=${q(b.id)})=0 AND (SELECT count(*) FROM qa_commands WHERE issue_id=${q(b.id)})=0`);}
 const unauthorized=before('example-outsider');seed(unauthorized);error('unrelated member cannot verify or close','SELECT '+call(unauthorized,verify(unauthorized,'outsider'),'outsider'),'42501','member_inactive');
 const stale=before('example-stale');seed(stale);error('stale expected version keeps CAS guard','SELECT '+call(stale,verify(stale),'member','stale-version',0),'PT409','version_conflict');
 const manual=before('example-manual');manual.targets=[];manual.runs=[];manual.fixCycle=0;seed(manual);const manualAfter={...manual,version:2,state:'verified',updatedAt:nextAt};
 check('manual PASS remains open and invents no verification',`${call(manual,manualAfter,'member','manual-pass',1,'set_state')}=${j(manualAfter)}`);
 const historical={...manual,id:'example-history',state:'verified',legacySource:{system:'slack_list',originalStatus:'PASS',recordId:'EXAMPLE-1',snapshotSha256:'a'.repeat(64)}};seed(historical);
 raw('RESET ROLE;SET ROLE authenticated;');
 for(const actor of ['member','admin','super']){raw(`SELECT set_config('request.jwt.claim.sub',${q(`00000000-0000-0000-0000-00000000000${uids[actor]}`)},false);`);
  error(actor+' session cannot bypass service-only commit','SELECT '+call(stale,verify(stale,actor),actor),'42501','permission denied');
 }
 raw('RESET ROLE;'+migration);raw('SET ROLE service_role;');
 check('second migration application preserves historical PASS',`(SELECT data=${j(historical)} FROM qa_issues WHERE id=${q(historical.id)})`);
 check('second migration preserves manual PASS metadata',`(SELECT data=${j(manualAfter)} FROM qa_issues WHERE id=${q(manual.id)})`);
 check('second migration preserves finalized closure receipt',`${call(before('example-final-member'),verify(before('example-final-member')),'member','final-pass-member')}=${j(verify(before('example-final-member')))}`);
 raw(`SELECT json_build_object('status','passed','assertions',(SELECT count(*) FROM qa_test.results));`);
 const dependencies=['20261002_qa_workflow.sql','20261012_qa_coordination.sql','20261029_deployment_queue_operators.sql'];
 const prefix=[read('scripts/lib/qa-postgres-fixture.sql'),read('supabase/migrations/20261006_deployment_environments.sql').split('CREATE OR REPLACE FUNCTION public.livo_guard_deployment_environment_setting')[0],
  "CREATE TABLE public.external_account_bindings(id uuid PRIMARY KEY,member_id text,platform text,is_verified boolean,verified_by text,platform_team_id text,platform_user_id text);",
  read('supabase/migrations/'+dependencies[0]),read('supabase/migrations/20261007_qa_status_semantics.sql'),read('supabase/migrations/'+dependencies[1]).split('CREATE OR REPLACE FUNCTION public.livo_qa_save_coordination')[0],
  read('supabase/migrations/'+dependencies[2]).split('-- Preserve the complete existing QA command contract')[0],migration];
 return {sql:['SET client_min_messages=warning;',...prefix,...sql].join('\n'),summary:{assertions:labels.length,migrationApplications:2,migrations:[{name:migrationName,sha256:createHash('sha256').update(migration).digest('hex')}],fixture:'Disposable local PostgreSQL 15; real enum and UUID actors, latest unmodified source RPC with new formal-verification guard',excluded:['GoTrue/PostgREST transport','full production permission-floor bootstrap','HT production database','real Slack delivery']}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),p=plan(),option=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
 (args.includes('--native')?runNativePostgres(p,{binaryDir:option('--pg-bin')??process.env.LIVO_TEST_PG_BIN,clientPackage:option('--pg-client-package')??process.env.LIVO_TEST_PG_CLIENT_PACKAGE,reportPath:option('--report')}):args.includes('--run')?runPostgres(p,option('--report')):Promise.resolve(p.summary))
 .then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(JSON.stringify(error.report??{error:error.message}));process.exitCode=1;});
}
