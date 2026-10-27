-- Keep ordinary inboxes private, while preserving the existing super-admin
-- complete JSON backup and service-role server backup. No write policy changes.
-- A RESTRICTIVE SELECT policy intersects every permissive/legacy read policy.
DROP POLICY IF EXISTS livo_notification_recipient_read ON public.notifications;
CREATE POLICY livo_notification_recipient_read ON public.notifications
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (recipient_id = public.current_member_id() OR public.is_livo_super());
