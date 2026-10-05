-- Who may delete tasks and bugs (team decision, 2026-10).
--
-- Tasks: admins delete any task, as before. Any other member may now delete a task
-- they created that nobody has picked up yet: never started, not completed and still
-- in the first open column (the lowest sort order among statuses that are not done).
-- The app (canDeleteTaskRecord in src/lib/permissions.ts) and the cloud server
-- (worker/src/db.ts) use the same rule.
--
-- Bugs: there was no way to delete one. livo_qa_delete removes a bug with its
-- comments, history, attachment rows, uploads, Slack links, receipts and in-app
-- notifications, and records who deleted it in the activity log. Admins and QA
-- admins delete any bug; the reporter deletes their own while it is still new
-- (canQaDelete in src/lib/qa/domain.ts). The qa edge function calls it with the
-- service role and then removes the stored files from the qa-evidence bucket.
--
-- Repeatable: the policy is dropped and created again, the function is CREATE OR
-- REPLACE; no row is changed by this file.

DROP POLICY IF EXISTS pf_tasks_delete ON public.tasks;
CREATE POLICY pf_tasks_delete ON public.tasks FOR DELETE TO authenticated USING (
  public.is_livo_admin()
  OR (creator_id = public.current_member_id()
    AND started_at IS NULL AND completed_at IS NULL
    AND status_id IN (SELECT s.id FROM public.statuses s WHERE NOT s.is_done
      AND s.sort_order = (SELECT min(f.sort_order) FROM public.statuses f WHERE NOT f.is_done)))
);

-- The bug a notification points at; NULL when the text is not JSON (older or foreign rows).
CREATE OR REPLACE FUNCTION public.livo_qa_notification_issue(p_content text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
BEGIN
  RETURN p_content::jsonb->>'issueId';
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_notification_issue(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_notification_issue(text) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_delete(p_auth_id uuid,p_issue_id text,p_expected_version integer,p_identity jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor text; actor_member public.members%ROWTYPE; existing public.qa_issues%ROWTYPE; paths jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  actor:=public.livo_qa_live_actor(p_auth_id,p_identity);
  IF actor IS NULL THEN RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
  SELECT * INTO actor_member FROM public.members WHERE id=actor;
  SELECT * INTO existing FROM public.qa_issues WHERE id=p_issue_id AND workspace_id='default' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'issue_not_found' USING ERRCODE='P0002'; END IF;
  IF p_expected_version IS NULL OR existing.version<>p_expected_version THEN
    RAISE EXCEPTION 'qa_version_conflict' USING ERRCODE='PT409'; END IF;
  IF NOT (actor_member.role::text IN ('admin','super_admin') OR actor_member.is_qa_admin IS TRUE
    OR (existing.reporter_id=actor AND existing.state='new')) THEN
    RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(jsonb_agg(DISTINCT s.path),'[]'::jsonb) INTO paths FROM (
    SELECT storage_path AS path FROM public.qa_attachments WHERE issue_id=p_issue_id AND workspace_id='default'
    UNION SELECT storage_path FROM public.qa_uploads WHERE issue_id=p_issue_id AND workspace_id='default') s;
  INSERT INTO public.activity_logs(user_id,action,target_type,task_id,task_key,detail)
    VALUES(actor,'delete_qa_issue','qa',p_issue_id,'#'||right(p_issue_id,8),existing.title);
  DELETE FROM public.qa_slack_links WHERE issue_id=p_issue_id AND workspace_id='default';
  DELETE FROM public.qa_attachments WHERE issue_id=p_issue_id AND workspace_id='default';
  DELETE FROM public.qa_uploads WHERE issue_id=p_issue_id AND workspace_id='default';
  DELETE FROM public.qa_comments WHERE issue_id=p_issue_id AND workspace_id='default';
  DELETE FROM public.qa_events WHERE issue_id=p_issue_id AND workspace_id='default';
  DELETE FROM public.qa_commands WHERE issue_id=p_issue_id AND workspace_id='default';
  -- Bug notifications are JSON written by livo_qa_commit; anything else is left alone.
  DELETE FROM public.notifications WHERE type='qa_update' AND position(p_issue_id in content)>0
    AND public.livo_qa_notification_issue(content)=p_issue_id;
  DELETE FROM public.qa_issues WHERE id=p_issue_id AND workspace_id='default';
  RETURN jsonb_build_object('id',p_issue_id,'deleted',true,'paths',paths);
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_delete(uuid,text,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_delete(uuid,text,integer,jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
