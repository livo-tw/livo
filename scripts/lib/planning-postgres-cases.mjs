const q=x=>`'${String(x).replaceAll("'","''")}'`;
const uid={member:'00000000-0000-0000-0000-000000000001',admin:'00000000-0000-0000-0000-000000000002',super:'00000000-0000-0000-0000-000000000003',other:'00000000-0000-0000-0000-000000000004'};
export function buildPlanningPostgresCases(){
 const sql=[],labels=[];
 const check=(name,expr)=>{labels.push(name);sql.push(`SELECT planning_test.check((${expr}),${q(name)});`);};
 const error=(name,stmt,message)=>{labels.push(name);sql.push(`SELECT planning_test.error(${q(name)},${q(stmt)},${q(message)});`);};
 const as=(id,claims={})=>sql.push(`RESET ROLE; SET ROLE authenticated; SET request.jwt.claim.sub=${q(uid[id])}; SET request.jwt.claims=${q(JSON.stringify(claims))};`);
 const root=()=>sql.push('RESET ROLE; RESET request.jwt.claim.sub; RESET request.jwt.claims;');
 const due=(task='t-1',version=0,date='2027-01-20',kind='committed',reason=null,extra='')=>`SELECT public.livo_set_task_deadline(${q(task)},${version},${date===null?'NULL':q(date)},${kind===null?'NULL':q(kind)},${reason===null?'NULL':q(reason)}${extra})`;
 const pause=(task='t-1',version=0,until="now()+interval '1 day'")=>`SELECT public.livo_set_task_reminder(${q(task)},${until},${version})`;
 for(const id of ['member','admin','super']){
  as(id);sql.push(pause()+';');check(`${id}: creates own reminder`,`(SELECT member_id=${q(id)} AND version=1 FROM task_reminder_preferences WHERE task_id='t-1')`);
  error(`${id}: cannot create another member reminder`,"INSERT INTO task_reminder_preferences(task_id,member_id) VALUES('t-2','other')",'planning_forbidden');
  error(`${id}: reminder CAS`,pause(),'planning_conflict');
  sql.push(pause('t-1',1,'NULL')+';');check(`${id}: NULL resume`,`(SELECT snoozed_until IS NULL AND version=2 FROM task_reminder_preferences WHERE task_id='t-1')`);
  error(`${id}: immutable reminder identity`,"UPDATE task_reminder_preferences SET task_id='t-3',version=version+1 WHERE task_id='t-1'",'planning_conflict');
 }
 as('other');check('own-only read hides all other reminders','(SELECT count(*)=0 FROM task_reminder_preferences)');
 as('member');
 error('archived reminder RPC denied',pause('t-29'),'planning_unavailable');error('hidden reminder RPC denied',pause('t-30'),'planning_unavailable');
 error('archived deadline RPC denied',due('t-29'),'planning_unavailable');error('hidden deadline RPC denied',due('t-30'),'planning_unavailable');
 for(const [label,until] of [['past',"now()-interval '1 second'"],['too far',"now()+interval '367 days'"]])error(`pause ${label} invalid`,pause('t-2',0,until),'planning_invalid_pause');
 sql.push(due()+';');check('first deadline history actor/version',"(SELECT actor_id='member' AND version=1 FROM task_deadline_history WHERE task_id='t-1')");
 for(const [label,date,kind] of [['postpone','2027-02-01','committed'],['downgrade','2027-02-01','estimated'],['clear',null,null]])error(`committed ${label} requires reason`,due('t-1',1,date,kind),'planning_reason_required');
 error('history client insert denied',"INSERT INTO task_deadline_history(task_id,version) VALUES('t-1',90)",'permission denied');
 sql.push(due('t-1',1,'2027-02-01','estimated','Scope changed')+';');check('postponement has one new history',"(SELECT count(*)=2 FROM task_deadline_history WHERE task_id='t-1')");
 check('transient audit fields cleared',"(SELECT due_date_change_reason IS NULL AND due_date_changed_by IS NULL FROM tasks WHERE id='t-1')");
 error('stale due CAS',due('t-1',1),'planning_conflict');
 for(const date of ['2027-02-29','2027-13-01','2027-1-01'])error(`invalid date ${date}`,due('t-2',0,date),'planning_invalid_date');
 error('invalid kind',due('t-2',0,'2027-01-20','promised'),'planning_invalid_kind');error('kind needs date',due('t-2',0,null),'planning_date_required');
 sql.push(due('t-3',0,'2027-01-20',null)+';',due('t-3',1,'2027-02-01','estimated')+';',due('t-3',2,'2027-03-01','estimated')+';');check('unknown and estimated reasonless edits',"(SELECT count(*)=3 FROM task_deadline_history WHERE task_id='t-3')");
 sql.push(due('t-4',0,'2027-01-20','committed',null,",true,NULL,'2027-01-01'")+';');
 error('combined mutation rolls back on missing reason',due('t-4',1,'2027-02-01','committed',null,",true,'2027-01-01','2027-01-02'"),'planning_reason_required');
 check('combined rollback retains date and start',"(SELECT due_date='2027-01-20' AND started_at='2027-01-01' AND due_date_version=1 FROM tasks WHERE id='t-4')");
 error('combined stale start rejected',due('t-4',1,'2027-01-20','committed',null,",true,NULL,'2027-01-02'"),'planning_conflict');
 sql.push(due('t-4',1,'2027-01-20','committed',null,",true,'2027-01-01','2027-01-02'")+';');check('start-only edit preserves deadline history',"(SELECT started_at='2027-01-02' AND due_date_version=1 FROM tasks WHERE id='t-4')");
 error('generic task insert validates calendar',"INSERT INTO tasks(id,task_key,project_id,status_id,creator_id,due_date) VALUES('invalid-date','BAD','p','todo','member','2027-02-29')",'planning_invalid_date');
 sql.push("UPDATE tasks SET due_date='2027-01-20',due_date_kind='committed' WHERE id='t-5';");
 check('generic UPDATE writes attributed history',"(SELECT actor_id='member' AND version=1 FROM task_deadline_history WHERE task_id='t-5')");
 sql.push("UPDATE tasks SET due_date_change_reason='Unrelated old explanation' WHERE id='t-5';");error('generic old reason cannot authorize later postponement',"UPDATE tasks SET due_date='2027-02-01' WHERE id='t-5'",'planning_reason_required');
 error('generic reminder insert denies archived project',"INSERT INTO task_reminder_preferences(task_id,member_id) VALUES('t-29','member')",'planning_unavailable');
 error('generic insert kind needs date',"INSERT INTO tasks(id,task_key,project_id,status_id,creator_id,due_date_kind) VALUES('invalid-kind','BAD','p','todo','member','committed')",'planning_date_required');
 root();sql.push("INSERT INTO system_settings VALUES('required_fields','{\"dueDate\":true}');");as('member');
 error('required deadline cannot be cleared',due('t-1',2,null,null,'Changed'),'planning_date_required');
 root();sql.push("DELETE FROM system_settings WHERE key='required_fields';");
 root();sql.push("UPDATE members SET is_active=false WHERE id='member';");as('member');error('inactive member denied',due('t-6'),'planning_forbidden');
 root();sql.push("UPDATE members SET is_active=true WHERE id='member'; INSERT INTO members(id,auth_id,role,is_active) VALUES('duplicate','00000000-0000-0000-0000-000000000001','member',true);");as('member');error('ambiguous member denied',due('t-6'),'planning_forbidden');root();sql.push("DELETE FROM members WHERE id='duplicate';");
 const claims={livo_slack_binding:'00000000-0000-0000-0000-000000000010',livo_slack_team:'TTEST',livo_slack_user:'UTEST'};
 as('member',claims);sql.push(due('t-6')+';');check('complete signed Slack tuple accepted',"(SELECT due_date_version=1 FROM tasks WHERE id='t-6')");
 for(const key of Object.keys(claims)){const partial={...claims};delete partial[key];as('member',partial);error(`missing signed ${key} denied`,due('t-7'),'planning_forbidden');}
 as('member',{...claims,livo_slack_user:'UOTHER'});error('mismatched signed Slack identity denied',due('t-7'),'planning_forbidden');
 root();sql.push("UPDATE external_account_bindings SET is_verified=false WHERE id='00000000-0000-0000-0000-000000000010';");as('member',claims);error('unverified live binding denied',due('t-7'),'planning_forbidden');
 root();sql.push("UPDATE external_account_bindings SET is_verified=true WHERE id='00000000-0000-0000-0000-000000000010';");
 as('member');sql.push(pause('t-8')+';');root();sql.push("INSERT INTO notifications(id,recipient_id,sender_id,task_id,type) VALUES('due','member','other','t-8','due_soon'),('assigned','member','other','t-8','assigned'),('review','member','other','t-8','review_requested');");check('snooze suppresses due only',"(SELECT count(*)=2 AND bool_and(type IN ('assigned','review_requested')) FROM notifications)");
 // Each contender is a distinct native psql session. A winning transaction
 // holds its row lock briefly so the other process must wait and recheck CAS.
 const race=(name,a,b)=>{
  root();
  for(const [suffix,stmt]of [['a',a],['b',b]]){
   const lines=['BEGIN;',`SET ROLE authenticated; SET request.jwt.claim.sub=${q(uid.member)}; SET request.jwt.claims='{}';`,`INSERT INTO planning_test.races VALUES(${q(name+'-'+suffix)},planning_test.race(${q(stmt)}));`,'SELECT pg_sleep(0.35);','COMMIT;'];
   sql.push(`COPY (SELECT unnest(ARRAY[${lines.map(q).join(',')}])) TO '/tmp/planning-${name}-${suffix}.sql';`);
  }
  const sh=`psql -X -q -v ON_ERROR_STOP=1 -U postgres -d livo_qa_test -f /tmp/planning-${name}-a.sql > /tmp/planning-${name}-a.log 2>&1 &\na=$!\npsql -X -q -v ON_ERROR_STOP=1 -U postgres -d livo_qa_test -f /tmp/planning-${name}-b.sql > /tmp/planning-${name}-b.log 2>&1 &\nb=$!\nwait $a; ra=$?\nwait $b; rb=$?\ntest $ra -eq 0 -a $rb -eq 0`;
  sql.push(`COPY (SELECT unnest(ARRAY[${sh.split('\n').map(q).join(',')}])) TO '/tmp/planning-${name}.sh';`,String.raw`\! sh /tmp/planning-${name}.sh`);
  check(`${name} uses distinct sessions`,`(SELECT count(DISTINCT result->>'pid')=2 FROM planning_test.races WHERE label LIKE ${q(name+'-%')})`);
  check(`${name} one winner one CAS loser`,`(SELECT count(*) FILTER(WHERE result->>'status'='ok')=1 AND count(*) FILTER(WHERE result->>'message'='planning_conflict')=1 FROM planning_test.races WHERE label LIKE ${q(name+'-%')})`);
 };
 race('deadline',due('t-20'),due('t-20',0,'2027-01-21'));
 check('deadline race only one audit row',"(SELECT count(*)=1 FROM task_deadline_history WHERE task_id='t-20')");
 race('reminder',pause('t-21'),pause('t-21'));
 check('reminder race only one preference',"(SELECT count(*)=1 AND max(version)=1 FROM task_reminder_preferences WHERE task_id='t-21')");
 race('combined',due('t-22',0,'2027-01-20',null,null,",true,NULL,'2027-01-01'"),due('t-22',0,'2027-01-21',null,null,",true,NULL,'2027-01-02'"));
 check('combined race has matching date/start',"(SELECT (due_date='2027-01-20' AND started_at='2027-01-01') OR (due_date='2027-01-21' AND started_at='2027-01-02') FROM tasks WHERE id='t-22')");
 race('start-only',due('t-23',0,null,null,null,",true,NULL,'2027-01-01'"),due('t-23',0,null,null,null,",true,NULL,'2027-01-02'"));
 check('start-only race creates no deadline history',"(SELECT count(*)=0 FROM task_deadline_history WHERE task_id='t-23')");
 // Archive commits while a deadline reader is blocked on the task row. A
 // project snapshot from before that wait must not authorize the later write.
 root();sql.push("INSERT INTO projects VALUES('archive-race','line','Archive race','AR',false); UPDATE tasks SET project_id='archive-race' WHERE id='t-24';");
 const archiveA=['BEGIN;',"UPDATE projects SET is_archived=true WHERE id='archive-race';","UPDATE tasks SET title='Concurrent archive' WHERE id='t-24';","COPY (SELECT 'ready') TO '/tmp/planning-archive-ready';",'SELECT pg_sleep(0.6);','COMMIT;'];
 const archiveB=[`SET ROLE authenticated; SET request.jwt.claim.sub=${q(uid.member)}; SET request.jwt.claims='{}';`,`INSERT INTO planning_test.races VALUES('archive-b',planning_test.race(${q(due('t-24'))}));`];
 for(const [suffix,lines]of [['a',archiveA],['b',archiveB]])sql.push(`COPY (SELECT unnest(ARRAY[${lines.map(q).join(',')}])) TO '/tmp/planning-archive-${suffix}.sql';`);
 const archiveSh=['psql -X -q -v ON_ERROR_STOP=1 -U postgres -d livo_qa_test -f /tmp/planning-archive-a.sql > /tmp/planning-archive-a.log 2>&1 &','a=$!','i=0; while [ ! -f /tmp/planning-archive-ready ] && [ $i -lt 100 ]; do sleep 0.02; i=$((i+1)); done','test -f /tmp/planning-archive-ready || exit 2','psql -X -q -v ON_ERROR_STOP=1 -U postgres -d livo_qa_test -f /tmp/planning-archive-b.sql > /tmp/planning-archive-b.log 2>&1','b=$?','wait $a; a=$?','test $a -eq 0 -a $b -eq 0'];
 sql.push(`COPY (SELECT unnest(ARRAY[${archiveSh.map(q).join(',')}])) TO '/tmp/planning-archive.sh';`,String.raw`\! sh /tmp/planning-archive.sh`);
 check('archive commits before blocked deadline without stale authorization',"(SELECT result->>'message'='planning_unavailable' FROM planning_test.races WHERE label='archive-b') AND (SELECT due_date_version=0 FROM tasks WHERE id='t-24')");
 sql.push("UPDATE planning_test.results SET detail=jsonb_build_object('outcome',(SELECT result FROM planning_test.races WHERE label='archive-b'),'version',(SELECT due_date_version FROM tasks WHERE id='t-24'),'archived',(SELECT is_archived FROM projects WHERE id='archive-race'))::text WHERE label='archive commits before blocked deadline without stale authorization' AND NOT ok;");
 as('member');
 check('project lock trigger is not a callable member RPC',"NOT has_function_privilege('authenticated','livo_task_planning_project_guard()','EXECUTE') AND to_regprocedure('livo_task_planning_lock_project(text)') IS NULL");
 sql.push("UPDATE projects SET name='Forbidden' WHERE id='p';");
 check('member project UPDATE remains forbidden by RLS',"(SELECT name='Project' FROM projects WHERE id='p')");
 // An authority change attempts to commit while an RPC is waiting for its
 // task. Row locks may serialize or deadlock; neither ordering may commit a
 // task update together with a revoked authority. Real native sessions only.
 const authorityRace=(name,taskId,mutation,claimsValue,stillAuthorized)=>{
  root();
  const a=['BEGIN;',`SELECT id FROM tasks WHERE id=${q(taskId)} FOR UPDATE;`,`COPY (SELECT 'ready') TO '/tmp/planning-${name}-ready';`,'SELECT pg_sleep(0.4);',`INSERT INTO planning_test.races VALUES(${q(name+'-a')},planning_test.race(${q(mutation)}));`,'COMMIT;'];
  const b=[`SET ROLE authenticated; SET request.jwt.claim.sub=${q(uid.member)}; SET request.jwt.claims=${q(JSON.stringify(claimsValue))};`,`INSERT INTO planning_test.races VALUES(${q(name+'-b')},planning_test.race(${q(due(taskId))}));`];
  for(const[suffix,lines]of[['a',a],['b',b]])sql.push(`COPY (SELECT unnest(ARRAY[${lines.map(q).join(',')}])) TO '/tmp/planning-${name}-${suffix}.sql';`);
  const sh=[`psql -X -q -v ON_ERROR_STOP=1 -U postgres -d livo_qa_test -f /tmp/planning-${name}-a.sql > /tmp/planning-${name}-a.log 2>&1 &`,'a=$!',`i=0; while [ ! -f /tmp/planning-${name}-ready ] && [ $i -lt 100 ]; do sleep 0.02; i=$((i+1)); done`,`test -f /tmp/planning-${name}-ready || exit 2`,`psql -X -q -v ON_ERROR_STOP=1 -U postgres -d livo_qa_test -f /tmp/planning-${name}-b.sql > /tmp/planning-${name}-b.log 2>&1`,'b=$?','wait $a; a=$?','test $a -eq 0 -a $b -eq 0'];
  sql.push(`COPY (SELECT unnest(ARRAY[${sh.map(q).join(',')}])) TO '/tmp/planning-${name}.sh';`,String.raw`\! sh /tmp/planning-${name}.sh`);
  check(`${name}: real two sessions complete`,`(SELECT count(*)=2 AND count(DISTINCT result->>'pid')=2 FROM planning_test.races WHERE label LIKE ${q(name+'-%')})`);
  check(`${name}: no write with revoked authority`,`(SELECT due_date_version=0 OR (${stillAuthorized}) FROM tasks WHERE id=${q(taskId)})`);
 };
 authorityRace('deactivate','t-25',"UPDATE members SET is_active=false WHERE id='member'",{},"SELECT is_active FROM members WHERE id='member'");
 root();sql.push("UPDATE members SET is_active=true WHERE id='member';");
 authorityRace('unbind','t-26',"UPDATE external_account_bindings SET is_verified=false WHERE id='00000000-0000-0000-0000-000000000010'",claims,"SELECT is_verified FROM external_account_bindings WHERE id='00000000-0000-0000-0000-000000000010'");
 root();sql.push("UPDATE external_account_bindings SET is_verified=true WHERE id='00000000-0000-0000-0000-000000000010';");
 root();sql.push("INSERT INTO comments VALUES('keep-comment','t-1','member','Synthetic preserved comment'); SET ROLE service_role;");
 sql.push("INSERT INTO approval_requests VALUES('pending-request','member','pending');");
 error('Jira rejects pending approval before any child delete','SELECT livo_jira_clear_tasks()','approval_pending');
 check('approval rejection preserves comments and tasks',"EXISTS(SELECT 1 FROM comments WHERE id='keep-comment') AND EXISTS(SELECT 1 FROM tasks WHERE id='t-1')");
 sql.push("DELETE FROM approval_requests; UPDATE tasks SET current_approval_id='unlinked-request' WHERE id='t-1';");
 error('Jira rejects dangling task approval pointer','SELECT livo_jira_clear_tasks()','approval_pending');
 sql.push("UPDATE tasks SET current_approval_id=NULL WHERE id='t-1';");
 error('Jira guard rejects planning history before child deletes','SELECT livo_jira_clear_tasks()','planning_history_requires_restore');
 check('Jira rejection preserves comments and tasks',"EXISTS(SELECT 1 FROM comments WHERE id='keep-comment') AND EXISTS(SELECT 1 FROM tasks WHERE id='t-1')");
 as('admin');error('Jira destructive clear is service only','SELECT livo_jira_clear_tasks()','permission denied');
 root();sql.push('DELETE FROM task_deadline_history; DELETE FROM task_reminder_preferences; SET ROLE service_role; SELECT livo_jira_clear_tasks();');
 check('Jira clear succeeds only without planning evidence','(SELECT count(*)=0 FROM tasks) AND (SELECT count(*)=0 FROM comments)');
 root();sql.push(`SELECT jsonb_build_object('status',CASE WHEN bool_and(ok) THEN 'passed' ELSE 'failed' END,'assertions',count(*),'failed',COALESCE(jsonb_agg(jsonb_build_object('label',label,'detail',detail)) FILTER(WHERE NOT ok),'[]'::jsonb),'migrationApplications',2,'realTwoSessionRaces',7,'authorityRaceOutcomes',(SELECT jsonb_object_agg(label,result) FROM planning_test.races WHERE label LIKE 'deactivate-%' OR label LIKE 'unbind-%')) FROM planning_test.results;`);
 return {sql:sql.join('\n'),labels};
}
