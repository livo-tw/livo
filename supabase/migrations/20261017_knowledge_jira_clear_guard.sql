-- Restore the knowledge-source guard on the destructive Jira clear.
--
-- 20261012_knowledge_work.sql renamed the clear function to
-- livo_jira_clear_tasks_before_knowledge and wrapped it with a kb_source_links
-- check. 20261012_qa_coordination.sql sorts later and CREATE OR REPLACEs the
-- whole clear body, which silently discarded that wrapper;
-- 20261013_release_workspace.sql then wrapped the QA body
-- (livo_jira_clear_tasks -> livo_jira_clear_tasks_pre_release). The knowledge
-- check was no longer on the call path, so a task/QA-sourced knowledge link did
-- not stop the clear.
--
-- Wrap whatever the current outer function is (the release wrapper on every
-- install that reached this file). The rename happens only once, so applying
-- this file again replaces this wrapper in place and never wraps it twice.
-- The orphaned livo_jira_clear_tasks_before_knowledge stays untouched.
DO $$ BEGIN
 IF to_regprocedure('public.livo_jira_clear_tasks_pre_knowledge_guard()') IS NULL THEN
  IF to_regprocedure('public.livo_jira_clear_tasks()') IS NULL THEN
   RAISE EXCEPTION 'livo_jira_clear_tasks() is missing; apply the earlier migrations first';
  END IF;
  ALTER FUNCTION public.livo_jira_clear_tasks() RENAME TO livo_jira_clear_tasks_pre_knowledge_guard;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.livo_jira_clear_tasks() RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'knowledge_forbidden' USING ERRCODE='42501'; END IF;
 -- Same lock knowledge-work commits hold while creating source links, so no
 -- link can appear between this check and the first child deletion.
 PERFORM generation FROM public.kb_work_clock WHERE id=1 FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.kb_source_links WHERE source_kind IN('task','task_file','qa','qa_file')) THEN
  RAISE EXCEPTION 'knowledge_requires_server_restore' USING ERRCODE='23514';
 END IF;
 RETURN public.livo_jira_clear_tasks_pre_knowledge_guard();
END $$;
REVOKE ALL ON FUNCTION public.livo_jira_clear_tasks(),public.livo_jira_clear_tasks_pre_knowledge_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_jira_clear_tasks(),public.livo_jira_clear_tasks_pre_knowledge_guard() TO service_role;
