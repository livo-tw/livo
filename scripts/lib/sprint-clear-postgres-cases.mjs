// Run after the ordinary TaskWork/Sprint cases in the same disposable database.
// Real released clear definitions are extracted, never reconstructed as mocks.
const q=value=>"'"+String(value).replaceAll("'","''")+"'";
const hashSource=name=>`supabase/migrations/${name}`;
export function buildSprintClearPostgresCases({read}) {
 const files={task:'20261011_task_work_commands.sql',qa:'20261012_qa_coordination.sql',release:'20261013_release_workspace.sql',knowledge:'20261017_knowledge_jira_clear_guard.sql',compat:'20261108_zz_sprint_clear_guard_compat.sql',sprint:'20261109_sprint_lifecycle.sql'};
 const sources=Object.fromEntries(Object.entries(files).map(([key,name])=>[key,read(hashSource(name)).replace(/\r\n/g,'\n')]));
 const extract=(source,start,end)=>{
  const offset=source.indexOf(start),finish=source.indexOf(end,offset);
  if(offset<0||finish<0||source.indexOf(start,offset+start.length)>=0)throw new Error('Released clear extraction anchor changed');
  return source.slice(offset,finish+end.length);
 };
 const grant='GRANT EXECUTE ON FUNCTION public.livo_jira_clear_tasks() TO service_role;';
 const task=extract(sources.task,'CREATE OR REPLACE FUNCTION public.livo_jira_clear_tasks()',grant);
 const qa=extract(sources.qa,'CREATE OR REPLACE FUNCTION public.livo_jira_clear_tasks()',grant);
 const release=extract(sources.release,"DO $$ BEGIN\n IF to_regprocedure('public.livo_jira_clear_tasks_pre_release()')",grant);
 const knowledge=sources.knowledge;
 const resetAliases='DROP FUNCTION IF EXISTS public.livo_jira_clear_tasks_pre_knowledge_guard(); DROP FUNCTION IF EXISTS public.livo_jira_clear_tasks_pre_release();';
 const chain=[resetAliases,qa,release,knowledge].join('\n');
 const fixed=[chain,sources.compat,sources.sprint].join('\n');
 const crlf=s=>s.replace(/\r?\n/g,'\r\n');
 const sql=[],labels=[];let races=0;
 const raw=s=>sql.push(s);
 const check=(label,expression)=>{labels.push(label);raw('SELECT work_test.check(('+expression+'),'+q(label)+');');};
 const probe=(label,body,message=null,state=null)=>{
  labels.push(label);
  raw('INSERT INTO work_test.saved SELECT '+q(label)+',clear_test.probe('+q(body)+','+q(message??'')+','+q(state??'')+');');
  raw('SELECT work_test.check((result->>\'ok\')::boolean,'+q(label)+') FROM work_test.saved WHERE label='+q(label)+';');
  raw('UPDATE work_test.results SET detail=(SELECT result::text FROM work_test.saved WHERE label='+q(label)+') WHERE label='+q(label)+' AND NOT ok;');
 };
 const assert=(expression,message)=>`DO $assert$ BEGIN IF NOT (${expression}) THEN RAISE EXCEPTION ${q(message)}; END IF; END $assert$;`;
 raw("RESET ROLE; SET request.jwt.claim.sub=''; SET request.jwt.claim.role=''; SET request.jwt.claims='{}';");
 raw(read('scripts/lib/sprint-clear-postgres-fixture.sql'));
 raw(`CREATE SCHEMA clear_test;
 CREATE FUNCTION clear_test.probe(body text,expected_message text,expected_state text) RETURNS jsonb LANGUAGE plpgsql AS $probe$
 DECLARE actual text;code text;passed boolean:=false;
 BEGIN
  BEGIN
   EXECUTE body;
   passed:=expected_message='';
   RAISE EXCEPTION 'restore isolated clear probe' USING ERRCODE='ZC001';
  EXCEPTION WHEN SQLSTATE 'ZC001' THEN NULL;
   WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=MESSAGE_TEXT,code=RETURNED_SQLSTATE;
    passed:=expected_message<>'' AND actual=expected_message AND (expected_state='' OR code=expected_state);
  END;
  RETURN jsonb_build_object('ok',passed,'actual',actual,'state',code);
 END $probe$;`);
 // This RED regression is expected to reject the unmodified released migration.
 probe('clear real KB release QA chain exposes original sprint anchor failure',chain+'\n'+sources.sprint,'sprint_clear_guard_anchor_changed','P0001');
 probe('clear actual TaskWork direct implementation accepts compatibility',task+'\n'+sources.compat+'\n'+sources.sprint);
 probe('clear actual QA direct implementation accepts compatibility',qa+'\n'+sources.compat+'\n'+sources.sprint);
 probe('clear already guarded direct implementation reruns compatibility',qa+'\n'+sources.compat+'\n'+sources.sprint+'\n'+sources.compat);
 probe('clear real KB release QA chain applies and repeats without alias replacement',fixed+'\n'+sources.compat+'\n'+sources.sprint+'\n'+sources.compat+'\n'+assert("position('public.sprint_command_receipts' IN (SELECT prosrc FROM pg_proc WHERE oid='public.livo_jira_clear_tasks()'::regprocedure))>0",'missing executable sprint guard'));
 probe('clear genuine CRLF chain and both migrations rerun',crlf(chain)+'\n'+crlf(sources.compat)+'\n'+crlf(sources.sprint)+'\n'+crlf(sources.compat));
 probe('clear preserves function OID owner ACL COST and search path',chain+`
 ALTER FUNCTION public.livo_jira_clear_tasks() OWNER TO service_role;
 ALTER FUNCTION public.livo_jira_clear_tasks() COST 137;
 CREATE TEMP TABLE clear_metadata_before ON COMMIT DROP AS SELECT oid,proowner,proacl,procost,proconfig FROM pg_proc WHERE oid='public.livo_jira_clear_tasks()'::regprocedure;
 `+sources.compat+'\n'+sources.sprint+'\n'+sources.compat+'\n'+assert("(SELECT to_jsonb(p)=to_jsonb(b) FROM (SELECT oid,proowner,proacl,procost,proconfig FROM pg_proc WHERE oid='public.livo_jira_clear_tasks()'::regprocedure)p CROSS JOIN clear_metadata_before b)",'function metadata changed'));
 const fake=`CREATE OR REPLACE FUNCTION public.livo_jira_clear_tasks() RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $fake$
 BEGIN -- IF EXISTS(SELECT 1 FROM public.task_work_events) OR EXISTS(SELECT 1 FROM public.task_work_receipts) THEN
 RETURN '{}'::jsonb; END $fake$;`;
 probe('clear unknown implementation with fake comment anchor is rejected',fake+'\n'+sources.compat,'sprint_clear_compat_unknown_wrapper','P0001');
 probe('clear lone CR within service role literal remains unknown',chain.replace("'service_role' THEN RAISE EXCEPTION 'knowledge_forbidden'","'service_\rrole' THEN RAISE EXCEPTION 'knowledge_forbidden'")+'\n'+sources.compat,'sprint_clear_compat_unknown_wrapper','P0001');
 probe('clear unknown release delegate is rejected',chain+`\nDO $change$ BEGIN EXECUTE replace(pg_get_functiondef('public.livo_jira_clear_tasks_pre_knowledge_guard()'::regprocedure),'BEGIN','BEGIN PERFORM 1;'); END $change$;\n`+sources.compat,'sprint_clear_compat_unknown_delegate','P0001');
 probe('clear missing function is rejected','DROP FUNCTION public.livo_jira_clear_tasks();\n'+sources.compat,'sprint_clear_compat_missing_function','P0001');
 probe('clear changed security definer is rejected',chain+'\nALTER FUNCTION public.livo_jira_clear_tasks() SECURITY DEFINER;\n'+sources.compat,'sprint_clear_compat_security_changed','P0001');
 probe('clear changed search path is rejected',chain+'\nALTER FUNCTION public.livo_jira_clear_tasks() SET search_path=public,pg_catalog;\n'+sources.compat,'sprint_clear_compat_security_changed','P0001');
 probe('clear added anon grant is rejected',chain+'\nGRANT EXECUTE ON FUNCTION public.livo_jira_clear_tasks() TO anon;\n'+sources.compat,'sprint_clear_compat_security_changed','P0001');
 probe('clear added authenticated grant is rejected',chain+'\nGRANT EXECUTE ON FUNCTION public.livo_jira_clear_tasks() TO authenticated;\n'+sources.compat,'sprint_clear_compat_security_changed','P0001');
 // Each preservation probe rolls its complete DDL/DML back, including TRUNCATE.
 const empty=`TRUNCATE public.tasks,public.sprints,public.task_work_events,public.task_work_receipts,public.sprint_command_receipts CASCADE;
 DELETE FROM public.task_deadline_history; DELETE FROM public.task_reminder_preferences; DELETE FROM public.approval_requests;`;
 const invoke='SET LOCAL ROLE service_role; SELECT public.livo_jira_clear_tasks();';
 probe('clear genuine knowledge link guard remains executable',fixed+'\n'+empty+"INSERT INTO kb_source_links(id,source_kind) VALUES('synthetic-link','task');"+invoke,'knowledge_requires_server_restore','23514');
 probe('clear genuine release batch guard remains executable',fixed+'\n'+empty+"INSERT INTO release_batches(id) VALUES('synthetic-release');"+invoke,'release_history_requires_restore','40001');
 probe('clear genuine QA task link guard remains executable',fixed+'\n'+empty+`INSERT INTO qa_issues(id,data) VALUES('synthetic-qa','{"taskIds":["synthetic-task"]}');`+invoke,'qa_task_links_require_restore','23514');
 probe('clear genuine TaskWork history guard remains executable',fixed+'\n'+empty+"INSERT INTO tasks(id,task_key,project_id,title,status_id,creator_id) VALUES('clear-work-test','CLR-1','p','Synthetic retained work','todo','member'); INSERT INTO task_work_events(command_id,actor_id,task_id,operation) VALUES('clear-work-test','member','clear-work-test','set_priority');"+invoke,'work_history_requires_restore','23514');
 probe('clear sprint snapshot alone blocks genuine wrapper chain',fixed+'\nDELETE FROM task_work_events; DELETE FROM task_work_receipts; DELETE FROM sprint_command_receipts;\n'+assert('EXISTS(SELECT 1 FROM sprint_task_history)','missing sprint snapshot test prerequisite')+'\n'+invoke,'work_history_requires_restore','23514');
 probe('clear empty sprint receipt alone blocks genuine wrapper chain',fixed+'\n'+empty+`INSERT INTO sprint_command_receipts(command_id,actor_id,command,result) VALUES('30000000-0000-0000-0000-000000000001','member','{}','{}');`+invoke,'work_history_requires_restore','23514');
 probe('clear no-history genuine chain still clears successfully',fixed+'\n'+empty+invoke);
 // Leave the recognized full chain installed for real two-session races.
 raw(fixed);raw(empty);
 const auth=["SET ROLE authenticated;","SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';","SET request.jwt.claim.role='authenticated';"];
 const command=(suffix,name)=>`SELECT public.livo_sprint_command('{"commandId":"30000000-0000-0000-0000-${suffix}1","operation":"start","sprintId":"30000000-0000-0000-0000-${suffix}0","name":"${name}","taskIds":[],"includeBacklog":false}'::jsonb)`;
 const pair=(name,left,right)=>{
  races++;
  for(const [suffix,body]of[['a',left],['b',right]])raw("\\! printf '%s' '"+Buffer.from(body.join('\n')).toString('base64')+"' | base64 -d > /tmp/work-"+name+'-'+suffix+'.sql');
  raw("\\! psql -X -q -v ON_ERROR_STOP=1 -U postgres -d livo_task_work_test -f /tmp/work-"+name+"-a.sql > /tmp/work-"+name+"-a.out 2>&1 & a=$!; for i in $(seq 1 100); do test -f /tmp/work-"+name+"-ready && break; sleep 0.01; done; psql -X -q -v ON_ERROR_STOP=1 -U postgres -d livo_task_work_test -f /tmp/work-"+name+"-b.sql > /tmp/work-"+name+"-b.out 2>&1 & b=$!; wait $a; wait $b");
  check(name+' independent native sessions',"(SELECT count(*)=2 AND count(DISTINCT result->>'pid')=2 FROM work_test.races WHERE label IN("+q(name+'-a')+','+q(name+'-b')+"))");
 };
 const record=(label,statement)=>'INSERT INTO work_test.races VALUES('+q(label)+',work_test.race('+q(statement)+'));';
 pair('clear-empty-start-first',['BEGIN;',...auth,record('clear-empty-start-first-a',command('00000000001','Empty start first')),'RESET ROLE;',"COPY(SELECT 'ready') TO '/tmp/work-clear-empty-start-first-ready';",'SELECT pg_sleep(0.4);','COMMIT;'],['SET ROLE service_role;',record('clear-empty-start-first-b','SELECT public.livo_jira_clear_tasks()')]);
 check('clear waits for empty sprint committed receipt and refuses reset',"(SELECT result->>'status'='ok' FROM work_test.races WHERE label='clear-empty-start-first-a') AND (SELECT result->>'code'='23514' AND result->>'message'='work_history_requires_restore' FROM work_test.races WHERE label='clear-empty-start-first-b') AND (SELECT count(*)=1 FROM sprint_command_receipts) AND (SELECT count(*)=1 FROM sprints) AND NOT EXISTS(SELECT 1 FROM sprint_task_history)");
 raw(empty);
 pair('clear-empty-clear-first',['BEGIN;','SET ROLE service_role;',record('clear-empty-clear-first-a','SELECT public.livo_jira_clear_tasks()'),'RESET ROLE;',"COPY(SELECT 'ready') TO '/tmp/work-clear-empty-clear-first-ready';",'SELECT pg_sleep(0.4);','COMMIT;'],[...auth,record('clear-empty-clear-first-b',command('00000000002','Empty clear first'))]);
 check('clear owning planning lock rejects concurrent empty start atomically',"(SELECT result->>'status'='ok' FROM work_test.races WHERE label='clear-empty-clear-first-a') AND (SELECT result->>'code'='PT409' FROM work_test.races WHERE label='clear-empty-clear-first-b') AND NOT EXISTS(SELECT 1 FROM sprint_command_receipts) AND NOT EXISTS(SELECT 1 FROM sprints)");
 raw("SELECT jsonb_build_object('status',CASE WHEN bool_and(ok) THEN 'passed' ELSE 'failed' END,'assertions',count(*),'failures',COALESCE(jsonb_agg(jsonb_build_object('label',label,'detail',detail)) FILTER(WHERE NOT ok),'[]'::jsonb)) FROM work_test.results;");
 return {sql:sql.join('\n'),labels,races,files:Object.values(files),extraction:'actual released QA direct + release rename/wrapper + complete KB clear migration; minimal typed prerequisites, not full schema bootstrap'};
}
