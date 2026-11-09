-- Internal historical QA filters need names, not external account administration.
-- This does not expand external login, project, assignment or Slack access.
CREATE OR REPLACE FUNCTION public.livo_qa_filter_people(
  p_auth_id uuid,p_project_ids text[] DEFAULT NULL,p_offset integer DEFAULT 0
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  -- Recheck the same active internal identity and QA feature gate as ordinary
  -- internal QA reads. External principals have no members row and are refused.
  PERFORM public.livo_qa_live_actor(p_auth_id);
  IF p_offset IS NULL OR p_offset<0 OR p_offset>100000 OR
    (p_project_ids IS NOT NULL AND (cardinality(p_project_ids)>1000 OR
      EXISTS(SELECT 1 FROM unnest(p_project_ids) item WHERE item IS NULL OR item !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$') OR
      cardinality(p_project_ids)<>(SELECT count(DISTINCT item) FROM unnest(p_project_ids) item))) THEN
    RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023';
  END IF;
  -- Docker's ordinary internal QA contract reads all default-workspace bugs,
  -- including archived projects. NULL means that scope; an empty array is none.
  WITH readable_projects AS (
    SELECT p.id FROM public.projects p WHERE p_project_ids IS NULL OR p.id=ANY(p_project_ids)
  ), historical_people AS (
    SELECT q.reporter_id AS id FROM public.qa_issues q JOIN readable_projects p ON p.id=q.project_id
      WHERE q.workspace_id='default'
    UNION
    SELECT q.qa_owner_id FROM public.qa_issues q JOIN readable_projects p ON p.id=q.project_id
      WHERE q.workspace_id='default'
  ), candidates AS (
    SELECT a.id,a.name,a.is_active AND EXISTS(
      SELECT 1 FROM public.external_qa_project_grants g JOIN readable_projects p ON p.id=g.project_id
      WHERE g.account_id=a.id
    ) AS is_active
    FROM public.external_qa_accounts a
    WHERE NOT EXISTS(SELECT 1 FROM public.members m WHERE m.id=a.id) AND (
      (a.is_active AND EXISTS(
        SELECT 1 FROM public.external_qa_project_grants g JOIN readable_projects p ON p.id=g.project_id
        WHERE g.account_id=a.id
      )) OR EXISTS(SELECT 1 FROM historical_people h WHERE h.id=a.id)
    )
  ), page AS (
    SELECT * FROM candidates ORDER BY lower(name),id LIMIT 101 OFFSET p_offset
  ), visible AS (
    SELECT * FROM page ORDER BY lower(name),id LIMIT 100
  )
  SELECT jsonb_build_object('members',COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'isActive',v.is_active) ORDER BY lower(v.name),v.id)
    FROM visible v
  ),'[]'::jsonb),'hasMore',(SELECT count(*)>100 FROM page)) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_filter_people(uuid,text[],integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_filter_people(uuid,text[],integer) TO service_role;
NOTIFY pgrst, 'reload schema';
