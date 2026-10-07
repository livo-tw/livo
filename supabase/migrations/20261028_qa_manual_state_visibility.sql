-- Presentation preferences only: retain every canonical state and all existing issue data.
CREATE OR REPLACE FUNCTION public.livo_qa_manual_state_visibility_valid(p_configuration jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
BEGIN
  IF jsonb_typeof(p_configuration) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_configuration))<>2
    OR p_configuration->'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(p_configuration->'hiddenStates') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p_configuration->'hiddenStates')>8
    OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(p_configuration->'hiddenStates'))<>jsonb_array_length(p_configuration->'hiddenStates') THEN RETURN false; END IF;
  RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_configuration->'hiddenStates') AS hidden(value)
    WHERE jsonb_typeof(value)<>'string' OR value#>>'{}' NOT IN ('new','triaged','in_progress','verification','verified','failed','closed','dismissed'));
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_manual_state_visibility_valid(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_manual_state_visibility_valid(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_guard_qa_manual_state_visibility()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF NOT COALESCE((TG_OP<>'DELETE' AND NEW.key='qa_manual_state_visibility')
    OR (TG_OP<>'INSERT' AND OLD.key='qa_manual_state_visibility'),false) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-catalog:qa_manual_state_visibility'));
  IF current_user<>'service_role'
    AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
    RAISE EXCEPTION 'qa_manual_state_visibility_server_only' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND NEW.key IS DISTINCT FROM OLD.key) THEN
    RAISE EXCEPTION 'qa_manual_state_visibility_identity_immutable' USING ERRCODE='22023'; END IF;
  IF NOT public.livo_qa_manual_state_visibility_valid(NEW.value) THEN
    RAISE EXCEPTION 'qa_invalid_manual_state_visibility' USING ERRCODE='22023'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_guard_qa_manual_state_visibility() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_guard_qa_manual_state_visibility ON public.system_settings;
CREATE TRIGGER livo_guard_qa_manual_state_visibility BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.livo_guard_qa_manual_state_visibility();

CREATE OR REPLACE FUNCTION public.livo_qa_save_manual_state_visibility(p_auth_id uuid,p_configuration jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-catalog:qa_manual_state_visibility'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.members WHERE auth_id=p_auth_id AND is_active
    AND (role::text IN ('admin','super_admin') OR is_qa_admin)) THEN
    RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
  IF NOT public.livo_qa_manual_state_visibility_valid(p_configuration) THEN
    RAISE EXCEPTION 'qa_invalid_manual_state_visibility' USING ERRCODE='22023'; END IF;
  INSERT INTO public.system_settings(key,value,updated_at) VALUES('qa_manual_state_visibility',p_configuration,now())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at;
  RETURN p_configuration;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_save_manual_state_visibility(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_save_manual_state_visibility(uuid,jsonb) TO service_role;
