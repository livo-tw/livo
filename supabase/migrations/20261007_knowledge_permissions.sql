-- Knowledge ACLs are enforced on every ancestor and every read surface.
-- No role, including super_admin, implicitly bypasses a custom view rule.
ALTER TABLE public.kb_pages ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'general';
ALTER TABLE public.kb_pages ADD COLUMN IF NOT EXISTS access_policy jsonb NOT NULL DEFAULT '{"mode":"inherit"}'::jsonb;
ALTER TABLE public.kb_attachments ADD COLUMN IF NOT EXISTS storage_bucket text NOT NULL DEFAULT 'task-images';
ALTER TABLE public.kb_attachments ALTER COLUMN storage_bucket SET DEFAULT 'kb-files';
CREATE TABLE IF NOT EXISTS public.kb_comments (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  page_id text NOT NULL REFERENCES public.kb_pages(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 10000),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_comments_page ON public.kb_comments(page_id, created_at);

-- Position-based access must not be defeated by login rebinding or self-editing a title.
CREATE OR REPLACE FUNCTION public.kb_member_identity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE caller uuid:=auth.uid(); role_name text:=public.current_member_role(); jwt_role text;
BEGIN
  IF length(NEW.job_title)>200 THEN RAISE EXCEPTION 'job_title must be at most 200 characters'; END IF;
  jwt_role:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role');
  IF caller IS NULL OR jwt_role='service_role' OR role_name='super_admin' THEN RETURN NEW; END IF;
  IF NEW.job_title IS DISTINCT FROM OLD.job_title THEN RAISE EXCEPTION 'Only super_admin can assign positions' USING ERRCODE='insufficient_privilege'; END IF;
  IF NEW.auth_id IS DISTINCT FROM OLD.auth_id AND (
    NOT coalesce((OLD.id IS NOT DISTINCT FROM public.current_member_id() OR OLD.auth_id IS NOT DISTINCT FROM caller
      OR (OLD.auth_id IS NULL AND lower(OLD.email)=lower(auth.email()))),false)
    OR (NEW.auth_id IS NOT NULL AND NEW.auth_id!=caller)
  ) THEN RAISE EXCEPTION 'Only super_admin can change another member login' USING ERRCODE='insufficient_privilege'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.kb_member_identity_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS kb_member_identity_guard ON public.members;
CREATE TRIGGER kb_member_identity_guard BEFORE UPDATE ON public.members FOR EACH ROW EXECUTE FUNCTION public.kb_member_identity_guard();

CREATE OR REPLACE FUNCTION public.kb_policy_valid(policy jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE action text; field text; rule jsonb; BEGIN
  IF jsonb_typeof(policy) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF policy = '{"mode":"inherit"}'::jsonb THEN RETURN true; END IF;
  IF policy->>'mode' IS DISTINCT FROM 'custom' OR (policy - ARRAY['mode','view','edit','comment']) != '{}'::jsonb THEN RETURN false; END IF;
  FOREACH action IN ARRAY ARRAY['view','edit','comment'] LOOP
    rule := policy->action;
    IF jsonb_typeof(rule) IS DISTINCT FROM 'object' OR (rule - ARRAY['roles','positions','member_ids']) != '{}'::jsonb THEN RETURN false; END IF;
    FOREACH field IN ARRAY ARRAY['roles','positions','member_ids'] LOOP
      IF jsonb_typeof(rule->field) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      IF jsonb_array_length(rule->field) > 200 OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(rule->field) v WHERE jsonb_typeof(v) != 'string' OR length(trim(v#>>'{}')) NOT BETWEEN 1 AND 200
      ) THEN RETURN false; END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(rule->'roles') v WHERE v NOT IN ('member','admin','super_admin')) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='kb_category_valid' AND conrelid='public.kb_pages'::regclass) THEN
    ALTER TABLE public.kb_pages ADD CONSTRAINT kb_category_valid CHECK (category IN ('general','meeting'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='kb_access_policy_valid' AND conrelid='public.kb_pages'::regclass) THEN
    ALTER TABLE public.kb_pages ADD CONSTRAINT kb_access_policy_valid CHECK (public.kb_policy_valid(access_policy));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.kb_has_permission(page text, action text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE actor public.members%ROWTYPE; p public.kb_pages%ROWTYPE; cursor_id text := page; seen text[] := ARRAY[]::text[]; rule jsonb; a text;
BEGIN
  IF action NOT IN ('view','edit','comment') THEN RETURN false; END IF;
  SELECT * INTO actor FROM public.members WHERE auth_id=auth.uid() AND is_active LIMIT 1;
  IF NOT FOUND OR actor.role::text NOT IN ('member','admin','super_admin') THEN RETURN false; END IF;
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id=ANY(seen) OR cardinality(seen)>=3 THEN RETURN false; END IF;
    seen := array_append(seen,cursor_id);
    SELECT * INTO p FROM public.kb_pages WHERE id=cursor_id;
    IF NOT FOUND OR NOT public.kb_policy_valid(p.access_policy) THEN RETURN false; END IF;
    IF action != 'view' AND (p.is_archived OR (action='edit' AND p.admin_only AND actor.role::text NOT IN ('admin','super_admin'))) THEN RETURN false; END IF;
    IF p.access_policy->>'mode'='custom' THEN
      FOREACH a IN ARRAY (CASE WHEN action='view' THEN ARRAY['view'] ELSE ARRAY['view',action] END) LOOP
        rule := p.access_policy->a;
        IF NOT (rule->'roles' ? actor.role::text OR rule->'positions' ? actor.job_title OR rule->'member_ids' ? actor.id) THEN RETURN false; END IF;
      END LOOP;
    END IF;
    cursor_id:=p.parent_id;
  END LOOP;
  RETURN cardinality(seen)>0;
END $$;
CREATE OR REPLACE FUNCTION public.kb_can_edit(page text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT public.kb_has_permission(page,'edit') AND NOT EXISTS (
    SELECT 1 FROM public.field_locks WHERE lock_key='kb:'||page AND locked_by!=public.current_member_id() AND expires_at>now());
$$;
CREATE OR REPLACE FUNCTION public.kb_can_manage(page text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT public.is_livo_admin() AND public.kb_has_permission(page,'view');
$$;

-- Runs before the original hierarchy/version/lock guard, which stays intact.
CREATE OR REPLACE FUNCTION public.kb_acl_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE admin boolean:=public.is_livo_admin(); has_public boolean; restricted boolean; actor public.members%ROWTYPE; BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.members WHERE id=public.current_member_id() AND is_active AND role::text IN ('member','admin','super_admin')) THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
  IF NOT public.kb_policy_valid(NEW.access_policy) THEN RAISE EXCEPTION 'kb_invalid_policy'; END IF;
  IF NEW.access_policy->>'mode'='custom' AND (TG_OP='INSERT' OR NEW.access_policy IS DISTINCT FROM OLD.access_policy) THEN
    SELECT * INTO actor FROM public.members WHERE id=public.current_member_id() AND is_active;
    IF NOT FOUND OR NOT (NEW.access_policy->'view'->'roles' ? actor.role::text OR NEW.access_policy->'view'->'positions' ? actor.job_title OR NEW.access_policy->'view'->'member_ids' ? actor.id) THEN RAISE EXCEPTION 'kb_self_lockout'; END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.access_policy->>'mode'='custom' AND NOT admin THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
    IF NEW.parent_id IS NOT NULL AND NOT public.kb_has_permission(NEW.parent_id,'edit') THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
  ELSE
    IF NEW.access_policy IS DISTINCT FROM OLD.access_policy AND NOT public.kb_can_manage(OLD.id) THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
    IF NOT public.kb_has_permission(OLD.id,'edit') AND NOT (
      public.kb_can_manage(OLD.id) AND
      ROW(NEW.title,NEW.body,NEW.project_id,NEW.parent_id,NEW.sort_order,NEW.admin_only,NEW.category)
        IS NOT DISTINCT FROM ROW(OLD.title,OLD.body,OLD.project_id,OLD.parent_id,OLD.sort_order,OLD.admin_only,OLD.category)
      AND (NEW.is_archived IS NOT DISTINCT FROM OLD.is_archived OR (OLD.is_archived AND NOT NEW.is_archived))
    ) THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
    -- Reparenting changes inherited permissions; only a visible-page ACL manager can do it.
    IF NEW.parent_id IS DISTINCT FROM OLD.parent_id AND NOT public.kb_can_manage(OLD.id) THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
    IF NEW.parent_id IS NOT NULL AND NEW.parent_id IS DISTINCT FROM OLD.parent_id AND NOT public.kb_has_permission(NEW.parent_id,'edit') THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
  END IF;
  IF TG_OP='INSERT' OR NEW.access_policy IS DISTINCT FROM OLD.access_policy OR NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    WITH RECURSIVE ancestors AS (
      SELECT id,parent_id,access_policy,1 AS d FROM public.kb_pages WHERE id=NEW.parent_id
      UNION ALL SELECT p.id,p.parent_id,p.access_policy,a.d+1 FROM public.kb_pages p JOIN ancestors a ON p.id=a.parent_id WHERE a.d<3
    ) SELECT NEW.access_policy->>'mode'='custom' OR EXISTS (SELECT 1 FROM ancestors WHERE access_policy->>'mode'='custom') INTO restricted;
    WITH RECURSIVE children AS (
      SELECT NEW.id AS id,1 AS d UNION ALL SELECT p.id,c.d+1 FROM public.kb_pages p JOIN children c ON p.parent_id=c.id WHERE c.d<3
    ) SELECT EXISTS (SELECT 1 FROM public.kb_attachments a JOIN children c ON c.id=a.page_id WHERE a.storage_bucket!='kb-files') INTO has_public;
    IF restricted AND has_public THEN RAISE EXCEPTION 'kb_legacy_public_attachments'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS kb_acl_guard ON public.kb_pages;
CREATE TRIGGER kb_acl_guard BEFORE INSERT OR UPDATE ON public.kb_pages FOR EACH ROW EXECUTE FUNCTION public.kb_acl_guard();

CREATE OR REPLACE FUNCTION public.kb_lock_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor text:=public.current_member_id(); page text; BEGIN
  IF TG_OP!='INSERT' AND OLD.lock_key LIKE 'kb:%' THEN
    IF OLD.expires_at>now() AND (actor IS NULL OR OLD.locked_by!=actor) THEN RAISE EXCEPTION 'kb_conflict'; END IF;
    IF TG_OP='UPDATE' AND NEW.lock_key IS DISTINCT FROM OLD.lock_key THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
  END IF;
  IF TG_OP!='DELETE' AND NEW.lock_key LIKE 'kb:%' THEN
    page:=substring(NEW.lock_key FROM 4);
    IF actor IS NULL OR NEW.locked_by!=actor OR NOT (public.kb_has_permission(page,'edit') OR public.kb_can_manage(page)) THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
    NEW.expires_at:=LEAST(NEW.expires_at,now()+interval '30 seconds');
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.kb_attachment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN
  IF NOT public.kb_can_edit(NEW.page_id) OR NEW.storage_bucket!='kb-files'
    OR NEW.storage_path NOT LIKE 'kb/'||NEW.page_id||'/%' OR position('..' IN NEW.storage_path)>0 THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
  NEW.uploaded_by:=public.current_member_id(); NEW.created_at:=now(); RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.kb_comment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN
  IF NOT public.kb_has_permission(NEW.page_id,'comment') THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
  IF TG_OP='UPDATE' AND (OLD.created_by!=public.current_member_id() OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.page_id IS DISTINCT FROM OLD.page_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at)
    THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
  IF TG_OP='INSERT' THEN NEW.created_by:=public.current_member_id(); NEW.created_at:=now(); END IF;
  NEW.updated_at:=clock_timestamp(); RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS kb_comment_guard ON public.kb_comments;
CREATE TRIGGER kb_comment_guard BEFORE INSERT OR UPDATE ON public.kb_comments FOR EACH ROW EXECUTE FUNCTION public.kb_comment_guard();

DROP POLICY IF EXISTS kb_pages_read ON public.kb_pages;
CREATE POLICY kb_pages_read ON public.kb_pages FOR SELECT TO authenticated USING (public.kb_has_permission(id,'view'));
DROP POLICY IF EXISTS kb_pages_update ON public.kb_pages;
CREATE POLICY kb_pages_update ON public.kb_pages FOR UPDATE TO authenticated USING (public.kb_can_edit(id) OR public.kb_can_manage(id)) WITH CHECK (public.current_member_role() IS NOT NULL);
DROP POLICY IF EXISTS kb_pages_delete ON public.kb_pages;
CREATE POLICY kb_pages_delete ON public.kb_pages FOR DELETE TO authenticated USING (
  public.kb_can_edit(id) AND (public.is_livo_admin() OR created_by=public.current_member_id()));
DROP POLICY IF EXISTS kb_revisions_read ON public.kb_revisions;
CREATE POLICY kb_revisions_read ON public.kb_revisions FOR SELECT TO authenticated USING (public.kb_has_permission(page_id,'view'));
DROP POLICY IF EXISTS kb_attachments_read ON public.kb_attachments;
CREATE POLICY kb_attachments_read ON public.kb_attachments FOR SELECT TO authenticated USING (public.kb_has_permission(page_id,'view'));
ALTER TABLE public.kb_comments ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.kb_comments TO authenticated;
DROP POLICY IF EXISTS kb_comments_read ON public.kb_comments;
CREATE POLICY kb_comments_read ON public.kb_comments FOR SELECT TO authenticated USING (public.kb_has_permission(page_id,'view'));
DROP POLICY IF EXISTS kb_comments_insert ON public.kb_comments;
CREATE POLICY kb_comments_insert ON public.kb_comments FOR INSERT TO authenticated WITH CHECK (public.kb_has_permission(page_id,'comment') AND created_by=public.current_member_id());
DROP POLICY IF EXISTS kb_comments_update ON public.kb_comments;
CREATE POLICY kb_comments_update ON public.kb_comments FOR UPDATE TO authenticated USING (public.kb_has_permission(page_id,'comment') AND created_by=public.current_member_id()) WITH CHECK (public.kb_has_permission(page_id,'comment') AND created_by=public.current_member_id());
DROP POLICY IF EXISTS kb_comments_delete ON public.kb_comments;
CREATE POLICY kb_comments_delete ON public.kb_comments FOR DELETE TO authenticated USING ((public.kb_has_permission(page_id,'comment') AND created_by=public.current_member_id()) OR public.kb_can_edit(page_id));
DROP POLICY IF EXISTS kb_locks_read_floor ON public.field_locks;
CREATE POLICY kb_locks_read_floor ON public.field_locks AS RESTRICTIVE FOR SELECT TO authenticated USING (lock_key NOT LIKE 'kb:%' OR public.kb_has_permission(substring(lock_key FROM 4),'view'));

INSERT INTO storage.buckets(id,name,public) VALUES ('kb-files','kb-files',false) ON CONFLICT(id) DO UPDATE SET public=false;
DROP POLICY IF EXISTS kb_files_read ON storage.objects;
CREATE POLICY kb_files_read ON storage.objects FOR SELECT TO authenticated USING (bucket_id='kb-files' AND name LIKE 'kb/%' AND public.kb_has_permission(split_part(name,'/',2),'view'));
DROP POLICY IF EXISTS kb_files_insert ON storage.objects;
CREATE POLICY kb_files_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id='kb-files' AND name LIKE 'kb/%' AND position('..' IN name)=0 AND public.kb_can_edit(split_part(name,'/',2)));
DROP POLICY IF EXISTS kb_files_update ON storage.objects;
CREATE POLICY kb_files_update ON storage.objects FOR UPDATE TO authenticated USING (bucket_id='kb-files' AND public.kb_can_edit(split_part(name,'/',2))) WITH CHECK (bucket_id='kb-files' AND name LIKE 'kb/%' AND position('..' IN name)=0 AND public.kb_can_edit(split_part(name,'/',2)));
DROP POLICY IF EXISTS kb_files_delete ON storage.objects;
CREATE POLICY kb_files_delete ON storage.objects FOR DELETE TO authenticated USING (bucket_id='kb-files' AND public.kb_can_edit(split_part(name,'/',2)));
-- Defense against other broad permissive storage policies.
DROP POLICY IF EXISTS kb_files_read_floor ON storage.objects;
CREATE POLICY kb_files_read_floor ON storage.objects AS RESTRICTIVE FOR SELECT TO public USING (bucket_id!='kb-files' OR (name LIKE 'kb/%' AND public.kb_has_permission(split_part(name,'/',2),'view')));
DROP POLICY IF EXISTS kb_files_write_floor ON storage.objects;
CREATE POLICY kb_files_write_floor ON storage.objects AS RESTRICTIVE FOR INSERT TO public WITH CHECK (bucket_id!='kb-files' OR (name LIKE 'kb/%' AND position('..' IN name)=0 AND public.kb_can_edit(split_part(name,'/',2))));
DROP POLICY IF EXISTS kb_files_update_floor ON storage.objects;
CREATE POLICY kb_files_update_floor ON storage.objects AS RESTRICTIVE FOR UPDATE TO public USING (bucket_id!='kb-files' OR public.kb_can_edit(split_part(name,'/',2))) WITH CHECK (bucket_id!='kb-files' OR (name LIKE 'kb/%' AND position('..' IN name)=0 AND public.kb_can_edit(split_part(name,'/',2))));
DROP POLICY IF EXISTS kb_files_delete_floor ON storage.objects;
CREATE POLICY kb_files_delete_floor ON storage.objects AS RESTRICTIVE FOR DELETE TO public USING (bucket_id!='kb-files' OR public.kb_can_edit(split_part(name,'/',2)));
DROP POLICY IF EXISTS kb_storage_insert ON storage.objects;
CREATE POLICY kb_storage_insert ON storage.objects AS RESTRICTIVE FOR INSERT TO public WITH CHECK (bucket_id!='task-images' OR name NOT LIKE 'kb/%');
DROP POLICY IF EXISTS kb_storage_update ON storage.objects;
CREATE POLICY kb_storage_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO public USING (bucket_id!='task-images' OR name NOT LIKE 'kb/%') WITH CHECK (bucket_id!='task-images' OR name NOT LIKE 'kb/%');

REVOKE ALL ON FUNCTION public.kb_acl_guard(),public.kb_comment_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kb_has_permission(text,text),public.kb_can_manage(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kb_has_permission(text,text),public.kb_can_manage(text) TO authenticated,anon;
-- DELETE events cannot be RLS filtered by Supabase Realtime. Never publish old bodies.
ALTER TABLE public.kb_pages REPLICA IDENTITY DEFAULT;
ALTER TABLE public.kb_revisions REPLICA IDENTITY DEFAULT;
ALTER TABLE public.kb_attachments REPLICA IDENTITY DEFAULT;
ALTER TABLE public.kb_comments REPLICA IDENTITY DEFAULT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='kb_comments') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.kb_comments;
  END IF;
END $$;
