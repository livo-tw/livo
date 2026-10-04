-- A recipient may mark a notification read, but not re-address it or change who
-- it is from (sender_id drives the inbox name, e-mail and Slack DM). The insert
-- rule is 20261017_notification_sender_guard.sql; this closes the update path, as
-- the Cloud Worker already does (worker/src/db.ts). The web app only ever updates
-- is_read. super_admin is exempt for the JSON backup restore, and Edge Functions
-- (service_role) and SECURITY DEFINER commands are not affected.
-- Repeatable: CREATE OR REPLACE and DROP TRIGGER IF EXISTS before CREATE; no row is touched.
CREATE OR REPLACE FUNCTION public.livo_notification_identity_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF (NEW.sender_id IS DISTINCT FROM OLD.sender_id OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id)
     AND current_user IN ('authenticated', 'anon')
     AND NOT public.is_livo_super() THEN
    RAISE EXCEPTION 'notification_identity_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS livo_notification_identity_guard ON public.notifications;
CREATE TRIGGER livo_notification_identity_guard BEFORE UPDATE OF sender_id, recipient_id ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.livo_notification_identity_guard();
