-- Must sort before the released 20261109_sprint_lifecycle.sql. That migration
-- expands a real TaskWork clear guard in the outer function. Full installations
-- instead have the released knowledge -> release -> QA/TaskWork wrapper chain.
-- Add the same executable guard without replacing any inherited protection.
-- No table, history, receipt, function identity, owner or privilege is reset.
DO $migration$
DECLARE
 target regprocedure := to_regprocedure('public.livo_jira_clear_tasks()');
 definition text; body text; fingerprint text; delegate_body text;
 old_guard text := 'IF EXISTS(SELECT 1 FROM public.task_work_events) OR EXISTS(SELECT 1 FROM public.task_work_receipts) THEN';
 sprint_guard text := 'IF EXISTS(SELECT 1 FROM public.task_work_events) OR EXISTS(SELECT 1 FROM public.task_work_receipts) OR EXISTS(SELECT 1 FROM public.sprint_task_history) OR EXISTS(SELECT 1 FROM public.sprint_command_receipts) THEN';
 anchor text := 'RETURN public.livo_jira_clear_tasks_pre_knowledge_guard();';
 inserted text;
 -- Exact released 20261017 wrapper body; only CRLF and surrounding whitespace
 -- are normalized for recognition. The raw definition is patched in place.
 known_wrapper text := $known$
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
 -- Same lock knowledge-work commits hold while creating source links, so no
 -- link can appear between this check and the first child deletion.
 PERFORM generation FROM public.kb_work_clock WHERE id=1 FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.kb_source_links WHERE source_kind IN('task','task_file','qa','qa_file')) THEN
  RAISE EXCEPTION 'knowledge_requires_server_restore' USING ERRCODE='23514';
 END IF;
 RETURN public.livo_jira_clear_tasks_pre_knowledge_guard();
END $known$;
BEGIN
 IF target IS NULL THEN RAISE EXCEPTION 'sprint_clear_compat_missing_function'; END IF;
 -- CREATE OR REPLACE below preserves the OID, owner and existing ACL. Refuse
 -- unexpected security attributes rather than silently adopting a custom body.
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
  WHERE p.oid=target AND l.lanname='plpgsql' AND NOT p.prosecdef
   AND p.prorettype='jsonb'::regtype AND NOT p.proretset
   AND p.proconfig=ARRAY['search_path=public'])
  OR has_function_privilege('anon',target,'EXECUTE')
  OR has_function_privilege('authenticated',target,'EXECUTE') THEN
  RAISE EXCEPTION 'sprint_clear_compat_security_changed';
 END IF;
 SELECT btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\n') INTO body FROM pg_proc WHERE oid=target;
 fingerprint:=encode(sha256(convert_to(body,'UTF8')),'hex');
 -- Actual direct implementations from 20261011_task_work_commands and
 -- 20261012_qa_coordination, plus their released 20261109 guard expansions.
 -- These already hold planning/import before the TaskWork/history check.
 IF fingerprint=ANY(ARRAY[
  '2f638eef950d8df07c261bb685a91eae10aadb292a972c0171c0b3de966e98c6',
  'b44438c3d17e541b59d298a6928aeacbe8b2a989debb8a66f146c774e126e9af',
  'ca6149d16111d29f6cbc7beb7176ef86e7adb59ee2061a36b485c4fb72821d0f',
  '2d77f1e1582841de3c86adcfd55eb0bcd96002fc2bd77f57dd3eda2656e89216'
 ]) THEN RETURN; END IF;
 inserted:='PERFORM pg_advisory_xact_lock(hashtext(''livo-task-planning-import''));'||E'\n '
  ||old_guard||E'\n  RAISE EXCEPTION ''work_history_requires_restore'' USING ERRCODE=''23514'';\n END IF;\n '||anchor;
 known_wrapper:=btrim(replace(known_wrapper,E'\r\n',E'\n'),E' \t\n');
 IF body<>known_wrapper
  AND body<>replace(known_wrapper,anchor,inserted)
  AND body<>replace(replace(known_wrapper,anchor,inserted),old_guard,sprint_guard) THEN
  RAISE EXCEPTION 'sprint_clear_compat_unknown_wrapper';
 END IF;
 -- Preserve the real release -> QA/TaskWork path, never the orphaned
 -- livo_jira_clear_tasks_before_knowledge alias. Accept the later PT409 fix too.
 SELECT btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\n') INTO delegate_body
  FROM pg_proc WHERE oid=to_regprocedure('public.livo_jira_clear_tasks_pre_knowledge_guard()');
 IF delegate_body IS NULL OR encode(sha256(convert_to(delegate_body,'UTF8')),'hex')<>ALL(ARRAY[
  '88ca8b9a58f54fffe7d3a3a43f5a453812a5560d378e105afa93e97e3fa61798',
  'dc344c593ed8d4d25b1feb2ae6a90fa241856ec4be0b3724ebe7ebd7a898b5b5'
 ]) THEN RAISE EXCEPTION 'sprint_clear_compat_unknown_delegate'; END IF;
 SELECT btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\n') INTO delegate_body
  FROM pg_proc WHERE oid=to_regprocedure('public.livo_jira_clear_tasks_pre_release()');
 IF delegate_body IS NULL OR encode(sha256(convert_to(delegate_body,'UTF8')),'hex')<>
  'b44438c3d17e541b59d298a6928aeacbe8b2a989debb8a66f146c774e126e9af'
 THEN RAISE EXCEPTION 'sprint_clear_compat_unknown_delegate'; END IF;
 IF body=known_wrapper THEN
  definition:=pg_get_functiondef(target);
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
   RAISE EXCEPTION 'sprint_clear_compat_anchor_changed';
  END IF;
  -- The common planning/import lock precedes the new check. It serializes even
  -- an empty Sprint command/receipt with clear, before the delegate takes it.
  EXECUTE replace(definition,anchor,inserted);
 END IF;
END $migration$;
