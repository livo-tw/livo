import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan as retentionPlan } from './test-qa-upload-retention-postgres.mjs';
import { runPostgres } from './task-work-postgres-runtime.mjs';
import { runNativePostgres } from './native-postgres-runtime.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const name='20261118_qa_comment_attachments.sql',migration=fs.readFileSync(path.join(root,'supabase/migrations',name),'utf8');
const quote=v=>"'"+String(v).replaceAll("'","''")+"'",json=v=>quote(JSON.stringify(v))+'::jsonb';
export function plan(){
 const base=retentionPlan(),cases=[];let assertions=base.summary.assertions;
 const check=(label,sql)=>{assertions++;cases.push('SELECT qa_test.check(('+sql+'),'+quote(label)+');');};
 // Execute a mutating RPC before a separate SQL assertion. An uncorrelated
 // count subquery in the same SELECT can be an InitPlan evaluated before the RPC.
 const rpcThenCheck=(label,rpc,sql)=>{assertions++;cases.push(`DO $test$ DECLARE result jsonb; BEGIN
  result:=${rpc};
  PERFORM qa_test.check((${sql}),${quote(label)});
 END; $test$;`);};
 const error=(label,sql,code,message)=>{assertions++;cases.push('SELECT qa_test.expect_error('+[label,sql,code,message].map(quote).join(',')+');');};
 const member="(SELECT auth_id FROM public.members WHERE id='m-member')",external="'00000000-0000-0000-0000-000000000011'::uuid";
 const issue='comment-attachment-issue',other='comment-attachment-other';
 const data=id=>({id,workspaceId:'default',projectId:'p-test',state:'new',reporterId:'m-member',assigneeId:null,qaOwnerId:null,title:'Synthetic comment attachments',actual:'Synthetic only',observedEnvironment:'Stage',observedVersion:'',steps:'',expected:'',component:'',severity:'untriaged',priority:3,dueDate:null,fixCycle:0,fixSummary:'',targets:[],runs:[],taskIds:[],resolution:null,resolutionReason:'',duplicateOfId:null,closedAt:null,closedBy:null,reopenedAt:null,holdReason:'',reopenReason:'',version:1,createdAt:'2026-11-10T00:00:00Z',updatedAt:'2026-11-10T00:00:00Z',handoff:null,customFields:{}});
 const comment=(id,ids,body='')=>({id,issueId:issue,actorId:'m-member',body,attachmentIds:ids,createdAt:'2026-11-10T00:00:00Z'});
 const commit=(id,ids,body='',auth=member,command=id+'-command')=>`public.livo_qa_commit(${auth},${quote(issue)},${quote(command)},${quote('a'.repeat(64))},NULL,'comment',${json(comment(id,ids,body))},${json({id:id+'-event',type:'comment',recipients:[]})})`;
 cases.push('RESET ROLE;',migration,migration,'SET ROLE service_role;',"UPDATE public.system_settings SET value='{\"qa\":true}' WHERE key='feature_toggles';",
  "UPDATE public.external_qa_accounts SET is_active=true WHERE id='eqa-example'; INSERT INTO public.external_qa_project_grants(account_id,project_id) VALUES('eqa-example','p-test') ON CONFLICT DO NOTHING;");
 for(const id of[issue,other])cases.push(`INSERT INTO qa_issues(id,project_id,state,reporter_id,title,version,updated_at,data) VALUES(${quote(id)},'p-test','new','m-member','Synthetic comment attachments',1,now(),${json(data(id))});`);
 const reserve=(id,actor='m-member',issueId=issue,purpose='comment',object=true)=>{
  cases.push(`INSERT INTO qa_uploads(id,issue_id,actor_id,file_name,mime_type,size,storage_path,created_at,expires_at,purpose) VALUES(${quote(id)},${quote(issueId)},${quote(actor)},'example.png','image/png',7,${quote('default/'+issueId+'/'+id)},now(),now()+interval '2 hours',${quote(purpose)});`);
  if(object)cases.push(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('qa-evidence',${quote('default/'+issueId+'/'+id)},'{"size":7,"mimetype":"image/png"}');`);
 };
 reserve('comment-png');reserve('comment-video');
 check('finalize verifies a comment object without publishing an attachment',`public.livo_qa_finalize_upload(${member},'comment-png')->>'id'='comment-png' AND NOT EXISTS(SELECT 1 FROM qa_attachments WHERE id='comment-png')`);
 check('pending bytes are downloadable by their uploader',`public.livo_qa_attachment_for_download(${member},'comment-png')->>'id'='comment-png'`);
 error('another project-authorized actor cannot download private pending bytes',`SELECT public.livo_qa_attachment_for_download(${external},'comment-png')`,'P0002','qa_attachment_not_found');
 rpcThenCheck('attachment-only comment atomically publishes every reserved file',commit('attachment-only',['comment-png','comment-video']),"result->>'id'='attachment-only' AND (SELECT count(*) FROM qa_attachments WHERE comment_id='attachment-only')=2");
 check('published reservations are marked complete',"(SELECT count(*) FROM qa_uploads WHERE id IN ('comment-png','comment-video') AND completed_at IS NOT NULL)=2");
 rpcThenCheck('lost response replay returns the original comment and never inserts another',commit('fresh-server-generated-id',['comment-png','comment-video'],'',member,'attachment-only-command'),`result->>'id'='attachment-only' AND (SELECT count(*) FROM qa_comments WHERE issue_id=${quote(issue)})=1`);
 check('all authorized bug readers can download the now-published file',`public.livo_qa_attachment_for_download(${external},'comment-png')->>'comment_id'='attachment-only'`);
 check('external detail returns the association without pending uploads',`public.livo_qa_external_read(${external},'get',${json({id:issue})})->'attachments' @> '[{"id":"comment-png","commentId":"attachment-only"}]'::jsonb`);
 reserve('wrong-owner','m-admin');reserve('wrong-issue','m-member',other);reserve('wrong-purpose','m-member',issue,'issue');reserve('missing-bytes','m-member',issue,'comment',false);reserve('expired-comment');reserve('cleaning-comment');
 cases.push("UPDATE qa_uploads SET expires_at=now()-interval '1 day' WHERE id='expired-comment'; UPDATE qa_uploads SET cleanup_token='owned-cleanup' WHERE id='cleaning-comment';");
 for(const id of['wrong-owner','wrong-issue','wrong-purpose','expired-comment','cleaning-comment'])error('reject '+id,`SELECT ${commit('reject-'+id,[id])}`,'22023','qa_invalid_comment_attachments');
 error('missing object aborts the original comment transaction',`SELECT ${commit('reject-missing-bytes',['missing-bytes'])}`,'22023','qa_upload_incomplete');
 error('empty comment without attachments is rejected',`SELECT ${commit('reject-empty',[])}`,'22023','qa_invalid_comment_attachments');
 error('duplicate attachments are rejected',`SELECT ${commit('reject-duplicate',['comment-png','comment-png'])}`,'22023','qa_invalid_comment_attachments');
 error('more than ten attachments are rejected',`SELECT ${commit('reject-eleven',Array.from({length:11},(_,i)=>'file-'+i))}`,'22023','qa_invalid_comment_attachments');
 check('all rejected transactions roll back comments and command receipts',"NOT EXISTS(SELECT 1 FROM qa_comments WHERE id LIKE 'reject-%') AND NOT EXISTS(SELECT 1 FROM qa_commands WHERE id LIKE 'reject-%')");
 error('a published file cannot move to another comment',`SELECT ${commit('reject-rebind',['comment-png'])}`,'22023','qa_invalid_comment_attachments');
 cases.push(`SELECT public.livo_qa_external_reserve_upload(${external},${quote(issue)},'comment-external-pending','example.png','image/png',7,'comment'); INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('qa-evidence',${quote('default/'+issue+'/comment-external-pending')},'{"size":7,"mimetype":"image/png"}');`);
 check('external pending files stay out of authorized detail',`NOT (public.livo_qa_external_read(${external},'get',${json({id:issue})})->'attachments' @> '[{"id":"comment-external-pending"}]'::jsonb)`);
 cases.push("DELETE FROM external_qa_project_grants WHERE account_id='eqa-example' AND project_id='p-test';");
 error('revocation between upload and publish rejects the current transaction',`SELECT ${commit('reject-revoked',['comment-external-pending'],'',external)}`,'42501','qa_forbidden');
 error('revocation also rejects pending download',`SELECT public.livo_qa_attachment_for_download(${external},'comment-external-pending')`,'42501','qa_forbidden');
 check('unpublished expired comment objects remain eligible for the existing cleanup',"public.livo_qa_upload_cleanup('claim','{\"limit\":25}') @> '[{\"id\":\"expired-comment\"}]'::jsonb");
 cases.push('RESET ROLE; SET ROLE authenticated;');
 error('member SQL cannot invoke the service publication helper',`SELECT public.livo_qa_publish_comment_attachments(${member},${quote(issue)},'{}')`,'42501','permission denied');
 cases.push("RESET ROLE; SELECT json_build_object('status','passed','assertions',(SELECT count(*) FROM qa_test.results));");
 return{sql:[base.sql,...cases].join('\n'),summary:{assertions,migrationApplications:2,migrations:[...base.summary.migrations,name]}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),option=k=>args.includes(k)?args[args.indexOf(k)+1]:undefined,current=plan();
 const pending=args.includes('--native')?runNativePostgres(current,{binaryDir:option('--pg-bin'),clientPackage:option('--pg-client-package'),reportPath:option('--report')}):args.includes('--run')?runPostgres(current,option('--report')):Promise.resolve(current.summary);
 pending.then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(JSON.stringify(e.report??{error:e.message}));process.exitCode=1;});
}
