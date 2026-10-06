-- The retired pause controls no longer suppress automatic deadline reminders.
-- Historical preferences, command receipts and audits remain available to backup/restore.
CREATE OR REPLACE FUNCTION public.livo_task_reminder_paused(p_task text,p_member text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
  SELECT false
$$;
REVOKE ALL ON FUNCTION public.livo_task_reminder_paused(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.livo_task_reminder_paused(text,text) TO authenticated,service_role;
