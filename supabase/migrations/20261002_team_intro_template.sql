-- Preserve the five existing answer columns; new template fields use stable keys.
ALTER TABLE public.member_manuals
  ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(custom_fields) = 'object');

-- The general settings role floor remains unchanged for other settings.
-- Guard both old and new keys so an admin cannot rename a row to bypass it.
CREATE OR REPLACE FUNCTION public.livo_team_intro_template_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $guard$
DECLARE
  protected_row boolean;
  jwt_role text;
BEGIN
  protected_row := NEW.key = 'team_intro_template';
  IF TG_OP = 'UPDATE' THEN
    protected_row := protected_row OR OLD.key = 'team_intro_template';
  END IF;
  IF NOT protected_row THEN RETURN NEW; END IF;

  jwt_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
  -- Maintenance and service-role restore keep their existing access.
  IF jwt_role = 'service_role' OR auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF public.current_member_role() IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can change the team introduction template'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS livo_team_intro_template_guard ON public.system_settings;
CREATE TRIGGER livo_team_intro_template_guard
  BEFORE INSERT OR UPDATE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.livo_team_intro_template_guard();

NOTIFY pgrst, 'reload schema';
