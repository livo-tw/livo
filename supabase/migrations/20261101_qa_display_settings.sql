-- Workspace presentation only: retain severity/priority values, all states and audit data.
CREATE OR REPLACE FUNCTION public.livo_qa_display_settings_valid(p_configuration jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
BEGIN
  IF jsonb_typeof(p_configuration) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_configuration))<>4
    OR p_configuration->'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(p_configuration->'showSeverity') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_configuration->'hiddenPriorityChoices') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_configuration->'hiddenBoardStates') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p_configuration->'hiddenPriorityChoices')>4
    OR jsonb_array_length(p_configuration->'hiddenBoardStates')>7
    OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(p_configuration->'hiddenPriorityChoices'))<>jsonb_array_length(p_configuration->'hiddenPriorityChoices')
    OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(p_configuration->'hiddenBoardStates'))<>jsonb_array_length(p_configuration->'hiddenBoardStates') THEN RETURN false; END IF;
  RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_configuration->'hiddenPriorityChoices') AS hidden(value)
    WHERE jsonb_typeof(value)<>'number' OR value NOT IN ('1'::jsonb,'2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb))
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_configuration->'hiddenBoardStates') AS hidden(value)
      WHERE jsonb_typeof(value)<>'string' OR value#>>'{}' NOT IN ('new','triaged','in_progress','verification','verified','failed','closed','dismissed'));
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_display_settings_valid(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_display_settings_valid(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_guard_qa_display_settings()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF NOT COALESCE((TG_OP<>'DELETE' AND NEW.key='qa_display_settings')
    OR (TG_OP<>'INSERT' AND OLD.key='qa_display_settings'),false) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-catalog:qa_display_settings'));
  IF current_user<>'service_role'
    AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
    RAISE EXCEPTION 'qa_display_settings_server_only' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND NEW.key IS DISTINCT FROM OLD.key) THEN
    RAISE EXCEPTION 'qa_display_settings_identity_immutable' USING ERRCODE='22023'; END IF;
  IF NOT public.livo_qa_display_settings_valid(NEW.value) THEN
    RAISE EXCEPTION 'qa_invalid_display_settings' USING ERRCODE='22023'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_guard_qa_display_settings() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_guard_qa_display_settings ON public.system_settings;
CREATE TRIGGER livo_guard_qa_display_settings BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.livo_guard_qa_display_settings();

CREATE OR REPLACE FUNCTION public.livo_qa_save_display_settings(p_auth_id uuid,p_configuration jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor public.members;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-catalog:qa_display_settings'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  SELECT * INTO actor FROM public.members WHERE auth_id=p_auth_id AND is_active AND role::text='super_admin' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
  IF NOT public.livo_qa_display_settings_valid(p_configuration) THEN
    RAISE EXCEPTION 'qa_invalid_display_settings' USING ERRCODE='22023'; END IF;
  INSERT INTO public.system_settings(key,value,updated_at) VALUES('qa_display_settings',p_configuration,now())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at;
  RETURN p_configuration;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_save_display_settings(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_save_display_settings(uuid,jsonb) TO service_role;
