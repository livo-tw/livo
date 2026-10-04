-- Notifications are shown, e-mailed and (livo_slack_capture_delivery, 20261004)
-- sent as Slack DMs in the name of sender_id. The permission floor left client
-- INSERT as WITH CHECK (true), so any member could make a notification, and a
-- Slack DM, appear to come from the super admin or anyone else.
--
-- Client inserts must now name the caller as sender. Every web-app insert already
-- does (createNotification callers, due-soon and auto-report reminders). Two narrow
-- exceptions keep existing flows working:
--   * super_admin: the JSON backup restore re-inserts historical rows as they were;
--   * a signed-in account with no member row may raise the self-addressed
--     'system' alert to a super admin ("unknown account tried to sign in",
--     useAuthState.ts). Self-addressed rows never create a Slack DM, and the
--     'system' type is never e-mailed.
-- Edge Functions (service_role) and SECURITY DEFINER commands bypass RLS as before.
-- Repeatable: DROP POLICY IF EXISTS before CREATE POLICY; no row is touched.
DROP POLICY IF EXISTS "notifications_insert" ON public.notifications;
DROP POLICY IF EXISTS "pf_notifications_insert" ON public.notifications;
CREATE POLICY "pf_notifications_insert" ON public.notifications
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = public.current_member_id()
    OR public.is_livo_super()
    OR (
      public.current_member_id() IS NULL
      AND type = 'system'
      AND sender_id = recipient_id
      AND EXISTS (SELECT 1 FROM public.members m WHERE m.id = recipient_id AND m.role::text = 'super_admin')
    )
  );
