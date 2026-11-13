-- Display order only. Keep the existing caller, project, active/history and
-- external-account eligibility rules; no member records or grants are changed.
CREATE OR REPLACE FUNCTION public.livo_qa_member_display_page(
  p_auth_id uuid,p_project_id text,p_search text DEFAULT '',p_offset integer DEFAULT 0
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.livo_qa_live_actor(p_auth_id);
  IF p_project_id IS NULL OR p_project_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$'
    OR p_offset IS NULL OR p_offset<0 OR p_offset>100000 OR length(COALESCE(p_search,''))>100 THEN
    RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.projects p WHERE p.id=p_project_id AND NOT p.is_archived) THEN
    RAISE EXCEPTION 'qa_project_unavailable' USING ERRCODE='P0002';
  END IF;
  WITH page AS (
    SELECT m.id,m.name,COALESCE(m.sort_order,99) AS display_sort_order
    FROM public.members m WHERE m.is_active
      AND strpos(lower(m.name),lower(COALESCE(p_search,'')))>0
    ORDER BY COALESCE(m.sort_order,99),m.id LIMIT 101 OFFSET p_offset
  ), visible AS (SELECT * FROM page ORDER BY display_sort_order,id LIMIT 100)
  SELECT jsonb_build_object('members',COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,
      'sortOrder',v.display_sort_order,'isExternal',false) ORDER BY v.display_sort_order,v.id)
    FROM visible v
  ),'[]'::jsonb),'hasMore',(SELECT count(*)>100 FROM page)) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_member_display_page(uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_member_display_page(uuid,text,text,integer) TO service_role;

-- Preserve the released external_read function's signature/OID/owner/ACL and
-- every authorization predicate. Only its already-authorized roster projections
-- gain display metadata and a total order before pagination. Never infer an
-- identity kind from an opaque id or expose Email/login/private-project data.
DO $migration$
DECLARE definition text; old_fragment text; new_fragment text;
BEGIN
  SELECT pg_get_functiondef('public.livo_qa_external_read(uuid,text,jsonb)'::regprocedure) INTO definition;
  IF position('qa_member_display_order_v1' in definition)>0 THEN RETURN; END IF;
  -- Released Windows packages retain CRLF in prosrc. Match the same SQL body
  -- independently of its line endings without changing the released files.
  definition := replace(definition,E'\r\n',E'\n');
  old_fragment := 'SELECT DISTINCT ON (r.id) r.*';
  new_fragment := 'SELECT DISTINCT ON (r.id) r.*,m.sort_order AS display_sort_order,m.id IS NULL AS display_is_external';
  IF position(old_fragment in definition)=0 THEN RAISE EXCEPTION 'qa_member_order_unknown_profile_projection'; END IF;
  definition := replace(definition,old_fragment,new_fragment);
  old_fragment := 'CROSS JOIN LATERAL public.livo_qa_external_roster(g.id) r';
  IF position(old_fragment in definition)=0 THEN RAISE EXCEPTION 'qa_member_order_unknown_profile_roster'; END IF;
  definition := replace(definition,old_fragment,old_fragment||E'\n      LEFT JOIN public.members m ON m.id=r.id');
  old_fragment := E'WITH page AS (\n        SELECT r.*\n        FROM public.livo_qa_external_roster(selected_project_id) r';
  new_fragment := E'WITH page AS (\n        SELECT r.*,m.sort_order AS display_sort_order,m.id IS NULL AS display_is_external\n        FROM public.livo_qa_external_roster(selected_project_id) r\n        LEFT JOIN public.members m ON m.id=r.id';
  IF position(old_fragment in definition)=0 THEN RAISE EXCEPTION 'qa_member_order_unknown_page_projection'; END IF;
  definition := replace(definition,old_fragment,new_fragment);
  old_fragment := 'ORDER BY r.name,r.id LIMIT 101 OFFSET page_offset';
  new_fragment := 'ORDER BY (m.id IS NULL),CASE WHEN m.id IS NOT NULL THEN COALESCE(m.sort_order,99) END,CASE WHEN m.id IS NULL THEN lower(r.name) END,r.id LIMIT 101 OFFSET page_offset';
  IF position(old_fragment in definition)=0 THEN RAISE EXCEPTION 'qa_member_order_unknown_page_order'; END IF;
  definition := replace(definition,old_fragment,new_fragment);
  old_fragment := 'SELECT * FROM page ORDER BY name,id LIMIT 100';
  new_fragment := 'SELECT * FROM page ORDER BY display_is_external,CASE WHEN NOT display_is_external THEN COALESCE(display_sort_order,99) END,CASE WHEN display_is_external THEN lower(name) END,id LIMIT 100';
  IF position(old_fragment in definition)=0 THEN RAISE EXCEPTION 'qa_member_order_unknown_visible_order'; END IF;
  definition := replace(definition,old_fragment,new_fragment);
  old_fragment := '''jobTitle'',r.job_title,''isActive'',r.is_active) ORDER BY r.name,r.id)';
  new_fragment := '''jobTitle'',r.job_title,''isActive'',r.is_active,''isExternal'',r.display_is_external) || CASE WHEN r.display_is_external THEN ''{}''::jsonb ELSE jsonb_build_object(''sortOrder'',COALESCE(r.display_sort_order,99)) END ORDER BY r.display_is_external,CASE WHEN NOT r.display_is_external THEN COALESCE(r.display_sort_order,99) END,CASE WHEN r.display_is_external THEN lower(r.name) END,r.id)';
  IF (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>2 THEN
    RAISE EXCEPTION 'qa_member_order_unknown_roster_output';
  END IF;
  definition := replace(definition,old_fragment,new_fragment);
  -- The marker is part of the function body, so reapplying the migration does
  -- not repeat joins or rewrite a function already updated by this migration.
  definition := regexp_replace(definition,E'BEGIN\n',E'BEGIN\n  -- qa_member_display_order_v1\n');
  EXECUTE definition;
END $migration$;
NOTIFY pgrst, 'reload schema';
