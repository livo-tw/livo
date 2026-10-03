-- QA configuration management is a scoped capability, not a global role.
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS is_qa_admin boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.livo_guard_qa_admin_capability()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF (TG_OP='INSERT' AND NOT NEW.is_qa_admin)
    OR (TG_OP='UPDATE' AND NEW.is_qa_admin IS NOT DISTINCT FROM OLD.is_qa_admin) THEN RETURN NEW; END IF;
  -- Check the actual database role; an authenticated caller cannot forge a
  -- service-role JWT claim or use a missing subject to bypass this guard.
  IF current_user='service_role'
    OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RETURN NEW; END IF;
  IF current_user='authenticated' AND EXISTS(
    SELECT 1 FROM public.members WHERE auth_id=auth.uid() AND is_active AND role::text='super_admin'
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'qa_admin_assignment_forbidden' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION public.livo_guard_qa_admin_capability() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_guard_qa_admin_capability ON public.members;
CREATE TRIGGER livo_guard_qa_admin_capability BEFORE INSERT OR UPDATE ON public.members
FOR EACH ROW EXECUTE FUNCTION public.livo_guard_qa_admin_capability();

NOTIFY pgrst, 'reload schema';
