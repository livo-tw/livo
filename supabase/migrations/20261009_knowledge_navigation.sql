-- Per-member navigation never mutates page structure, revisions or permissions.
CREATE TABLE IF NOT EXISTS public.kb_navigation_preferences (
  workspace_id text NOT NULL DEFAULT 'default',
  member_id text NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL DEFAULT '{"items":{},"orders":{},"pins":[]}'::jsonb,
  version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,member_id)
);
ALTER TABLE public.kb_navigation_preferences ENABLE ROW LEVEL SECURITY;
-- Raw preferences may contain dormant IDs. Only the filtered RPC returns them.
REVOKE ALL ON public.kb_navigation_preferences FROM anon,authenticated;
DROP POLICY IF EXISTS kb_navigation_owner ON public.kb_navigation_preferences;
CREATE POLICY kb_navigation_owner ON public.kb_navigation_preferences TO authenticated
  USING (workspace_id='default' AND member_id=public.current_member_id())
  WITH CHECK (workspace_id='default' AND member_id=public.current_member_id());

CREATE OR REPLACE FUNCTION public.kb_navigation_scope(project text,parent text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public AS $$
  SELECT '['||coalesce(to_json(project)::text,'null')||','||coalesce(to_json(parent)::text,'null')||']'
$$;

CREATE OR REPLACE FUNCTION public.kb_preferences(
  p_action text DEFAULT 'read',p_page_id text DEFAULT NULL,p_value boolean DEFAULT NULL,
  p_before_id text DEFAULT NULL,p_order_kind text DEFAULT 'tree',p_version integer DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor text:=public.current_member_id(); prefs jsonb; rev integer; item jsonb;
  page public.kb_pages%ROWTYPE; target public.kb_pages%ROWTYPE; scope text; ordered jsonb;
  siblings text[]; stored jsonb; result_items jsonb:='{}'; result_orders jsonb:='{}'; result_pins jsonb;
  entry record; ids jsonb; pins boolean:=p_order_kind='pins'; new_order jsonb:='[]'; inserted boolean:=false; pid text;
BEGIN
  IF actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.members WHERE id=actor AND is_active=true) THEN
    RAISE EXCEPTION 'kb_forbidden' USING ERRCODE='42501';
  END IF;
  IF p_action NOT IN ('read','favorite','pin','collapse','reorder','reset') OR p_order_kind NOT IN ('tree','pins') THEN
    RAISE EXCEPTION 'kb_invalid_request';
  END IF;
  IF p_action!='read' THEN
    IF p_page_id IN ('__proto__','constructor','prototype') OR NOT coalesce(public.kb_has_permission(p_page_id,'view'),false) THEN RAISE EXCEPTION 'kb_forbidden' USING ERRCODE='42501'; END IF;
    INSERT INTO public.kb_navigation_preferences(member_id) VALUES(actor) ON CONFLICT DO NOTHING;
  END IF;
  SELECT preferences,version INTO prefs,rev FROM public.kb_navigation_preferences WHERE workspace_id='default' AND member_id=actor FOR UPDATE;
  prefs:=coalesce(prefs,'{"items":{},"orders":{},"pins":[]}'::jsonb); rev:=coalesce(rev,0);
  IF p_action!='read' THEN
    IF p_version IS NULL OR p_version!=rev THEN RAISE EXCEPTION 'kb_conflict' USING ERRCODE='40001'; END IF;
    SELECT * INTO page FROM public.kb_pages WHERE id=p_page_id;
    IF p_action IN ('favorite','pin','collapse') THEN
      IF p_value IS NULL THEN RAISE EXCEPTION 'kb_invalid_request'; END IF;
      item:=coalesce(prefs->'items'->p_page_id,'{"favorite":false,"pinned":false}'::jsonb);
      IF p_action='favorite' THEN item:=item||jsonb_build_object('favorite',p_value); IF NOT p_value THEN item:=item||'{"pinned":false}'::jsonb; END IF;
      ELSIF p_action='pin' THEN item:=item||jsonb_build_object('pinned',p_value); IF p_value THEN item:=item||'{"favorite":true}'::jsonb; END IF;
      ELSE item:=item||jsonb_build_object('collapsed',p_value); END IF;
      prefs:=jsonb_set(prefs,ARRAY['items',p_page_id],item,true);
      IF coalesce((item->>'pinned')::boolean,false) THEN
        IF NOT prefs->'pins' ? p_page_id THEN prefs:=jsonb_set(prefs,'{pins}',(prefs->'pins')||to_jsonb(p_page_id)); END IF;
      ELSE
        SELECT coalesce(jsonb_agg(v ORDER BY n),'[]'::jsonb) INTO ordered FROM jsonb_array_elements_text(prefs->'pins') WITH ORDINALITY x(v,n) WHERE v!=p_page_id;
        prefs:=jsonb_set(prefs,'{pins}',ordered);
      END IF;
    ELSE
      scope:=public.kb_navigation_scope(page.project_id,page.parent_id);
      stored:=CASE WHEN pins THEN prefs->'pins' ELSE coalesce(prefs->'orders'->scope,'[]') END;
      SELECT coalesce(array_agg(p.id ORDER BY coalesce((SELECT n FROM jsonb_array_elements_text(stored) WITH ORDINALITY x(v,n) WHERE v=p.id LIMIT 1),2147483647),p.sort_order,p.title,p.id),ARRAY[]::text[]) INTO siblings
        FROM public.kb_pages p WHERE public.kb_has_permission(p.id,'view') AND
        CASE WHEN pins THEN coalesce((prefs->'items'->p.id->>'pinned')::boolean,false)
        ELSE p.project_id IS NOT DISTINCT FROM page.project_id AND p.parent_id IS NOT DISTINCT FROM page.parent_id END;
      IF NOT p_page_id=ANY(siblings) THEN RAISE EXCEPTION 'kb_invalid_request'; END IF;
      IF p_action='reset' THEN
        IF pins THEN prefs:=jsonb_set(prefs,'{pins}',to_jsonb(siblings)); ELSE prefs:=jsonb_set(prefs,'{orders}',(prefs->'orders')-scope); END IF;
      ELSE
        IF p_before_id IS NOT NULL AND (p_before_id=p_page_id OR NOT p_before_id=ANY(siblings)) THEN RAISE EXCEPTION 'kb_invalid_request'; END IF;
        FOREACH pid IN ARRAY siblings LOOP
          IF pid=p_page_id THEN CONTINUE; END IF;
          IF pid=p_before_id THEN new_order:=new_order||to_jsonb(p_page_id); inserted:=true; END IF;
          new_order:=new_order||to_jsonb(pid);
        END LOOP;
        IF NOT inserted THEN new_order:=new_order||to_jsonb(p_page_id); END IF;
        -- Keep dormant IDs internally; the response below never exposes them.
        FOR pid IN SELECT value FROM jsonb_array_elements_text(stored) WHERE NOT value=ANY(siblings) LOOP new_order:=new_order||to_jsonb(pid); END LOOP;
        IF pins THEN prefs:=jsonb_set(prefs,'{pins}',new_order); ELSE prefs:=jsonb_set(prefs,ARRAY['orders',scope],new_order,true); END IF;
      END IF;
    END IF;
    rev:=rev+1;
    UPDATE public.kb_navigation_preferences SET preferences=prefs,version=rev,updated_at=now() WHERE workspace_id='default' AND member_id=actor;
  END IF;
  FOR entry IN SELECT key,value FROM jsonb_each(prefs->'items') LOOP
    IF public.kb_has_permission(entry.key,'view') THEN result_items:=result_items||jsonb_build_object(entry.key,entry.value); END IF;
  END LOOP;
  FOR entry IN SELECT key,value FROM jsonb_each(prefs->'orders') LOOP
    SELECT coalesce(jsonb_agg(x.v ORDER BY x.n),'[]') INTO ids FROM jsonb_array_elements_text(entry.value) WITH ORDINALITY x(v,n)
      JOIN public.kb_pages p ON p.id=x.v WHERE public.kb_has_permission(p.id,'view') AND public.kb_navigation_scope(p.project_id,p.parent_id)=entry.key;
    IF jsonb_array_length(ids)>0 THEN result_orders:=result_orders||jsonb_build_object(entry.key,ids); END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(v ORDER BY n),'[]') INTO result_pins FROM jsonb_array_elements_text(prefs->'pins') WITH ORDINALITY x(v,n)
    WHERE public.kb_has_permission(v,'view') AND coalesce((result_items->v->>'pinned')::boolean,false);
  RETURN jsonb_build_object('version',rev,'items',result_items,'orders',result_orders,'pins',result_pins);
END $$;
REVOKE ALL ON FUNCTION public.kb_navigation_scope(text,text),public.kb_preferences(text,text,boolean,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kb_preferences(text,text,boolean,text,text,integer) TO authenticated;
