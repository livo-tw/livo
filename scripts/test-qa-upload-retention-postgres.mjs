import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan as externalQaPlan } from './test-external-qa-postgres.mjs';
import { runPostgres } from './task-work-postgres-runtime.mjs';
import { runNativePostgres } from './native-postgres-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = '20261115_qa_upload_retention.sql';
const migration = fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";

export function plan() {
  const base = externalQaPlan(), cases = [];
  let assertions = base.summary.assertions;
  const check = (label, sql) => { assertions++; cases.push('SELECT qa_test.check((' + sql + '),' + quote(label) + ');'); };
  const error = (label, sql, code, message) => {
    assertions++; cases.push('SELECT qa_test.expect_error(' + [label, sql, code, message].map(quote).join(',') + ');');
  };
  const claim = "public.livo_qa_upload_cleanup('claim','{\"limit\":25}')";
  const identity = "(SELECT jsonb_build_object('id',data->>'id','token',data->>'token') FROM qa_test.retention_claims WHERE data->>'id'='retention-expired')";
  cases.push('RESET ROLE;', migration, migration,
    'CREATE TABLE qa_test.retention_claims(data jsonb); GRANT SELECT,INSERT,TRUNCATE ON qa_test.retention_claims TO service_role;', 'SET ROLE service_role;',
    `INSERT INTO qa_issues(id,project_id,state,reporter_id,title,version,updated_at,data)
      VALUES('retention-issue','p-test','new','m-member','Synthetic retention',1,now(),'{"id":"retention-issue"}');`,
    `INSERT INTO qa_uploads(id,issue_id,actor_id,file_name,mime_type,size,storage_path,created_at,expires_at)
      SELECT id,'retention-issue','m-member','example.txt','text/plain',7,'default/retention-issue/'||id,now(),now()+interval '2 hours'
      FROM unnest(ARRAY['retention-active','retention-expired','retention-committed','retention-settling']) id;`,
    `INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('qa-evidence','default/retention-issue/retention-expired','{"size":7,"mimetype":"text/plain"}');`,
    `INSERT INTO qa_attachments(id,issue_id,uploaded_by,file_name,mime_type,size,storage_path,created_at)
      VALUES('retention-committed','retention-issue','m-member','example.txt','text/plain',7,'default/retention-issue/retention-committed',now());`,
    `UPDATE qa_uploads SET expires_at=now()-interval '1 day' WHERE id IN ('retention-expired','retention-committed');`,
    `UPDATE qa_uploads SET expires_at=now()-interval '2 minutes' WHERE id='retention-settling';`,
    `UPDATE system_settings SET value='{}' WHERE key='feature_toggles';`,
    `INSERT INTO qa_test.retention_claims SELECT value FROM jsonb_array_elements(${claim});`);
  check('expired unreferenced upload is claimed even while QA is disabled', "EXISTS(SELECT 1 FROM qa_test.retention_claims WHERE data->>'id'='retention-expired')");
  check('active, settling and referenced uploads are retained', "NOT EXISTS(SELECT 1 FROM qa_test.retention_claims WHERE data->>'id' IN ('retention-active','retention-settling','retention-committed'))");
  check('active cleanup lease cannot be stolen', "NOT EXISTS(SELECT 1 FROM jsonb_array_elements(" + claim + ") item WHERE item->>'id'='retention-expired')");
  check('object reference is rechecked after claim', "public.livo_qa_upload_cleanup('referenced'," + identity + ")='false'::jsonb");
  check('storage bytes must be deleted before marking cleanup complete', "public.livo_qa_upload_cleanup('finish'," + identity + ")='false'::jsonb");
  error('restore cannot attach a cleanup-owned object', `INSERT INTO qa_attachments(id,issue_id,uploaded_by,file_name,mime_type,size,storage_path,created_at)
    VALUES('retention-expired','retention-issue','m-member','example.txt','text/plain',7,'default/retention-issue/retention-expired',now())`, 'PT409', 'qa_upload_cleanup_in_progress');
  cases.push("UPDATE system_settings SET value='{\"qa\":true}' WHERE key='feature_toggles';");
  error('late signed upload cannot replace a cleanup-owned object', "INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('qa-evidence','default/retention-issue/retention-expired','{\"size\":7,\"mimetype\":\"text/plain\"}')", '42501', 'qa_upload_unavailable');
  check('cleanup owns only its exact unexpired token', "public.livo_qa_upload_cleanup('owns'," + identity + ")='true'::jsonb AND public.livo_qa_upload_cleanup('owns',jsonb_build_object('id','retention-expired','token','stale'))='false'::jsonb");
  cases.push("DELETE FROM storage.objects WHERE bucket_id='qa-evidence' AND name='default/retention-issue/retention-expired';");
  check('successful object delete can finish cleanup', "public.livo_qa_upload_cleanup('finish'," + identity + ")='true'::jsonb");
  check('successful delete preserves an idempotent tombstone', "EXISTS(SELECT 1 FROM qa_uploads WHERE id='retention-expired' AND cleanup_completed_at IS NOT NULL)");
  cases.push("UPDATE qa_uploads SET cleanup_completed_at=now()-interval '25 hours',cleanup_last_attempt_at=now()-interval '2 hours' WHERE id='retention-expired';",
    "TRUNCATE qa_test.retention_claims; INSERT INTO qa_test.retention_claims SELECT value FROM jsonb_array_elements(" + claim + ');');
  check('settled tombstone can finish its second sweep', "public.livo_qa_upload_cleanup('finish'," + identity + ")='true'::jsonb");
  check('second sweep retires only the settled unreferenced reservation', "NOT EXISTS(SELECT 1 FROM qa_uploads WHERE id='retention-expired') AND EXISTS(SELECT 1 FROM qa_attachments WHERE id='retention-committed')");
  cases.push('RESET ROLE; SET ROLE authenticated;');
  error('member JWT cannot invoke retention', "SELECT public.livo_qa_upload_cleanup('claim')", '42501', 'permission denied');
  cases.push('RESET ROLE; SET ROLE anon;');
  error('anonymous JWT cannot invoke retention', "SELECT public.livo_qa_upload_cleanup('claim')", '42501', 'permission denied');
  cases.push("RESET ROLE; SELECT json_build_object('status','passed','assertions',(SELECT count(*) FROM qa_test.results));");
  return { sql: [base.sql, ...cases].join('\n'), summary: { assertions, migrationApplications: 2, migrations: [...base.summary.migrations, name] } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
  const current = plan();
  const pending = args.includes('--native') ? runNativePostgres(current, {
    binaryDir: option('--pg-bin'), clientPackage: option('--pg-client-package'), reportPath: option('--report'),
  }) : args.includes('--run') ? runPostgres(current, option('--report')) : Promise.resolve(current.summary);
  pending.then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify(error.report ?? { error: error.message })); process.exitCode = 1;
  });
}
