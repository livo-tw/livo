-- Company-wide QA display settings. State IDs and domain transitions remain fixed.
-- All authenticated callers, including administrators, save through the QA API
-- so the active-member, feature and schema checks cannot be bypassed by PostgREST.
CREATE OR REPLACE FUNCTION public.livo_guard_qa_workflow_setting()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF current_user IN ('anon','authenticated') AND
    ((TG_OP<>'DELETE' AND NEW.key='qa_workflow') OR (TG_OP<>'INSERT' AND OLD.key='qa_workflow')) THEN
    RAISE EXCEPTION 'qa_workflow_server_only' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
DROP TRIGGER IF EXISTS livo_guard_qa_workflow_setting ON public.system_settings;
CREATE TRIGGER livo_guard_qa_workflow_setting BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.livo_guard_qa_workflow_setting();

CREATE OR REPLACE FUNCTION public.livo_qa_save_workflow(p_auth_id uuid,p_workflow jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE states text[]:=ARRAY['new','triaged','in_progress','verification','closed'];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.members WHERE auth_id=p_auth_id AND is_active=true AND role::text IN ('admin','super_admin')) THEN
    RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_workflow) IS DISTINCT FROM 'object' OR p_workflow->'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(p_workflow->'order') IS DISTINCT FROM 'array' OR jsonb_typeof(p_workflow->'labels') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'qa_invalid_workflow' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_workflow))<>3 OR jsonb_array_length(p_workflow->'order')<>5
    OR (SELECT array_agg(s ORDER BY s) FROM jsonb_array_elements_text(p_workflow->'order') s)
      IS DISTINCT FROM ARRAY['closed','in_progress','new','triaged','verification']::text[]
    OR (SELECT count(*) FROM jsonb_object_keys(p_workflow->'labels'))<>5
    OR EXISTS(SELECT 1 FROM jsonb_each(p_workflow->'labels') e WHERE NOT e.key=ANY(states)
      OR jsonb_typeof(e.value)<>'string' OR length(e.value#>>'{}')>40 OR (e.value#>>'{}')~'[[:cntrl:]]')
    OR EXISTS(SELECT 1 FROM jsonb_each_text(p_workflow->'labels') e WHERE btrim(e.value)<>''
      GROUP BY lower(btrim(e.value)) HAVING count(*)>1) THEN
    RAISE EXCEPTION 'qa_invalid_workflow' USING ERRCODE='22023'; END IF;
  INSERT INTO public.system_settings(key,value,updated_at) VALUES('qa_workflow',p_workflow,now())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at;
  RETURN p_workflow;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_save_workflow(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_save_workflow(uuid,jsonb) TO service_role;
