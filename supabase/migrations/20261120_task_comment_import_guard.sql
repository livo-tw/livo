-- JSON/Jira replacement cannot discard private comment media excluded from JSON.
-- Keep the real knowledge -> release -> QA/TaskWork/Sprint clear chain and its OID/ACL.
DO $migration$
DECLARE
 target regprocedure:=to_regprocedure('public.livo_jira_clear_tasks()');
 definition text; body text; delegate_body text; original_owner oid; original_acl aclitem[];
 anchor text:='RETURN public.livo_jira_clear_tasks_pre_knowledge_guard();';
 planning text:='PERFORM pg_advisory_xact_lock(hashtext(''livo-task-planning-import''));';
 private_guard text:=$guard$
 LOCK TABLE public.task_comment_uploads IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM public.task_comment_uploads WHERE workspace_id='default' AND state<>'aborted') THEN
  RAISE EXCEPTION 'task_comment_requires_server_restore' USING ERRCODE='23514';
 END IF;$guard$;
 known_wrapper text:=$known$
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
 -- Same lock knowledge-work commits hold while creating source links, so no
 -- link can appear between this check and the first child deletion.
 PERFORM generation FROM public.kb_work_clock WHERE id=1 FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.kb_source_links WHERE source_kind IN('task','task_file','qa','qa_file')) THEN
  RAISE EXCEPTION 'knowledge_requires_server_restore' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('livo-task-planning-import'));
 IF EXISTS(SELECT 1 FROM public.task_work_events) OR EXISTS(SELECT 1 FROM public.task_work_receipts) OR EXISTS(SELECT 1 FROM public.sprint_task_history) OR EXISTS(SELECT 1 FROM public.sprint_command_receipts) THEN
  RAISE EXCEPTION 'work_history_requires_restore' USING ERRCODE='23514';
 END IF;
 RETURN public.livo_jira_clear_tasks_pre_knowledge_guard();
END $known$;
 patched_wrapper text;
BEGIN
 IF target IS NULL OR to_regclass('public.task_comment_uploads') IS NULL THEN
  RAISE EXCEPTION 'task_comment_clear_guard_missing_dependency';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
  WHERE p.oid=target AND l.lanname='plpgsql' AND NOT p.prosecdef AND NOT p.proretset
   AND p.prorettype='jsonb'::regtype AND p.proconfig=ARRAY['search_path=public'])
  OR has_function_privilege('anon',target,'EXECUTE') OR has_function_privilege('authenticated',target,'EXECUTE') THEN
  RAISE EXCEPTION 'task_comment_clear_guard_security_changed';
 END IF;
 SELECT btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\n'),proowner,proacl INTO body,original_owner,original_acl
  FROM pg_proc WHERE oid=target;
 known_wrapper:=btrim(known_wrapper,E' \t\n');
 patched_wrapper:=replace(known_wrapper,planning,planning||private_guard);
 IF body<>known_wrapper AND body<>patched_wrapper THEN RAISE EXCEPTION 'task_comment_clear_guard_unknown_wrapper'; END IF;
 -- Recognize the actual inherited delegates, never the orphaned before_knowledge alias.
 SELECT btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\n') INTO delegate_body FROM pg_proc
  WHERE oid=to_regprocedure('public.livo_jira_clear_tasks_pre_knowledge_guard()');
 IF delegate_body IS NULL OR encode(sha256(convert_to(delegate_body,'UTF8')),'hex')<>ALL(ARRAY[
  '88ca8b9a58f54fffe7d3a3a43f5a453812a5560d378e105afa93e97e3fa61798',
  'dc344c593ed8d4d25b1feb2ae6a90fa241856ec4be0b3724ebe7ebd7a898b5b5']) THEN
  RAISE EXCEPTION 'task_comment_clear_guard_unknown_delegate';
 END IF;
 SELECT btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\n') INTO delegate_body FROM pg_proc
  WHERE oid=to_regprocedure('public.livo_jira_clear_tasks_pre_release()');
 IF delegate_body IS NULL OR encode(sha256(convert_to(delegate_body,'UTF8')),'hex')<>
  'b44438c3d17e541b59d298a6928aeacbe8b2a989debb8a66f146c774e126e9af' THEN
  RAISE EXCEPTION 'task_comment_clear_guard_unknown_delegate';
 END IF;
 IF body=known_wrapper THEN
  definition:=pg_get_functiondef(target);
  IF (length(definition)-length(replace(definition,planning,'')))/length(planning)<>1
   OR (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
   RAISE EXCEPTION 'task_comment_clear_guard_anchor_changed';
  END IF;
  EXECUTE replace(definition,planning,planning||private_guard);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=target AND proowner=original_owner AND proacl IS NOT DISTINCT FROM original_acl) THEN
  RAISE EXCEPTION 'task_comment_clear_guard_identity_changed';
 END IF;
END;
$migration$;
