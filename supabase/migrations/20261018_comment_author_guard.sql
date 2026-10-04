-- Comments are shown in the name of user_id, and livo_slack_capture_comments
-- (20261003/20261004) posts new comments to the project's Slack channel under that
-- name. The permission floor left client INSERT open to any user_id, so a member
-- could post a comment, and a Slack channel message, as the super admin.
--
-- Same rule as notifications (20261017_notification_sender_guard.sql):
--   * a client comments only as itself (every web-app insert already does:
--     useTaskComments.ts sends the signed-in member's id);
--   * super_admin keeps restoring historical rows (JSON backup restore);
--   * nobody but super_admin re-attributes an existing comment to someone else.
-- Edge Functions (service_role, e.g. Slack replies and Jira import) and SECURITY
-- DEFINER commands are not affected.
-- Repeatable: DROP ... IF EXISTS before CREATE; no row is touched.
DROP POLICY IF EXISTS "pf_comments_insert" ON public.comments;
CREATE POLICY "pf_comments_insert" ON public.comments
  FOR INSERT TO authenticated
  WITH CHECK (user_id = public.current_member_id() OR public.is_livo_super());

CREATE OR REPLACE FUNCTION public.livo_comment_author_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     AND current_user IN ('authenticated', 'anon')
     AND NOT public.is_livo_super() THEN
    RAISE EXCEPTION 'comment_author_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS livo_comment_author_guard ON public.comments;
CREATE TRIGGER livo_comment_author_guard BEFORE UPDATE OF user_id ON public.comments
  FOR EACH ROW EXECUTE FUNCTION public.livo_comment_author_guard();
