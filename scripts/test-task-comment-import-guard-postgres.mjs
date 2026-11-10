import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildTaskWorkPlan } from './test-task-work-postgres.mjs';
import { runPostgres } from './task-work-postgres-runtime.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=name=>fs.readFileSync(path.join(root,'supabase/migrations',name),'utf8');
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
export function plan(){
 const base=buildTaskWorkPlan(),cases=[];let assertions=base.summary.assertions;
 const check=(label,sql)=>{assertions++;cases.push('SELECT work_test.check(('+sql+'),'+quote(label)+');');};
 const media='20261119_task_comment_attachments.sql',name='20261120_task_comment_import_guard.sql',migration=read(name),summaryMigration='20261121_task_comment_attachment_summary.sql';
 cases.push(`RESET ROLE;
 CREATE SCHEMA IF NOT EXISTS storage;
 CREATE TABLE IF NOT EXISTS storage.buckets(id text PRIMARY KEY,name text,public boolean NOT NULL DEFAULT false,file_size_limit bigint,allowed_mime_types text[]);
 CREATE TABLE IF NOT EXISTS storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text NOT NULL REFERENCES storage.buckets(id),name text NOT NULL,metadata jsonb,UNIQUE(bucket_id,name));
 ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
 GRANT USAGE ON SCHEMA storage TO service_role,authenticated,anon;
 GRANT ALL ON storage.buckets,storage.objects TO service_role;
 ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS created_at text NOT NULL DEFAULT to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS"Z"');
 ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS attachment_url text;
 ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS attachment_size bigint DEFAULT 0;
 ALTER TABLE public.task_attachments ADD COLUMN IF NOT EXISTS file_size bigint NOT NULL DEFAULT 0;
 CREATE TABLE work_test.comment_clear_identity AS SELECT oid,proowner,proacl FROM pg_proc WHERE oid='public.livo_jira_clear_tasks()'::regprocedure;
 CREATE TABLE work_test.comment_clear_delegates AS SELECT oid,md5(prosrc) AS body FROM pg_proc WHERE oid IN ('public.livo_jira_clear_tasks_pre_knowledge_guard()'::regprocedure,'public.livo_jira_clear_tasks_pre_release()'::regprocedure);`,read(media),migration,migration,read(summaryMigration),read(summaryMigration),
 `CREATE FUNCTION work_test.private_comment_clear_result() RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
 BEGIN PERFORM public.livo_jira_clear_tasks(); RETURN '{"code":"ok"}'::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('code',SQLSTATE,'message',SQLERRM); END; $$;
 GRANT EXECUTE ON FUNCTION work_test.private_comment_clear_result() TO service_role;`);
 check('new guard keeps published clear OID owner and ACL',"EXISTS(SELECT 1 FROM pg_proc p JOIN work_test.comment_clear_identity b ON p.oid=b.oid WHERE p.proowner=b.proowner AND p.proacl IS NOT DISTINCT FROM b.proacl)");
 check('all inherited delegates keep their real released bodies',"NOT EXISTS(SELECT 1 FROM work_test.comment_clear_delegates b JOIN pg_proc p ON p.oid=b.oid WHERE md5(p.prosrc)<>b.body)");
 const retained=id=>`INSERT INTO public.task_comment_uploads(id,task_id,actor_id,file_name,mime_type,expected_size,storage_key,state) VALUES(${quote('clear-'+id)},'synthetic-retained-task','member','example.png','image/png',7,${quote('default/synthetic-retained-task/clear-'+id)},${quote(id)});`;
 for(const state of['uploading','complete','bound','cleaning']){
  cases.push(retained(state),'SET ROLE service_role;');
  check('real published chain refuses private '+state+' reservations',"work_test.private_comment_clear_result()->>'message'='task_comment_requires_server_restore'");
  cases.push('RESET ROLE;',`DELETE FROM public.task_comment_uploads WHERE id=${quote('clear-'+state)};`);
 }
 cases.push(retained('aborted'),'SET ROLE service_role;');
 check('aborted tracked tombstones do not block the existing zero-media clear',"work_test.private_comment_clear_result()->>'code'='ok'");
 cases.push('RESET ROLE;');
 check('clear does not silently delete the tracked private tombstone',"EXISTS(SELECT 1 FROM public.task_comment_uploads WHERE id='clear-aborted' AND state='aborted')");
 cases.push("INSERT INTO public.kb_source_links(id,source_kind) VALUES('clear-private-knowledge','task'); SET ROLE service_role;");
 check('knowledge protection remains executable after the new guard',"work_test.private_comment_clear_result()->>'message'='knowledge_requires_server_restore'");
 cases.push("RESET ROLE; DELETE FROM public.kb_source_links WHERE id='clear-private-knowledge'; INSERT INTO public.release_batches(id) VALUES('clear-private-release'); SET ROLE service_role;");
 check('the real release delegate still refuses retained publications',"work_test.private_comment_clear_result()->>'message'='release_history_requires_restore'");
 cases.push("RESET ROLE; DELETE FROM public.release_batches WHERE id='clear-private-release'; INSERT INTO public.sprint_command_receipts(command_id,actor_id,command,result) VALUES('40000000-0000-4000-8000-000000000001','member','{}','{}'); SET ROLE service_role;");
 check('existing sprint and TaskWork history guard remains before delegation',"work_test.private_comment_clear_result()->>'message'='work_history_requires_restore'");
 cases.push("RESET ROLE; DELETE FROM public.sprint_command_receipts WHERE command_id='40000000-0000-4000-8000-000000000001'; BEGIN; SET ROLE service_role; SELECT public.livo_jira_clear_tasks(); RESET ROLE;");
 check('zero-media clear holds its upload-table fence until the transaction ends',"EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='public.task_comment_uploads'::regclass AND mode='ShareRowExclusiveLock' AND granted)");
 cases.push('COMMIT;');
 assertions++;
 cases.push(`DO $test$ DECLARE definition text; refused boolean:=false; BEGIN
 SELECT pg_get_functiondef('public.livo_jira_clear_tasks()'::regprocedure) INTO definition;
 BEGIN
  EXECUTE replace(definition,E'BEGIN\n',E'BEGIN\n PERFORM 1;\n');
  EXECUTE ${quote(migration)};
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM<>'task_comment_clear_guard_unknown_wrapper' THEN RAISE; END IF;
  refused:=true;
 END;
 PERFORM work_test.check(refused,'unknown customized clear body is rejected without replacing it');
 END; $test$;`);
 check('ordinary authenticated callers still cannot invoke destructive clear',"NOT has_function_privilege('authenticated','public.livo_jira_clear_tasks()','EXECUTE') AND NOT has_function_privilege('anon','public.livo_jira_clear_tasks()','EXECUTE')");
 cases.push("SELECT json_build_object('status','passed','assertions',(SELECT count(*) FROM work_test.results));");
 return{sql:[base.sql,...cases].join('\n'),summary:{...base.summary,assertions,privateMediaClearAssertions:assertions-base.summary.assertions,privateMediaGuardMigrationApplications:2,privateMediaSummaryMigrationApplications:2,migrations:[...base.summary.migrations,...[media,name,summaryMigration].map(n=>({name:n,sha256:createHash('sha256').update(read(n)).digest('hex')}))],fixture:base.summary.fixture+'; actual private-comment migrations including summary plus minimal typed storage dependencies; complete production HTTP installation not claimed'}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),current=plan();
 const pending=args.includes('--run')?runPostgres(current,args.includes('--report')?args[args.indexOf('--report')+1]:undefined):Promise.resolve(current.summary);
 pending.then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(JSON.stringify(error.report??{error:error.message}));process.exitCode=1;});
}
