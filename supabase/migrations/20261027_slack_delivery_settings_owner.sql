-- Slack delivery settings (system_settings key 'slack_delivery': channel routes,
-- bug routes, personal messages and who gets them) are managed by super_admins
-- only, like every service integration. The permission floor lets admins write
-- any system_settings row, so this guard narrows that one key. The delivery
-- service never writes it; SQL maintenance as a superuser still can.
-- Also refuses a malformed personal-message setting: dmEnabled must be a boolean
-- and dmMemberIds an array of member ids, or the triggers would silently treat
-- every member as not allowed.
-- Repeatable: functions are replaced and the trigger is created or replaced; no row changes.
CREATE OR REPLACE FUNCTION public.livo_guard_slack_delivery_setting()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE protected_row boolean;
BEGIN
  protected_row:=(TG_OP<>'DELETE' AND NEW.key='slack_delivery')
    OR (TG_OP<>'INSERT' AND OLD.key='slack_delivery');
  IF NOT COALESCE(protected_row,false) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  -- A missing JWT is never an authorization bypass: only the service DB role
  -- or a superuser maintenance session may write without a member.
  IF current_user<>'service_role'
    AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT (current_user='authenticated' AND EXISTS(
      SELECT 1 FROM public.members WHERE id=public.current_member_id()
        AND auth_id=auth.uid() AND is_active=true AND role::text='super_admin'
    )) THEN
    RAISE EXCEPTION 'slack_delivery_settings_forbidden' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND OLD.key='slack_delivery' AND NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'slack_delivery_setting_key_immutable' USING ERRCODE='22023';
  END IF;
  IF NEW.key='slack_delivery' AND (
    jsonb_typeof(NEW.value) IS DISTINCT FROM 'object'
    OR (NEW.value ? 'dmEnabled' AND jsonb_typeof(NEW.value->'dmEnabled')<>'boolean')
    OR (NEW.value ? 'dmMemberIds' AND CASE WHEN jsonb_typeof(NEW.value->'dmMemberIds')<>'array' THEN true
      ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.value->'dmMemberIds') e WHERE jsonb_typeof(e)<>'string') END)
  ) THEN
    RAISE EXCEPTION 'invalid_slack_delivery_settings' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_guard_slack_delivery_setting() FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE TRIGGER livo_guard_slack_delivery_setting BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.livo_guard_slack_delivery_setting();
