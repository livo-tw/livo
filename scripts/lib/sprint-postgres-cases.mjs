const q=v=>"'"+String(v).replaceAll("'","''")+"'";
const uid={member:'00000000-0000-0000-0000-000000000001',admin:'00000000-0000-0000-0000-000000000002',super:'00000000-0000-0000-0000-000000000003',other:'00000000-0000-0000-0000-000000000004'};
export function buildSprintPostgresCases(){
 const sql=[],labels=[];let seq=100,races=0;const raw=s=>sql.push(s);
 const root=()=>raw("RESET ROLE; SET request.jwt.claim.sub=''; SET request.jwt.claim.role=''; SET request.jwt.claims='{}';");
 const member=(who='member')=>raw("SET ROLE authenticated; SET request.jwt.claim.sub="+q(uid[who]??who)+"; SET request.jwt.claim.role='authenticated'; SET request.jwt.claims='{}';");
 const check=(label,expr)=>{labels.push(label);raw('SELECT work_test.check(('+expr+'),'+q(label)+');');};
 const error=(label,statement,message,state)=>{labels.push(label);raw('SELECT sprint_test.error('+q(label)+','+q(statement)+','+q(message)+','+q(state)+');');};
 const id=()=>`20000000-0000-0000-0000-${String(++seq).padStart(12,'0')}`;
 const start=(name,taskIds=[],includeBacklog=false,sprintId=id(),commandId=id())=>({commandId,operation:'start',sprintId,name,taskIds,includeBacklog});
 const complete=(sprintId,expectedVersion,commandId=id())=>({commandId,operation:'complete',sprintId,expectedVersion});
 const call=c=>'SELECT public.livo_sprint_command('+q(JSON.stringify(c))+'::jsonb)';
 const save=(label,c)=>raw('INSERT INTO work_test.saved '+call(c).replace('SELECT public.','SELECT '+q(label)+', public.')+';');
 const data=label=>'(SELECT result FROM work_test.saved WHERE label='+q(label)+')';
 root();raw(`CREATE SCHEMA sprint_test;
 CREATE FUNCTION sprint_test.error(label text,statement text,message text,state text) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
 DECLARE actual text; code text;
 BEGIN BEGIN EXECUTE statement;EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=MESSAGE_TEXT,code=RETURNED_SQLSTATE;
 INSERT INTO work_test.results VALUES(label,position(message IN actual)>0 AND code=state,CASE WHEN position(message IN actual)=0 OR code<>state THEN code||':'||actual END);RETURN;END;
 INSERT INTO work_test.results VALUES(label,false,'unexpected success');END $$;
 GRANT USAGE ON SCHEMA sprint_test TO anon,authenticated,service_role;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA sprint_test TO anon,authenticated,service_role;`);
 check('sprint legacy completed totals and unknown split retained',"(SELECT completed_count=9 AND pending_count=4 AND cancelled_count IS NULL AND history_captured_at IS NULL FROM sprints WHERE id='10000000-0000-0000-0000-000000000002')");
 check('sprint legacy membership unknown not invented closure',"EXISTS(SELECT 1 FROM sprint_task_history WHERE sprint_id='10000000-0000-0000-0000-000000000002' AND task_id='t-80' AND source='legacy' AND outcome='unknown')");
 check('sprint first migration backfills only exact cancellation identities',data('sprint-cancel-first')+"->>'s7'='true' AND "+data('sprint-cancel-first')+"->>'namespaced'='true' AND "+data('sprint-cancel-first')+"->>'custom'='false'");
 check('sprint rerun does not override explicitly changed classification',"(SELECT is_cancelled=false AND is_done=true FROM statuses WHERE id='s7')");
 raw("UPDATE statuses SET is_cancelled=true WHERE id='s7'; INSERT INTO statuses(id,name,is_done,is_cancelled) VALUES('sprint-custom-cancel','Custom cancelled',true,true); INSERT INTO projects(id,name,key,is_archived) VALUES('sprint-project','Synthetic sprint project','SP',false);");
 member();save('sprint-parent-closed',complete('10000000-0000-0000-0000-000000000001',0));
 check('sprint legacy active can close without fabricated old history',data('sprint-parent-closed')+"->>'version'='1' AND (SELECT history_captured_at IS NOT NULL FROM sprints WHERE id='10000000-0000-0000-0000-000000000001')");
 root();raw("INSERT INTO tasks(id,task_key,project_id,title,status_id,creator_id) VALUES('sp-1','SP-1','sprint-project','Pending snapshot title','todo','member'),('sp-2','SP-2','sprint-project','Cancel snapshot title','todo','member'),('sp-done','SP-3','sprint-project','Already finished','done','member'),('sp-cancel','SP-4','sprint-project','Already cancelled','s7','member'),('sp-removed','SP-5','sprint-project','Removed title','todo','member'),('sp-new','SP-6','sprint-project','Concurrent join','todo','member');");
 member();const a=start(' Sprint A ',['sp-1','sp-1']);save('sprint-A-start',a);
 check('sprint start explicit selection deduplicated without implicit backlog',data('sprint-A-start')+"->'taskIds'='[\"sp-1\"]' AND "+data('sprint-A-start')+"->>'pendingCount'='1' AND "+data('sprint-A-start')+"->'pendingIds'='[\"sp-1\"]' AND "+data('sprint-A-start')+"->'carryIds'='[\"sp-1\"]'");
 check('sprint start version1 actor authorized name trimmed',"(SELECT version=1 AND name='Sprint A' AND is_active AND pending_count=1 FROM sprints WHERE id="+q(a.sprintId)+")");
 check('sprint backlog opt-in initially false preserves remaining backlog',"(SELECT bool_and(sprint_id IS NULL) FROM tasks WHERE id IN('sp-2','sp-done','sp-cancel','sp-removed'))");
 save('sprint-A-replay',{...a,name:'Sprint A',taskIds:['sp-1']});check('sprint equivalent payload replays original result',data('sprint-A-replay')+"->>'replayed'='true' AND ("+data('sprint-A-replay')+"-'replayed')="+data('sprint-A-start'));
 error('sprint same command changed content conflicts',call({...a,name:'Other'}),'sprint_command_reused','PT409');
 member('other');error('sprint command cannot be reused by another actor',call(a),'sprint_command_reused','PT409');member();
 const busy=start('Second active',[]);error('sprint second active start conflicts',call(busy),'sprint_conflict','PT409');root();check('sprint rejected start writes no sprint receipt or context',"NOT EXISTS(SELECT 1 FROM sprints WHERE id="+q(busy.sprintId)+") AND NOT EXISTS(SELECT 1 FROM sprint_command_receipts WHERE command_id="+q(busy.commandId)+") AND NOT EXISTS(SELECT 1 FROM sprint_command_contexts WHERE command_id="+q(busy.commandId)+")");
 member();
 error('sprint direct insert cannot bypass command',"INSERT INTO sprints(id,name) VALUES('30000000-0000-0000-0000-000000000001','Forged')",'sprint_forbidden','42501');
 error('sprint direct completion cannot bypass atomic command',"UPDATE sprints SET is_active=false WHERE id="+q(a.sprintId),'sprint_forbidden','42501');
 error('sprint direct version forgery denied',"UPDATE sprints SET version=99 WHERE id="+q(a.sprintId),'sprint_forbidden','42501');
 error('sprint history direct mutation denied',"UPDATE sprint_task_history SET title='forged'",'permission denied','42501');
 error('sprint receipt direct mutation denied',"INSERT INTO sprint_command_receipts VALUES('30000000-0000-0000-0000-000000000002','member','{}','{}',now())",'permission denied','42501');
 raw("UPDATE sprints SET name=' Sprint A renamed ' WHERE id="+q(a.sprintId)+"; UPDATE tasks SET sprint_id="+q(a.sprintId)+" WHERE id IN('sp-2','sp-removed'); UPDATE tasks SET sprint_id=NULL WHERE id='sp-removed'; INSERT INTO tasks(id,task_key,project_id,parent_task_id,title,status_id,creator_id,sprint_id) VALUES('sp-child','SP-7','sprint-project','sp-1','Done child snapshot','done','member','10000000-0000-0000-0000-000000000002'); UPDATE tasks SET status_id='s7' WHERE id='sp-2';");
 check('sprint rename increments version and normalizes name',"(SELECT version=2 AND name='Sprint A renamed' FROM sprints WHERE id="+q(a.sprintId)+")");
 check('sprint normal assignment and removal observed',"EXISTS(SELECT 1 FROM sprint_task_history WHERE task_id='sp-removed' AND sprint_id="+q(a.sprintId)+" AND outcome='removed' AND source='observed')");
 check('sprint new child inherits only actual active parent sprint',"(SELECT sprint_id="+q(a.sprintId)+" FROM tasks WHERE id='sp-child')");
 error('sprint stale complete version conflicts after rename',call(complete(a.sprintId,1)),'sprint_conflict','PT409');
 const close=complete(a.sprintId,2);save('sprint-A-close',close);
 check('sprint cancelled separate from completed and pending counts',data('sprint-A-close')+"->>'completedCount'='1' AND "+data('sprint-A-close')+"->>'cancelledCount'='1' AND "+data('sprint-A-close')+"->>'pendingCount'='1'");
 check('sprint completion final taskIds exclude earlier removals',data('sprint-A-close')+"->'taskIds'='[\"sp-1\",\"sp-2\",\"sp-child\"]' AND "+data('sprint-A-close')+"->'pendingIds'='[\"sp-1\"]'");
 check('sprint pending backlog detached done cancelled retained',"(SELECT sprint_id IS NULL FROM tasks WHERE id='sp-1') AND (SELECT bool_and(sprint_id="+q(a.sprintId)+") FROM tasks WHERE id IN('sp-2','sp-child'))");
 check('sprint final snapshots and removed history retained separately',"(SELECT count(*)=3 FROM sprint_task_history WHERE sprint_id="+q(a.sprintId)+" AND source='snapshot') AND EXISTS(SELECT 1 FROM sprint_task_history WHERE sprint_id="+q(a.sprintId)+" AND task_id='sp-removed' AND outcome='removed')");
 raw("UPDATE tasks SET title='Later title',status_id='todo' WHERE id='sp-child'; UPDATE tasks SET status_id='done' WHERE id='sp-2';");
 check('sprint later live changes do not rewrite closed snapshot',"EXISTS(SELECT 1 FROM sprint_task_history WHERE task_id='sp-child' AND sprint_id="+q(a.sprintId)+" AND title='Done child snapshot' AND outcome='completed') AND EXISTS(SELECT 1 FROM sprint_task_history WHERE task_id='sp-2' AND sprint_id="+q(a.sprintId)+" AND outcome='cancelled')");
 save('sprint-A-close-replay',close);check('sprint lost response completion replay remains committed result',data('sprint-A-close-replay')+"->>'replayed'='true' AND ("+data('sprint-A-close-replay')+"-'replayed')="+data('sprint-A-close'));
 root();raw("UPDATE system_settings SET value='{}' WHERE key='required_fields'; SET ROLE service_role;");
 raw("INSERT INTO work_test.saved SELECT 'sprint-closed-parent-child',public.livo_task_work_command("+q(uid.member)+"::uuid,'{\"commandId\":\"sprint-child-work\",\"operation\":\"create_subtask\",\"taskId\":\"sp-2\",\"title\":\"Closed parent child\",\"statusId\":\"todo\",\"priority\":\"medium\",\"assigneeId\":null,\"reviewerId\":null,\"dueDate\":null}'::jsonb,'"+'a'.repeat(64)+"');");
 check('sprint actual atomic TaskWork child under closed parent goes backlog',"(SELECT sprint_id IS NULL AND parent_task_id='sp-2' FROM tasks WHERE id=("+data('sprint-closed-parent-child')+"#>>'{record,id}'))");
 member('admin');raw("DELETE FROM tasks WHERE id='sp-2';");member();check('sprint deleted task snapshot remains readable in authorized project',"EXISTS(SELECT 1 FROM sprint_task_history WHERE task_id='sp-2' AND title='Cancel snapshot title' AND outcome='cancelled')");
 root();raw("CREATE POLICY sprint_test_project_hidden ON projects AS RESTRICTIVE FOR SELECT TO authenticated USING(id<>'sprint-project');");
 for(const who of ['member','admin','super']){member(who);check(who+' sprint history respects current project read policy',"NOT EXISTS(SELECT 1 FROM sprint_task_history WHERE project_id='sprint-project')");}
 root();raw("DROP POLICY sprint_test_project_hidden ON projects;");member();
 for(const [label,cmd] of [['extra actor',{...start('Bad'),actorId:'super'}],['unknown operation',{commandId:id(),operation:'rename',sprintId:a.sprintId}],['bad name',start(' '.repeat(4))],['bad bool',{...start('Bad'),includeBacklog:'false'}],['bad array',{...start('Bad'),taskIds:null}],['too many IDs',start('Bad',Array(2001).fill('sp-1'))],['finished explicit',start('Bad',['sp-done'])],['cancelled explicit',start('Bad',['sp-cancel'])]])error('sprint rejects '+label,call(cmd),'sprint_invalid_input','22023');
 const b=start('Sprint B',[],true);save('sprint-B-start',b);check('sprint include all backlog includes open not terminal nor earlier retained',data('sprint-B-start')+"->'taskIds' ? 'sp-1' AND NOT("+data('sprint-B-start')+"->'taskIds' ? 'sp-done') AND NOT("+data('sprint-B-start')+"->'taskIds' ? 'sp-cancel') AND NOT("+data('sprint-B-start')+"->'taskIds' ? 'sp-child')");
 check('sprint carried card retains older pending snapshot',"EXISTS(SELECT 1 FROM sprint_task_history WHERE task_id='sp-1' AND sprint_id="+q(a.sprintId)+" AND source='snapshot' AND outcome='pending') AND EXISTS(SELECT 1 FROM sprint_task_history WHERE task_id='sp-1' AND sprint_id="+q(b.sprintId)+" AND source='observed')");
 save('sprint-B-close',complete(b.sprintId,1));
 root();raw("INSERT INTO projects(id,name,key,is_archived) VALUES('sprint-archive-project','Synthetic archived sprint project','SCA',false); INSERT INTO tasks(id,task_key,project_id,title,status_id,creator_id) VALUES('sp-carry-live','SP-901','sprint-project','Live pending carry','todo','member'),('sp-carry-archived','SCA-901','sprint-archive-project','Archived pending backlog','todo','member');");
 member();const archived=start('Archive during sprint',['sp-carry-live','sp-carry-archived']);save('sprint-archived-start',archived);root();raw("UPDATE projects SET is_archived=true WHERE id='sprint-archive-project';");member();const archivedClose=complete(archived.sprintId,1);save('sprint-archived-close',archivedClose);
 check('sprint completed pending IDs include archived while carry IDs exclude archived',data('sprint-archived-close')+"->>'pendingCount'='2' AND "+data('sprint-archived-close')+"->'pendingIds'='[\"sp-carry-archived\",\"sp-carry-live\"]' AND "+data('sprint-archived-close')+"->'carryIds'='[\"sp-carry-live\"]'");
 check('sprint archived pending still detached with immutable completion snapshot',"(SELECT bool_and(sprint_id IS NULL) FROM tasks WHERE id IN('sp-carry-live','sp-carry-archived')) AND (SELECT count(*)=2 FROM sprint_task_history WHERE sprint_id="+q(archived.sprintId)+" AND source='snapshot' AND outcome='pending')");
 error('sprint explicit archived pending cannot enter new sprint',call(start('Forbidden archived carry',['sp-carry-archived'])),'sprint_invalid_input','22023');
 const skipArchived=start('Include backlog skips archived',[],true);save('sprint-backlog-no-archived',skipArchived);check('sprint include backlog excludes archived pending and start carry matches task IDs',"NOT("+data('sprint-backlog-no-archived')+"->'taskIds' ? 'sp-carry-archived') AND "+data('sprint-backlog-no-archived')+"->'carryIds'="+data('sprint-backlog-no-archived')+"->'taskIds'");save('sprint-backlog-no-archived-close',complete(skipArchived.sprintId,1));
 root();raw("UPDATE projects SET is_archived=false WHERE id='sprint-archive-project';");member();save('sprint-archived-close-replay',archivedClose);check('sprint completion retry keeps transaction carry result after later project changes',data('sprint-archived-close-replay')+"->>'replayed'='true' AND ("+data('sprint-archived-close-replay')+"-'replayed')="+data('sprint-archived-close'));

 for(const who of ['member','admin','super']){member(who);const role=start('Role '+who,[]);save('sprint-role-'+who,role);check(who+' sprint existing permissions preserved',data('sprint-role-'+who)+"->>'version'='1'");save('sprint-role-'+who+'-close',complete(role.sprintId,1));}
 root();raw("UPDATE members SET is_active=false WHERE id='member';");member();error('sprint deactivated actor replay denied',call(close),'sprint_forbidden','42501');root();raw("UPDATE members SET is_active=true WHERE id='member';");member('00000000-0000-0000-0000-000000000099');error('sprint unlinked login denied',call(start('Unknown')),'sprint_forbidden','42501');root();raw('SET ROLE anon;');error('sprint anonymous RPC denied',call(start('Anon')),'permission denied','42501');root();raw('SET ROLE service_role;');error('sprint service without verified actor not elevated',call(start('Service')),'sprint_forbidden','42501');
 // Native independent sessions: no shared mock/client connection.
 const runPair=(name,left,right)=>{races++;root();const encode=s=>Buffer.from(s).toString('base64');for(const [suffix,body]of[['a',left],['b',right]])raw("\\! printf '%s' '"+encode(body.join('\n'))+"' | base64 -d > /tmp/work-"+name+'-'+suffix+'.sql');raw("\\! psql -X -q -v ON_ERROR_STOP=1 -U postgres -d livo_task_work_test -f /tmp/work-"+name+"-a.sql > /tmp/work-"+name+"-a.out 2>&1 & a=$!; for i in $(seq 1 100); do test -f /tmp/work-"+name+"-ready && break; sleep 0.01; done; psql -X -q -v ON_ERROR_STOP=1 -U postgres -d livo_task_work_test -f /tmp/work-"+name+"-b.sql > /tmp/work-"+name+"-b.out 2>&1 & b=$!; wait $a; wait $b");check(name+' real independent sessions',"(SELECT count(*)=2 AND count(DISTINCT result->>'pid')=2 FROM work_test.races WHERE label IN("+q(name+'-a')+','+q(name+'-b')+"))");};
 const auth=["SET ROLE authenticated;","SET request.jwt.claim.sub="+q(uid.member)+";"];
 const r1=start('Race first',['sp-1']),r2=start('Race second',['sp-1']);
 runPair('sprint-start',["BEGIN;",...auth,"INSERT INTO work_test.races VALUES('sprint-start-a',work_test.race("+q(call(r1))+"));","RESET ROLE;","COPY(SELECT 'ready') TO '/tmp/work-sprint-start-ready';","SELECT pg_sleep(0.3);","COMMIT;"],[...auth,"INSERT INTO work_test.races VALUES('sprint-start-b',work_test.race("+q(call(r2))+"));"]);
 check('sprint concurrent start one commits other409 no partial',"(SELECT result->>'status'='ok' FROM work_test.races WHERE label='sprint-start-a') AND (SELECT result->>'code'='PT409' FROM work_test.races WHERE label='sprint-start-b') AND (SELECT count(*)=1 FROM sprints WHERE is_active)");
 const busyclose=complete(r1.sprintId,1);
 runPair('sprint-status',["BEGIN;","UPDATE tasks SET status_id='done' WHERE id='sp-1';","COPY(SELECT 'ready') TO '/tmp/work-sprint-status-ready';","SELECT pg_sleep(0.3);","INSERT INTO work_test.races VALUES('sprint-status-a',jsonb_build_object('status','ok','pid',pg_backend_pid()));","COMMIT;"],[...auth,"INSERT INTO work_test.races VALUES('sprint-status-b',work_test.race("+q(call(busyclose))+"));"]);
 check('sprint busy changed task fails409 without closing',"(SELECT result->>'code'='PT409' FROM work_test.races WHERE label='sprint-status-b') AND (SELECT is_active AND version=1 FROM sprints WHERE id="+q(r1.sprintId)+") AND NOT EXISTS(SELECT 1 FROM sprint_command_receipts WHERE command_id="+q(busyclose.commandId)+")");member();save('sprint-race-retry',busyclose);check('sprint retry after status race classifies current committed done',data('sprint-race-retry')+"->>'completedCount'='1'");
 root();raw("UPDATE tasks SET status_id='todo',sprint_id=NULL WHERE id='sp-1';");member();const phantom=start('Phantom race',['sp-1']);save('sprint-phantom-start',phantom);const phantomClose=complete(phantom.sprintId,1);
 runPair('sprint-join',["BEGIN;",...auth,"UPDATE tasks SET sprint_id="+q(phantom.sprintId)+" WHERE id='sp-new';","RESET ROLE;","COPY(SELECT 'ready') TO '/tmp/work-sprint-join-ready';","SELECT pg_sleep(0.3);","INSERT INTO work_test.races VALUES('sprint-join-a',jsonb_build_object('status','ok','pid',pg_backend_pid()));","COMMIT;"],[...auth,"INSERT INTO work_test.races VALUES('sprint-join-b',work_test.race("+q(call(phantomClose))+"));"]);
 check('sprint unseen membership join blocks closure with409',"(SELECT result->>'code'='PT409' FROM work_test.races WHERE label='sprint-join-b') AND (SELECT is_active FROM sprints WHERE id="+q(phantom.sprintId)+")");member();save('sprint-phantom-retry',phantomClose);check('sprint retry includes committed concurrent membership',data('sprint-phantom-retry')+"->'taskIds' ? 'sp-new' AND "+data('sprint-phantom-retry')+"->>'pendingCount'='2'");
 root();raw(`CREATE FUNCTION sprint_test.fail_second_assignment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.sprint_id IS NOT NULL AND NEW.id IN('sp-1','sp-new') AND EXISTS(SELECT 1 FROM tasks WHERE id IN('sp-1','sp-new') AND id<>NEW.id AND sprint_id=NEW.sprint_id) THEN RAISE EXCEPTION 'sprint_test_atomic_fault' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
 CREATE TRIGGER sprint_test_fail_second_assignment BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION sprint_test.fail_second_assignment();`);
 member();const faultStart=start('Atomic fault sprint',['sp-1','sp-new']);error('sprint second assignment injected failure is returned',call(faultStart),'sprint_test_atomic_fault','23514');root();
 check('sprint failed start rolls back header context receipt tasks history',"NOT EXISTS(SELECT 1 FROM sprints WHERE id="+q(faultStart.sprintId)+") AND NOT EXISTS(SELECT 1 FROM sprint_command_contexts WHERE command_id="+q(faultStart.commandId)+") AND NOT EXISTS(SELECT 1 FROM sprint_command_receipts WHERE command_id="+q(faultStart.commandId)+") AND NOT EXISTS(SELECT 1 FROM sprint_task_history WHERE sprint_id="+q(faultStart.sprintId)+") AND (SELECT bool_and(sprint_id IS NULL) FROM tasks WHERE id IN('sp-1','sp-new'))");
 raw('DROP TRIGGER sprint_test_fail_second_assignment ON tasks; DROP FUNCTION sprint_test.fail_second_assignment();');member();save('sprint-fault-start-retry',faultStart);root();
 check('sprint failed start same command retry applies exactly once',"(SELECT count(*)=1 FROM sprint_command_receipts WHERE command_id="+q(faultStart.commandId)+") AND (SELECT count(*)=2 FROM sprint_task_history WHERE sprint_id="+q(faultStart.sprintId)+" AND source='observed')");
 raw(`CREATE FUNCTION sprint_test.fail_second_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.source='snapshot' AND EXISTS(SELECT 1 FROM sprint_task_history WHERE sprint_id=NEW.sprint_id AND task_id<>NEW.task_id AND source='snapshot') THEN RAISE EXCEPTION 'sprint_test_snapshot_fault' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
 CREATE TRIGGER sprint_test_fail_second_snapshot BEFORE INSERT OR UPDATE ON sprint_task_history FOR EACH ROW EXECUTE FUNCTION sprint_test.fail_second_snapshot();`);
 member();const faultClose=complete(faultStart.sprintId,1);error('sprint second snapshot injected failure is returned',call(faultClose),'sprint_test_snapshot_fault','23514');root();
 check('sprint failed completion rolls back snapshots version detach and receipt',"(SELECT is_active AND version=1 AND history_captured_at IS NULL FROM sprints WHERE id="+q(faultStart.sprintId)+") AND (SELECT count(*)=2 FROM sprint_task_history WHERE sprint_id="+q(faultStart.sprintId)+" AND source='observed') AND (SELECT bool_and(sprint_id="+q(faultStart.sprintId)+") FROM tasks WHERE id IN('sp-1','sp-new')) AND NOT EXISTS(SELECT 1 FROM sprint_command_receipts WHERE command_id="+q(faultClose.commandId)+") AND NOT EXISTS(SELECT 1 FROM sprint_command_contexts WHERE command_id="+q(faultClose.commandId)+")");
 raw('DROP TRIGGER sprint_test_fail_second_snapshot ON sprint_task_history; DROP FUNCTION sprint_test.fail_second_snapshot();');member();
 const decimal=call(faultClose).replace('"expectedVersion":1','"expectedVersion":1.0');raw('INSERT INTO work_test.saved '+decimal.replace('SELECT public.','SELECT '+q('sprint-decimal-complete')+', public.')+';');
 check('sprint integer JSON decimal1point0 matches D1 numeric integer semantics',data('sprint-decimal-complete')+"->>'version'='2' AND "+data('sprint-decimal-complete')+"->>'pendingCount'='2'");
 save('sprint-decimal-replay',faultClose);root();check('sprint equivalent numeric completion retry preserves one receipt and snapshots',data('sprint-decimal-replay')+"->>'replayed'='true' AND (SELECT count(*)=1 FROM sprint_command_receipts WHERE command_id="+q(faultClose.commandId)+") AND (SELECT count(*)=2 FROM sprint_task_history WHERE sprint_id="+q(faultStart.sprintId)+" AND source='snapshot')");member();
 error('sprint fractional expected version rejected',call(complete(faultStart.sprintId,1.5)),'sprint_invalid_input','22023');error('sprint text expected version rejected',call(complete(faultStart.sprintId,'1')),'sprint_invalid_input','22023');
 root();raw(`CREATE FUNCTION sprint_test.receipt_only_clear_guard() RETURNS jsonb LANGUAGE plpgsql AS $$
 DECLARE actual text;code text;
 BEGIN
  BEGIN
   DELETE FROM public.sprint_task_history;DELETE FROM public.task_work_events;DELETE FROM public.task_work_receipts;
   EXECUTE 'SET LOCAL ROLE service_role';
   BEGIN PERFORM public.livo_jira_clear_tasks();EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=MESSAGE_TEXT,code=RETURNED_SQLSTATE;END;
   RAISE EXCEPTION 'restore synthetic test changes' USING ERRCODE='ZT001';
  EXCEPTION WHEN SQLSTATE 'ZT001' THEN NULL;END;
  RETURN jsonb_build_object('guarded',actual='work_history_requires_restore' AND code='23514','actual',actual,'code',code);
 END $$;`);
 raw("INSERT INTO work_test.saved SELECT 'sprint-receipt-only-debug',sprint_test.receipt_only_clear_guard();");
 check('sprint receipt alone guards Jira reset even with zero history',"("+data('sprint-receipt-only-debug')+"->>'guarded')::boolean AND EXISTS(SELECT 1 FROM sprint_task_history) AND EXISTS(SELECT 1 FROM sprint_command_receipts)");
 raw("UPDATE work_test.results SET detail=(SELECT result::text FROM work_test.saved WHERE label='sprint-receipt-only-debug') WHERE label='sprint receipt alone guards Jira reset even with zero history' AND NOT ok;");

 root();raw(`CREATE FUNCTION sprint_test.context_lifecycle_probe() RETURNS jsonb LANGUAGE plpgsql AS $$
 DECLARE start_guarded boolean:=false;close_guarded boolean:=false;
 BEGIN
  BEGIN
   PERFORM public.livo_sprint_command('{"commandId":"20000000-0000-0000-0000-000000009901","operation":"start","sprintId":"20000000-0000-0000-0000-000000009900","name":"Same transaction guard probe","taskIds":[],"includeBacklog":false}'::jsonb);
   BEGIN UPDATE public.sprints SET completed_count=999 WHERE id='20000000-0000-0000-0000-000000009900';EXCEPTION WHEN insufficient_privilege THEN start_guarded:=SQLERRM='sprint_forbidden';END;
   PERFORM public.livo_sprint_command('{"commandId":"20000000-0000-0000-0000-000000009902","operation":"complete","sprintId":"20000000-0000-0000-0000-000000009900","expectedVersion":1}'::jsonb);
   BEGIN UPDATE public.sprints SET is_active=true,completed_count=999 WHERE id='20000000-0000-0000-0000-000000009900';EXCEPTION WHEN insufficient_privilege THEN close_guarded:=SQLERRM='sprint_forbidden';END;
   RAISE EXCEPTION 'restore synthetic context probe' USING ERRCODE='ZT002';
  EXCEPTION WHEN SQLSTATE 'ZT002' THEN NULL;END;
  RETURN jsonb_build_object('start_guarded',start_guarded,'complete_guarded',close_guarded);
 END $$;`);member();raw("INSERT INTO work_test.saved SELECT 'sprint-context-probe',sprint_test.context_lifecycle_probe();");
 check('sprint start clears context before later same transaction generic write',"("+data('sprint-context-probe')+"->>'start_guarded')::boolean");
 check('sprint complete clears context before later same transaction generic reopen',"("+data('sprint-context-probe')+"->>'complete_guarded')::boolean");
 root();raw("SELECT jsonb_build_object('status',CASE WHEN bool_and(ok) THEN 'passed' ELSE 'failed' END,'assertions',count(*),'failures',COALESCE(jsonb_agg(jsonb_build_object('label',label,'detail',detail)) FILTER(WHERE NOT ok),'[]'::jsonb),'sprintRealTwoSessionRaces',"+races+") FROM work_test.results;");
 return {sql:sql.join('\n'),labels,races};
}