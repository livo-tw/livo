-- Certify new manual identity mappings without elevating legacy admin bindings.
ALTER TABLE public.external_account_bindings ADD COLUMN IF NOT EXISTS verified_by_member_id text;

CREATE OR REPLACE FUNCTION public.kb_slack_search(p_query text, p_page integer DEFAULT 0, p_category text DEFAULT 'all')
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE query_text text := btrim(p_query); page_number integer := greatest(0,least(COALESCE(p_page,0),10000));
  rows_json jsonb;
BEGIN
  IF query_text IS NULL OR length(query_text)=0 OR length(query_text)>100 THEN
    RAISE EXCEPTION 'knowledge_search_invalid' USING ERRCODE='22023';
  END IF;
  IF NOT public.livo_slack_enabled() OR NOT public.livo_slack_session() OR NOT EXISTS (
    SELECT 1 FROM public.external_account_bindings b
    WHERE b.id::text=auth.jwt()->>'livo_slack_binding' AND b.is_verified AND b.platform='slack'
      AND b.member_id=public.current_member_id()
      AND (b.verified_by='email' OR (b.verified_by='admin' AND EXISTS (
        SELECT 1 FROM public.members issuer WHERE issuer.id::text=b.verified_by_member_id
          AND issuer.role='super_admin' AND issuer.is_active)))) THEN
    RAISE EXCEPTION 'knowledge_search_forbidden' USING ERRCODE='42501';
  END IF;
  -- SECURITY INVOKER preserves current member RLS, including ancestor ACLs.
  SELECT COALESCE(jsonb_agg(to_jsonb(hit)), '[]'::jsonb) INTO rows_json FROM (
    SELECT p.id,p.title,p.category,p.project_id,p.updated_at,p.version,project.name AS project_name
    FROM public.kb_pages p LEFT JOIN public.projects project ON project.id=p.project_id
    WHERE NOT p.is_archived AND (p_category NOT IN ('general','meeting') OR p.category=p_category)
      AND (strpos(lower(p.title),lower(query_text))>0 OR strpos(lower(p.body),lower(query_text))>0)
    ORDER BY CASE WHEN strpos(lower(p.title),lower(query_text))>0 THEN 0 ELSE 1 END,
      p.updated_at DESC,p.id LIMIT 6 OFFSET page_number*5
  ) hit;
  RETURN jsonb_build_object('pages',(SELECT COALESCE(jsonb_agg(value),'[]'::jsonb)
    FROM jsonb_array_elements(rows_json) WITH ORDINALITY AS items(value,n) WHERE n<=5),
    'hasMore',jsonb_array_length(rows_json)>5,'page',page_number);
END;
$$;
REVOKE ALL ON FUNCTION public.kb_slack_search(text,integer,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.kb_slack_search(text,integer,text) TO authenticated;
NOTIFY pgrst, 'reload schema';
