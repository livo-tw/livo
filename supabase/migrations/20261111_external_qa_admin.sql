-- Only a live internal super_admin may administer external QA accounts.
ALTER TABLE public.external_qa_accounts ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS public.external_qa_admin_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id text NOT NULL,
  actor_id text NOT NULL,
  before_state jsonb,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.external_qa_admin_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.external_qa_admin_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.livo_external_qa_admin(
  p_admin_auth uuid, p_action text, p_account_id text DEFAULT NULL,
  p_auth_id uuid DEFAULT NULL, p_name text DEFAULT NULL, p_email text DEFAULT NULL,
  p_active boolean DEFAULT NULL, p_project_ids text[] DEFAULT NULL, p_revision integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  admin_id text;
  account public.external_qa_accounts%ROWTYPE;
  normalized_email text := lower(btrim(p_email));
  granted text[];
  before_state jsonb;
  after_state jsonb;
BEGIN
  SELECT m.id INTO admin_id FROM public.members m
  WHERE m.auth_id=p_admin_auth AND m.is_active AND m.role::text='super_admin' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'external_qa_forbidden' USING ERRCODE='42501'; END IF;

  IF p_action='list' THEN
    RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',a.id,'name',a.name,'email',u.email,'isActive',a.is_active,'revision',a.revision,
      'projectIds',ARRAY(SELECT g.project_id FROM public.external_qa_project_grants g WHERE g.account_id=a.id ORDER BY g.project_id)
    ) ORDER BY lower(a.name),a.id)
    FROM public.external_qa_accounts a LEFT JOIN auth.users u ON u.id=a.auth_id),'[]'::jsonb);
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('prepare','create','update') OR p_project_ids IS NULL
    OR cardinality(p_project_ids)>500 OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200
    OR p_active IS NULL THEN
    RAISE EXCEPTION 'external_qa_invalid' USING ERRCODE='22023';
  END IF;
  IF p_action='update' THEN
    SELECT * INTO account FROM public.external_qa_accounts a WHERE a.id=p_account_id FOR UPDATE;
    IF NOT FOUND OR account.revision IS DISTINCT FROM p_revision THEN
      RAISE EXCEPTION 'external_qa_stale' USING ERRCODE='PT409';
    END IF;
    SELECT COALESCE(array_agg(g.project_id ORDER BY g.project_id),ARRAY[]::text[]) INTO granted
      FROM public.external_qa_project_grants g WHERE g.account_id=account.id;
    before_state := jsonb_build_object('name',account.name,'isActive',account.is_active,'projectIds',granted,'revision',account.revision);
  ELSE
    granted := ARRAY[]::text[];
    IF normalized_email IS NULL OR length(normalized_email)>254 OR normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
      THEN RAISE EXCEPTION 'external_qa_invalid' USING ERRCODE='22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.members m WHERE lower(btrim(m.email))=normalized_email OR m.auth_id=p_auth_id)
      OR EXISTS (SELECT 1 FROM auth.users u WHERE lower(btrim(u.email))=normalized_email AND u.id IS DISTINCT FROM p_auth_id) THEN
      RAISE EXCEPTION 'external_qa_email_in_use' USING ERRCODE='PT409';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(p_project_ids) req(id)
    LEFT JOIN public.projects p ON p.id=req.id
    WHERE p.id IS NULL OR (p.is_archived AND NOT req.id=ANY(granted))
  ) OR (SELECT count(DISTINCT req.id) FROM unnest(p_project_ids) req(id))<>cardinality(p_project_ids) THEN
    RAISE EXCEPTION 'external_qa_invalid_projects' USING ERRCODE='22023';
  END IF;
  IF p_action='prepare' THEN RETURN jsonb_build_object('ready',true); END IF;

  IF p_action='create' THEN
    IF p_auth_id IS NULL OR NOT EXISTS(SELECT 1 FROM auth.users u
      WHERE u.id=p_auth_id AND lower(btrim(u.email))=normalized_email) THEN
      RAISE EXCEPTION 'external_qa_invalid_auth' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.external_qa_accounts(id,auth_id,name,is_active)
    VALUES (p_account_id,p_auth_id,btrim(p_name),p_active) RETURNING * INTO account;
  ELSE
    UPDATE public.external_qa_accounts a SET name=btrim(p_name),is_active=p_active,revision=a.revision+1
      WHERE a.id=account.id RETURNING * INTO account;
  END IF;
  DELETE FROM public.external_qa_project_grants g
  WHERE g.account_id=account.id AND NOT g.project_id=ANY(p_project_ids);
  INSERT INTO public.external_qa_project_grants(account_id,project_id)
    SELECT account.id,req.id FROM unnest(p_project_ids) req(id) ORDER BY req.id ON CONFLICT DO NOTHING;
  after_state := jsonb_build_object('id',account.id,'name',account.name,'isActive',account.is_active,
    'projectIds',ARRAY(SELECT req.id FROM unnest(p_project_ids) req(id) ORDER BY req.id),'revision',account.revision);
  INSERT INTO public.external_qa_admin_events(account_id,actor_id,before_state,after_state)
    VALUES (account.id,admin_id,before_state,after_state);
  RETURN after_state || jsonb_build_object('email',(SELECT u.email FROM auth.users u WHERE u.id=account.auth_id));
END;
$$;
REVOKE ALL ON FUNCTION public.livo_external_qa_admin(uuid,text,text,uuid,text,text,boolean,text[],integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_external_qa_admin(uuid,text,text,uuid,text,text,boolean,text[],integer) TO service_role;

SELECT public.livo_apply_active_member_gate();
