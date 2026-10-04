// Generates SQL assertions against the real QA RPCs, without a client/HTTP mock.
import { appendQaFieldCases } from './qa-fields-postgres-cases.mjs';
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const auth = { member: '00000000-0000-0000-0000-000000000001', admin: '00000000-0000-0000-0000-000000000002', super: '00000000-0000-0000-0000-000000000003', assignee: '00000000-0000-0000-0000-000000000004', qa: '00000000-0000-0000-0000-000000000005' };
const tables = ['qa_issues','qa_commands','qa_events','qa_comments','qa_uploads','qa_attachments','qa_slack_links','qa_slack_receipts','qa_slack_inbox'];
const backup = Object.fromEntries(tables.slice(0,7).map(t => [t, []]));
const workflow = { version: 2, order: ['new','triaged','in_progress','verification','verified','failed','closed','dismissed'], labels: { new: '待判斷', triaged: '', in_progress: '', verification: '', verified:'', failed:'', closed: '', dismissed:'' }, groups:[] };
const base = { id:'issue-main',workspaceId:'default',projectId:'p-test',state:'new',reporterId:'m-member',assigneeId:null,qaOwnerId:null,title:'PostgreSQL QA fixture',version:1,createdAt:'2026-10-02T00:00:00.000Z',updatedAt:'2026-10-02T00:00:00.000Z',actual:'Actual result',observedEnvironment:'test',severity:'untriaged',priority:3,fixCycle:0,targets:[],runs:[],taskIds:[] };

export function buildQaPostgresCases({ migrationCount = 7, permissionFloorSql = '' } = {}) {
  if (!Number.isInteger(migrationCount) || migrationCount < 1) throw new Error('Invalid migration count');
  const sql = []; const labels = [];
  const check = (name, expression) => { labels.push(name); sql.push(`SELECT qa_test.check((${expression}),${literal(name)});`); };
  const error = (name, statement, code, message='') => { labels.push(name); sql.push(`SELECT qa_test.expect_error(${literal(name)},${literal(statement)},${literal(code)},${literal(message)});`); };
  const role = name => sql.push(`RESET ROLE; SET ROLE ${name};`);
  let n = 0;
  const commit = (actor, data, type='created', kind='create', expected=null, command=`command-${++n}`, hash='a'.repeat(64)) =>
    `public.livo_qa_commit(${literal(auth[actor])}::uuid,${literal(kind==='comment'?'issue-main':data.id)},${literal(command)},${literal(hash)},${expected??'NULL'},${literal(kind)},${json(data)},${json({id:`event-${command}`,type,detail:'Immutable test evidence',recipients:['m-qa']})})`;
  const save = (actor, value=workflow) => `public.livo_qa_save_workflow(${literal(auth[actor])}::uuid,${json(value)})`;
  const restore = (actor, value=backup, validate=true) => `public.livo_qa_restore(${literal(auth[actor])}::uuid,${json(value)},${validate})`;
  const finalize = actor => `public.livo_qa_finalize_upload(${literal(auth[actor])}::uuid,'upload-main')`;
  const rpcSignatures = [
    'livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb)', 'livo_qa_finalize_upload(uuid,text)',
    'livo_qa_restore(uuid,jsonb,boolean)', 'livo_qa_save_workflow(uuid,jsonb)',
    'livo_qa_save_field_configuration(uuid,jsonb)',
    'livo_qa_slack_enqueue(text,jsonb)', 'livo_qa_slack_pending()', 'livo_qa_slack_complete(text)',
  ];
  for (const signature of rpcSignatures) {
    for (const dbRole of ['anon','authenticated','service_role']) {
      check(`execute grant ${dbRole}: ${signature}`, `has_function_privilege(${literal(dbRole)},${literal(`public.${signature}`)},'EXECUTE')=${dbRole==='service_role'}`);
    }
  }
  for (const table of tables) {
    check(`RLS enabled ${table}`, `(SELECT relrowsecurity FROM pg_class WHERE oid='public.${table}'::regclass)`);
    for (const dbRole of ['anon','authenticated']) check(`table inaccessible ${dbRole}: ${table}`, `NOT has_table_privilege(${literal(dbRole)},'public.${table}','SELECT,INSERT,UPDATE,DELETE')`);
  }
  role('service_role');
  const initial = commit('member',base,'created','create',null,'command-create');
  check('active member can report through trusted service', `${initial}->>'id'='issue-main'`);
  check('create replay returns receipt', `${initial}=${json(base)}`);
  check('replay has one issue/event/receipt', `(SELECT count(*) FROM qa_issues)=1 AND (SELECT count(*) FROM qa_events)=1 AND (SELECT count(*) FROM qa_commands)=1`);
  error('receipt rejects another actor', `SELECT ${commit('admin',base,'created','create',null,'command-create')}`, '23505','command_id_reused');
  error('receipt rejects changed payload hash', `SELECT ${commit('member',base,'created','create',null,'command-create','b'.repeat(64))}`, '23505','command_id_reused');
  check('notification is QA content without task', `(SELECT count(*) FROM notifications WHERE type='qa_update' AND task_id IS NULL AND content::jsonb->>'kind'='qa' AND content::jsonb->>'issueId'='issue-main')=1`);
  check('notification task link is optional while recipient sender and type stay required', `(SELECT count(*)=4 AND bool_and(CASE column_name WHEN 'task_id' THEN is_nullable='YES' ELSE is_nullable='NO' END) FROM information_schema.columns WHERE table_schema='public' AND table_name='notifications' AND column_name IN ('task_id','recipient_id','sender_id','type'))`);
  for (const actor of ['admin','super']) {
    const issue = {...base,id:`issue-${actor}`,reporterId:`m-${actor}`};
    check(`${actor} can report`, `${commit(actor,issue)}->>'id'=${literal(issue.id)}`);
    check(`${actor} can save workflow`, `${save(actor)}=${json(workflow)}`);
  }
  error('member cannot save workflow',`SELECT ${save('member')}`,'42501','member_inactive');
  check('settings persisted in company setting', `(SELECT value FROM system_settings WHERE key='qa_workflow')=${json(workflow)}`);
  for (const [name,value] of [
    ['unknown state',{...workflow,order:['new','triaged','in_progress','verification','unknown']}],
    ['duplicate order',{...workflow,order:['new','new','in_progress','verification','closed']}],
    ['duplicate labels',{...workflow,labels:{...workflow.labels,new:'Same',triaged:'same'}}],
    ['overlong label',{...workflow,labels:{...workflow.labels,new:'x'.repeat(41)}}],
    ['unknown property',{...workflow,workspaceId:'other'}],
  ]) error(`workflow rejects ${name}`,`SELECT ${save('admin',value)}`,'22023','qa_invalid_workflow');

  // The same PostgreSQL role is used for all browser members; JWT subject does
  // not turn authenticated into service_role, even for a company super admin.
  for (const actor of ['member','admin','super']) {
    role('authenticated');
    sql.push(`SET "request.jwt.claim.sub"=${literal(auth[actor])};`);
    error(`${actor} cannot directly read QA`, 'SELECT * FROM public.qa_issues', '42501');
    error(`${actor} cannot directly update QA`, "UPDATE public.qa_issues SET title='bypass' WHERE id='issue-main'", '42501');
    error(`${actor} cannot directly call commit`,`SELECT ${initial}`,'42501');
    error(`${actor} cannot directly call workflow RPC`, `SELECT ${save(actor)}`,'42501');
    error(`${actor} cannot overwrite setting directly`, "UPDATE public.system_settings SET value='{}' WHERE key='qa_workflow'",'42501','qa_workflow_server_only');
    error(`${actor} cannot delete setting directly`, "DELETE FROM public.system_settings WHERE key='qa_workflow'",'42501','qa_workflow_server_only');
    error(`${actor} cannot upsert setting directly`, `INSERT INTO public.system_settings(key,value) VALUES('qa_workflow',${json(workflow)}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,'42501','qa_workflow_server_only');
  }
  role('anon');
  error('anon cannot read QA','SELECT * FROM public.qa_issues','42501');
  error('anon cannot call restore',`SELECT ${restore('super')}`,'42501');
  role('service_role');
  const triaged = {...base,state:'triaged',assigneeId:'m-assignee',qaOwnerId:'m-qa',version:2};
  error('reporter cannot first triage',`SELECT ${commit('member',triaged,'triage','command',1)}`,'42501','member_inactive');
  check('admin can first triage', `${commit('admin',triaged,'triage','command',1)}->>'state'='triaged'`);
  const started = {...triaged,state:'in_progress',version:3};
  error('unassigned member cannot start fix',`SELECT ${commit('member',started,'start_fix','command',2)}`,'42501','member_inactive');
  error('CAS rejects stale version',`SELECT ${commit('assignee',started,'start_fix','command',1)}`,'40001','version_conflict');
  check('assignee can start fix',`${commit('assignee',started,'start_fix','command',2)}->>'state'='in_progress'`);
  const verified = {...started,version:4};
  error('assignee cannot record QA result',`SELECT ${commit('assignee',verified,'record_verification','command',3)}`,'42501','member_inactive');
  check('QA owner can record QA result',`${commit('qa',verified,'record_verification','command',3)}->>'version'='4'`);
  const comment={id:'comment-main',body:'Verification note',createdAt:base.createdAt};
  check('active member can comment',`${commit('member',comment,'comment','comment')}->>'id'='comment-main'`);
  error('create rejects another workspace',`SELECT ${commit('member',{...base,id:'issue-other',workspaceId:'other'})}`,'22023','invalid_issue');
  error('command rejects another workspace',`SELECT ${commit('super',{...verified,version:5,workspaceId:'other'},'edit','command',4)}`,'22023','invalid_issue');
  for (const table of tables) {
    // Existing rows in every table are seeded before the final scope sweep.
    check(`default-only CHECK ${table}`, `(SELECT count(*) FROM pg_constraint WHERE conrelid='public.${table}'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%workspace_id%default%')=1`);
  }
  for (const actor of ['member','admin']) error(`${actor} cannot restore`,`SELECT ${restore(actor)}`,'42501','member_inactive');
  check('super admin can preflight restore',`${restore('super')}->>'validateOnly'='true'`);
  const restoredIssue={...base,id:'issue-restored'};
  const restoreRows={...backup,qa_issues:[{id:restoredIssue.id,workspace_id:'default',project_id:'p-test',state:'new',assignee_id:null,qa_owner_id:null,reporter_id:'m-member',title:base.title,version:1,updated_at:base.updatedAt,data:restoredIssue}]};
  check('nonempty restore preflight reports pending',`${restore('super',restoreRows)}->>'pending'='1'`);
  check('restore preflight leaves no issue',`NOT EXISTS(SELECT 1 FROM qa_issues WHERE id='issue-restored')`);
  check('super admin can atomically restore issue',`${restore('super',restoreRows,false)}->>'inserted'='1'`);
  check('restored aggregate readback matches',`(SELECT data FROM qa_issues WHERE id='issue-restored')=${json(restoredIssue)}`);
  check('identical restore skips existing issue',`${restore('super',restoreRows,false)}->>'skipped'='1'`);
  error('restore rejects another workspace', `SELECT ${restore('super',{...backup,qa_slack_links:[{id:'other',workspace_id:'other'}]},false)}`, '22023','invalid_issue');
  sql.push("UPDATE members SET is_active=false WHERE id='m-member';");
  error('revoked member cannot replay committed report',`SELECT ${initial}`,'42501','member_inactive');
  error('revoked member cannot comment',`SELECT ${commit('member',{...comment,id:'comment-revoked'},'comment','comment')}`,'42501','member_inactive');
  error('revoked member cannot finalize',`SELECT ${finalize('member')}`,'42501','member_inactive');
  sql.push("UPDATE members SET is_active=true WHERE id='m-member'; UPDATE members SET is_active=false WHERE id IN ('m-admin','m-super');");
  for (const actor of ['admin','super']) error(`revoked ${actor} cannot save workflow`,`SELECT ${save(actor)}`,'42501','member_inactive');
  error('revoked super admin cannot restore',`SELECT ${restore('super')}`,'42501','member_inactive');
  sql.push("UPDATE members SET is_active=true WHERE id IN ('m-admin','m-super'); UPDATE members SET role='member' WHERE id='m-admin';");
  error('demoted admin cannot save workflow',`SELECT ${save('admin')}`,'42501','member_inactive');
  sql.push("UPDATE members SET role='admin' WHERE id='m-admin';");

  sql.push(`INSERT INTO qa_uploads(id,issue_id,actor_id,file_name,mime_type,size,storage_path,created_at,expires_at)
    VALUES('upload-main','issue-main','m-member','proof.txt','text/plain',4,'default/issue-main/upload-main',now(),now()+interval '1 hour');`);
  error('finalize requires actual storage metadata',`SELECT ${finalize('member')}`,'22023','upload_incomplete');
  sql.push(`INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('qa-evidence','default/issue-main/upload-main','{"size":5,"mimetype":"text/plain"}');`);
  error('finalize rejects wrong byte size',`SELECT ${finalize('member')}`,'22023','upload_metadata_mismatch');
  sql.push(`UPDATE storage.objects SET metadata='{"size":4,"mimetype":"image/png"}' WHERE name='default/issue-main/upload-main';`);
  error('finalize rejects wrong MIME type',`SELECT ${finalize('member')}`,'22023','upload_metadata_mismatch');
  sql.push(`UPDATE storage.objects SET metadata='{"size":4,"mimetype":"text/plain"}' WHERE name='default/issue-main/upload-main';`);
  error('other member cannot finalize owner upload',`SELECT ${finalize('admin')}`,'P0002','upload_not_found');
  check('owner can finalize private evidence',`${finalize('member')}->>'id'='upload-main'`);
  check('finalize receipt is idempotent',`${finalize('member')}->>'size'='4'`);
  error('completed object cannot be replaced',`UPDATE storage.objects SET metadata='{"size":8,"mimetype":"text/plain"}' WHERE name='default/issue-main/upload-main'`,'42501','qa_upload_unavailable');
  sql.push("UPDATE storage.objects SET last_accessed_at=now() WHERE name='default/issue-main/upload-main';");
  check('bucket remains private and bounded',`(SELECT NOT public AND file_size_limit=209715200 FROM storage.buckets WHERE id='qa-evidence')`);
  sql.push(`INSERT INTO qa_uploads(id,issue_id,actor_id,file_name,mime_type,size,storage_path,created_at,expires_at)
    VALUES('upload-rls','issue-main','m-member','rls.txt','text/plain',4,'default/issue-main/upload-rls',now(),now()+interval '1 hour');`);
  for (const dbRole of ['anon','authenticated']) {
    role(dbRole);
    check(`${dbRole} cannot see evidence despite legacy policy`,`(SELECT count(*) FROM storage.objects WHERE bucket_id='qa-evidence')=0`);
    error(`${dbRole} cannot bypass evidence RLS with valid reservation`, `INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('qa-evidence','default/issue-main/upload-rls','{"size":4,"mimetype":"text/plain"}')`,'42501','row-level security');
  }
  role('service_role');
  sql.push(`INSERT INTO qa_slack_links(id,issue_id,team_id,channel_id,thread_ts,card_ts) VALUES('link-main','issue-main','T-test','C-test','1.1','1.2');
    INSERT INTO qa_slack_receipts(id) VALUES('receipt-main');`);
  check('inbox enqueue service succeeds',`livo_qa_slack_enqueue('inbox-main','{"event_id":"E-test"}')='inbox-main'`);
  check('inbox enqueue duplicate succeeds',`livo_qa_slack_enqueue('inbox-main','{"event_id":"E-test"}')='inbox-main'`);
  check('inbox deduplicates',`(SELECT count(*) FROM qa_slack_inbox WHERE id='inbox-main')=1`);
  sql.push("UPDATE qa_slack_inbox SET lease_until=now()-interval '1 second',next_attempt_at=now()-interval '1 second' WHERE id='inbox-main';");
  check('inbox claims eligible event',`jsonb_array_length(livo_qa_slack_pending())=1`);
  check('inbox does not reclaim live lease',`jsonb_array_length(livo_qa_slack_pending())=0`);
  check('inbox records attempt and backoff',`(SELECT attempts=2 AND lease_until>now() AND next_attempt_at>now() FROM qa_slack_inbox WHERE id='inbox-main')`);
  sql.push("SELECT livo_qa_slack_complete('inbox-main');");
  check('completed inbox wipes payload',`(SELECT state='done' AND payload='{}'::jsonb FROM qa_slack_inbox WHERE id='inbox-main')`);
  sql.push("INSERT INTO qa_slack_inbox(id,payload,created_at) VALUES('inbox-old','{}',now()-interval '31 days'); SELECT livo_qa_slack_pending();");
  check('inbox retention bounded at 30 days',`NOT EXISTS(SELECT 1 FROM qa_slack_inbox WHERE id='inbox-old')`);
  for (const table of tables) error(`row cannot move out of default workspace: ${table}`,`UPDATE public.${table} SET workspace_id='other'`,'23514');
  sql.push("UPDATE system_settings SET value='{}' WHERE key='feature_toggles';");
  check('missing QA switch means disabled',`NOT livo_qa_enabled()`);
  for (const [name,statement] of [
    ['commit',`SELECT ${initial}`], ['workflow',`SELECT ${save('super')}`],
    ['finalize',`SELECT ${finalize('member')}`], ['restore',`SELECT ${restore('super')}`],
    ['inbox enqueue',`SELECT livo_qa_slack_enqueue('inbox-disabled','{}')`],
  ]) error(`disabled QA rejects ${name}`,statement,'42501','qa_disabled');
  check('disabled QA inbox returns empty',`livo_qa_slack_pending()='[]'::jsonb`);
  sql.push(`UPDATE system_settings SET value='{"qa":"true","slackActions":true}' WHERE key='feature_toggles';`);
  check('string true does not enable QA',`NOT livo_qa_enabled()`);
  sql.push(`UPDATE system_settings SET value='{"qa":true,"slackActions":false}' WHERE key='feature_toggles';`);
  error('disabled Slack rejects inbox',`SELECT livo_qa_slack_enqueue('inbox-disabled-slack','{}')`,'42501','qa_disabled');
  sql.push(`UPDATE system_settings SET value='{"qa":true,"slackActions":true}' WHERE key='feature_toggles'; RESET ROLE;`);
  role('service_role');
  const imported = ['verified','failed','dismissed','triaged'].map(state=>{
    const data={...base,id:`historical-${state}`,state,legacySource:{system:'slack_list',originalStatus:state==='verified'?'PASS':state,recordId:'RecTEST123',snapshotSha256:'b'.repeat(64)}};
    return {workspace_id:'default',id:data.id,project_id:data.projectId,state,assignee_id:null,qa_owner_id:null,reporter_id:data.reporterId,title:data.title,version:data.version,updated_at:data.updatedAt,data};
  });
  check('restore accepts distinct historical states with unknown roles and no fabricated runs',`(${restore('super',{...backup,qa_issues:imported},false)}->>'inserted')::integer=4`);
  check('historical PASS is nonclosed with no invented verification',`(SELECT state='verified' AND data->'runs'='[]'::jsonb AND assignee_id IS NULL AND qa_owner_id IS NULL FROM qa_issues WHERE id='historical-verified')`);
  const grouped={...workflow,groups:[{id:'triaged',label:'Assigned',states:['new','triaged']},{id:'in_progress',label:'Active',states:['in_progress','verification']}]};
  check('admin can save six display columns without collapsing canonical states',`(${save('admin',grouped)}->'groups')=${json(grouped.groups)}`);
  error('cannot merge PASS with completed in display settings',`SELECT ${save('admin',{...workflow,groups:[{id:'verified',label:'Done',states:['verified','closed']}]})}`,'22023','qa_invalid_workflow');
  error('cannot put a state in two display groups',`SELECT ${save('admin',{...workflow,groups:[{id:'new',label:'A',states:['new','triaged']},{id:'triaged',label:'B',states:['triaged','verification']}]})}`,'22023','qa_invalid_workflow');

  // set_state is an independent audit event, not a fabricated verification run.
  // All active edit participants may cross terminal states without deployments.
  const manualStates = ['failed','closed','dismissed','new','triaged','in_progress','verification','verified'];
  const manualBase = {...base,state:'verified',assigneeId:'m-assignee',qaOwnerId:'m-qa'};
  let manualReplay;
  let manualLatest;
  for (const actor of ['member','assignee','qa','admin','super']) {
    let current = {...manualBase,id:`manual-${actor}`};
    check(`${actor} manual fixture starts as PASS without evidence`,`${commit('member',current)}=${json(current)}`);
    for (const state of manualStates) {
      const next = {...current,state,version:current.version+1};
      const command = `manual-${actor}-${state}`;
      const request = commit(actor,next,'set_state','command',current.version,command);
      check(`${actor} may manually set ${state}`,`${request}=${json(next)}`);
      if (actor === 'member' && state === 'failed') manualReplay = {request,data:next,command};
      current = next;
    }
    check(`${actor} manual changes preserve empty runs targets and fix cycle`,
      `(SELECT data->'runs'='[]'::jsonb AND data->'targets'='[]'::jsonb AND data->>'fixCycle'='0' FROM qa_issues WHERE id=${literal(current.id)})`);
    check(`${actor} manual changes have eight distinct audit events`,
      `(SELECT count(*) FROM qa_events WHERE issue_id=${literal(current.id)} AND type='set_state')=8`);
    if (actor === 'member') manualLatest = current;
  }
  check('manual PASS to FAIL replay returns its original response',`${manualReplay.request}=${json(manualReplay.data)}`);
  check('manual replay leaves the latest aggregate and audit history unchanged',
    `(SELECT data FROM qa_issues WHERE id='manual-member')=${json(manualLatest)} AND (SELECT count(*) FROM qa_events WHERE issue_id='manual-member')=9`);
  error('manual receipt rejects a different actor',`SELECT ${commit('qa',manualReplay.data,'set_state','command',1,manualReplay.command)}`,'23505','command_id_reused');
  error('manual receipt rejects a different payload hash',`SELECT ${commit('member',manualReplay.data,'set_state','command',1,manualReplay.command,'b'.repeat(64))}`,'23505','command_id_reused');
  const manualNext = {...manualLatest,state:'failed',version:manualLatest.version+1};
  error('manual state update rejects stale version',`SELECT ${commit('member',manualNext,'set_state','command',1)}`,'40001','version_conflict');
  const outsiderIssue = {...base,id:'manual-outsider',reporterId:'m-assignee',state:'verified'};
  check('manual outsider fixture is owned by another member',`${commit('assignee',outsiderIssue)}=${json(outsiderIssue)}`);
  error('unrelated active member cannot manually change state',`SELECT ${commit('member',{...outsiderIssue,state:'failed',version:2},'set_state','command',1)}`,'42501','member_inactive');
  for (const actor of ['member','assignee','qa','admin','super']) {
    sql.push(`UPDATE members SET is_active=false WHERE id=${literal(`m-${actor}`)};`);
    error(`inactive ${actor} cannot manually change state`,`SELECT ${commit(actor,manualNext,'set_state','command',manualLatest.version)}`,'42501','member_inactive');
    sql.push(`UPDATE members SET is_active=true WHERE id=${literal(`m-${actor}`)};`);
  }
  sql.push("UPDATE members SET role='member' WHERE id='m-admin';");
  error('demoted unrelated admin cannot manually change state',`SELECT ${commit('admin',manualNext,'set_state','command',manualLatest.version)}`,'42501','member_inactive');
  sql.push("UPDATE members SET role='admin' WHERE id='m-admin';");
  for (const dbRole of ['anon','authenticated']) {
    role(dbRole);
    sql.push(`SET "request.jwt.claim.sub"=${literal(auth.super)};`);
    error(`${dbRole} cannot directly submit manual state`, `SELECT ${commit('super',manualNext,'set_state','command',manualLatest.version)}`,'42501');
  }
  role('service_role');
  sql.push("UPDATE system_settings SET value='{\"qa\":false,\"slackActions\":true}' WHERE key='feature_toggles';");
  error('disabled QA rejects manual state',`SELECT ${commit('member',manualNext,'set_state','command',manualLatest.version)}`,'42501','qa_disabled');
  sql.push("UPDATE system_settings SET value='{\"qa\":true,\"slackActions\":true}' WHERE key='feature_toggles';");
  error('manual state rejects another workspace',`SELECT ${commit('member',{...manualNext,workspaceId:'other'},'set_state','command',manualLatest.version)}`,'22023','invalid_issue');
  error('manual state rejects changing reporter',`SELECT ${commit('member',{...manualNext,reporterId:'m-qa'},'set_state','command',manualLatest.version)}`,'22023','invalid_issue');
  error('manual state rejects unknown canonical value',`SELECT ${commit('member',{...manualNext,state:'unknown'},'set_state','command',manualLatest.version)}`,'23514');
  sql.push("UPDATE projects SET is_archived=true WHERE id='p-test';");
  error('manual state retains archived project guard',`SELECT ${commit('member',manualNext,'set_state','command',manualLatest.version)}`,'22023','invalid_issue');
  sql.push("UPDATE projects SET is_archived=false WHERE id='p-test';");
  check('manual migration retains the atomic environment validator',
    `(SELECT pg_get_functiondef('public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb)'::regprocedure)) LIKE '%livo_deployment_environment_values%'`);
  error('manual migration retains create environment guard',`SELECT ${commit('member',{...base,id:'manual-invalid-env',observedEnvironment:'not-configured'})}`,'22023','qa_invalid_environment');
  error('manual migration retains edit environment guard',`SELECT ${commit('member',{...manualNext,observedEnvironment:'not-configured'},'edit','command',manualLatest.version)}`,'22023','qa_invalid_environment');
  error('manual migration retains submit fix environment guard',`SELECT ${commit('assignee',{...manualNext,targets:[{environment:'not-configured'}]},'submit_fix','command',manualLatest.version)}`,'22023','qa_invalid_environment');
  const manualDump = `jsonb_build_object(${tables.slice(0,7).flatMap(t => [literal(t),`(SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]'::jsonb) FROM ${t} r WHERE ${t==='qa_issues'?'id':'issue_id'}='manual-member')`]).join(',')})`;
  check('manual states and audit events pass restore validation without fabricated evidence',
    `public.livo_qa_restore(${literal(auth.super)}::uuid,${manualDump},true)->>'pending'='0'`);
  check('manual state restore is idempotent for exact existing rows',
    `public.livo_qa_restore(${literal(auth.super)}::uuid,${manualDump},false)->>'inserted'='0'`);
  check('manual transitions leave task deployments untouched',`(SELECT count(*) FROM task_deployments)=0`);
  appendQaFieldCases({sql,check,error,role,commit,save,base,auth,workflow,permissionFloorSql});
  role('postgres');
  // Snapshot all persistent QA rows and display settings before migration rerun.
  const snapshot = `jsonb_build_object(${tables.flatMap(t => [literal(t),`(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.${t} r)`]).join(',')},'workflow',(SELECT value FROM system_settings WHERE key='qa_workflow'),'fields',(SELECT value FROM system_settings WHERE key='qa_custom_fields'),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM members m))`;
  sql.push(`CREATE TABLE qa_test.before_rerun AS SELECT ${snapshot} AS data;`);
  const after = `SELECT qa_test.check((SELECT data FROM qa_test.before_rerun)=${snapshot},'second migration pass preserves every QA row and company workflow');
SELECT qa_test.check((SELECT count(*) FROM public.livo_schema_migrations)=${migrationCount},'release migration ledger stays deduplicated');
SELECT json_build_object('status','passed','assertions',count(*),'migrationPasses',2) FROM qa_test.results;`;
  return { sql: sql.join('\n'), after, assertionCount: labels.length+2, labels };
}
