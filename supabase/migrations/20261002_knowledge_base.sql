-- Team/project knowledge. No external service or feature switch is required.
CREATE TABLE IF NOT EXISTS public.kb_pages (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 1000000),
  project_id text REFERENCES public.projects(id) ON DELETE RESTRICT,
  parent_id text REFERENCES public.kb_pages(id) ON DELETE RESTRICT,
  sort_order integer NOT NULL DEFAULT 0,
  is_archived boolean NOT NULL DEFAULT false,
  admin_only boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS kb_pages_scope ON public.kb_pages(project_id, parent_id, sort_order);
CREATE TABLE IF NOT EXISTS public.kb_revisions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  page_id text NOT NULL REFERENCES public.kb_pages(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  version integer NOT NULL,
  UNIQUE(page_id, version)
);
CREATE TABLE IF NOT EXISTS public.kb_attachments (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  page_id text NOT NULL REFERENCES public.kb_pages(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_size bigint NOT NULL CHECK (file_size BETWEEN 0 AND 209715200),
  file_type text NOT NULL DEFAULT '',
  storage_path text NOT NULL UNIQUE,
  uploaded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_attachments_page ON public.kb_attachments(page_id);

CREATE OR REPLACE FUNCTION public.kb_can_edit(page text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.current_member_role() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.kb_pages p WHERE p.id = page AND NOT p.is_archived
      AND (NOT p.admin_only OR public.is_livo_admin())
      AND NOT EXISTS (SELECT 1 FROM public.field_locks l WHERE l.lock_key = 'kb:' || p.id
        AND l.locked_by != public.current_member_id() AND l.expires_at > now())
  );
$$;

CREATE OR REPLACE FUNCTION public.kb_page_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor text := public.current_member_id();
  admin boolean := public.is_livo_admin();
  cursor_id text;
  ancestor public.kb_pages%ROWTYPE;
  depth integer := 1;
  child_depth integer;
BEGIN
  IF actor IS NULL OR public.current_member_role() IS NULL THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
  -- Serialize hierarchy changes so simultaneous reparenting cannot form a cycle.
  PERFORM pg_advisory_xact_lock(hashtext('livo_kb_tree'));
  IF TG_OP = 'INSERT' THEN
    IF NOT admin AND (NEW.admin_only OR NEW.is_archived) THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
    NEW.created_by := actor;
    NEW.created_at := now();
    NEW.version := 1;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
    IF NOT admin AND (OLD.admin_only OR NEW.admin_only IS DISTINCT FROM OLD.admin_only
      OR NEW.is_archived IS DISTINCT FROM OLD.is_archived) THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
    IF OLD.is_archived AND NOT (admin AND NOT NEW.is_archived AND
      ROW(NEW.title, NEW.body, NEW.project_id, NEW.parent_id, NEW.sort_order, NEW.admin_only)
      IS NOT DISTINCT FROM ROW(OLD.title, OLD.body, OLD.project_id, OLD.parent_id, OLD.sort_order, OLD.admin_only))
      THEN RAISE EXCEPTION 'kb_archived'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.field_locks WHERE lock_key = 'kb:' || OLD.id
      AND locked_by = actor AND expires_at > now()) THEN RAISE EXCEPTION 'kb_conflict'; END IF;
    NEW.version := OLD.version + 1;
  END IF;
  NEW.updated_by := actor;
  NEW.updated_at := clock_timestamp();
  IF NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.projects WHERE id = NEW.project_id
    AND (NOT is_archived OR (TG_OP = 'UPDATE' AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id)))
    THEN RAISE EXCEPTION 'kb_invalid_project'; END IF;
  cursor_id := NEW.parent_id;
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW.id THEN RAISE EXCEPTION 'kb_cycle'; END IF;
    SELECT * INTO ancestor FROM public.kb_pages WHERE id = cursor_id;
    IF NOT FOUND OR ancestor.project_id IS DISTINCT FROM NEW.project_id THEN RAISE EXCEPTION 'kb_invalid_parent'; END IF;
    IF depth = 1 AND ancestor.is_archived AND (TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id)
      THEN RAISE EXCEPTION 'kb_invalid_parent'; END IF;
    depth := depth + 1;
    IF depth > 3 THEN RAISE EXCEPTION 'kb_depth'; END IF;
    cursor_id := ancestor.parent_id;
  END LOOP;
  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (SELECT 1 FROM public.kb_pages WHERE parent_id = NEW.id AND project_id IS DISTINCT FROM NEW.project_id)
      THEN RAISE EXCEPTION 'kb_invalid_parent'; END IF;
    WITH RECURSIVE children AS (
      SELECT id, 1 AS d FROM public.kb_pages WHERE parent_id = NEW.id
      UNION ALL SELECT p.id, c.d+1 FROM public.kb_pages p JOIN children c ON p.parent_id = c.id WHERE c.d < 3
    ) SELECT COALESCE(MAX(d),0) INTO child_depth FROM children;
    IF depth + child_depth > 3 THEN RAISE EXCEPTION 'kb_depth'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.kb_save_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.kb_revisions(page_id, body, created_by, created_at, version)
    VALUES (OLD.id, OLD.body, OLD.updated_by, OLD.updated_at, OLD.version) ON CONFLICT DO NOTHING;
  DELETE FROM public.kb_revisions WHERE page_id = NEW.id AND id IN (
    SELECT id FROM public.kb_revisions WHERE page_id = NEW.id ORDER BY version DESC OFFSET 20
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.kb_attachment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.kb_can_edit(NEW.page_id) OR NEW.storage_path NOT LIKE 'kb/' || NEW.page_id || '/%'
    OR position('..' IN NEW.storage_path) > 0 THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
  NEW.uploaded_by := public.current_member_id();
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.kb_page_guard(), public.kb_save_revision(), public.kb_attachment_guard() FROM PUBLIC;

-- Legacy lock RPCs accept p_member_id. A trigger protects ONLY the new kb
-- namespace, including direct table writes and SECURITY DEFINER RPC calls.
CREATE OR REPLACE FUNCTION public.kb_lock_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE actor text := public.current_member_id(); BEGIN
  IF TG_OP != 'INSERT' AND OLD.lock_key LIKE 'kb:%' THEN
    IF OLD.expires_at > now() AND (actor IS NULL OR OLD.locked_by != actor) THEN RAISE EXCEPTION 'kb_conflict'; END IF;
    IF TG_OP = 'UPDATE' AND NEW.lock_key IS DISTINCT FROM OLD.lock_key THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
  END IF;
  IF TG_OP != 'DELETE' AND NEW.lock_key LIKE 'kb:%' THEN
    IF actor IS NULL OR public.current_member_role() IS NULL OR NEW.locked_by != actor OR NOT EXISTS (
      SELECT 1 FROM public.kb_pages WHERE id = substring(NEW.lock_key FROM 4)
        AND ((NOT is_archived AND NOT admin_only) OR public.is_livo_admin())
    ) THEN RAISE EXCEPTION 'kb_forbidden'; END IF;
    NEW.expires_at := LEAST(NEW.expires_at, now() + interval '30 seconds');
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.kb_lock_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS kb_lock_guard ON public.field_locks;
CREATE TRIGGER kb_lock_guard BEFORE INSERT OR UPDATE OR DELETE ON public.field_locks FOR EACH ROW EXECUTE FUNCTION public.kb_lock_guard();

DROP TRIGGER IF EXISTS kb_page_guard ON public.kb_pages;
CREATE TRIGGER kb_page_guard BEFORE INSERT OR UPDATE ON public.kb_pages FOR EACH ROW EXECUTE FUNCTION public.kb_page_guard();
DROP TRIGGER IF EXISTS kb_save_revision ON public.kb_pages;
CREATE TRIGGER kb_save_revision AFTER UPDATE ON public.kb_pages FOR EACH ROW EXECUTE FUNCTION public.kb_save_revision();
DROP TRIGGER IF EXISTS kb_attachment_guard ON public.kb_attachments;
CREATE TRIGGER kb_attachment_guard BEFORE INSERT ON public.kb_attachments FOR EACH ROW EXECUTE FUNCTION public.kb_attachment_guard();

ALTER TABLE public.kb_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_attachments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kb_pages, public.kb_attachments TO authenticated;
GRANT SELECT ON public.kb_revisions TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.kb_revisions FROM authenticated, anon;

DROP POLICY IF EXISTS kb_pages_read ON public.kb_pages;
CREATE POLICY kb_pages_read ON public.kb_pages FOR SELECT TO authenticated USING (public.current_member_role() IS NOT NULL);
DROP POLICY IF EXISTS kb_pages_insert ON public.kb_pages;
CREATE POLICY kb_pages_insert ON public.kb_pages FOR INSERT TO authenticated WITH CHECK (public.current_member_role() IS NOT NULL AND created_by = public.current_member_id());
DROP POLICY IF EXISTS kb_pages_update ON public.kb_pages;
CREATE POLICY kb_pages_update ON public.kb_pages FOR UPDATE TO authenticated
  USING (public.kb_can_edit(id) OR public.is_livo_admin()) WITH CHECK (public.current_member_role() IS NOT NULL);
DROP POLICY IF EXISTS kb_pages_delete ON public.kb_pages;
CREATE POLICY kb_pages_delete ON public.kb_pages FOR DELETE TO authenticated USING (
  public.current_member_role() IS NOT NULL AND (public.is_livo_admin() OR created_by = public.current_member_id())
  AND NOT EXISTS (SELECT 1 FROM public.field_locks WHERE lock_key = 'kb:' || kb_pages.id
    AND locked_by != public.current_member_id() AND expires_at > now())
);
DROP POLICY IF EXISTS kb_revisions_read ON public.kb_revisions;
CREATE POLICY kb_revisions_read ON public.kb_revisions FOR SELECT TO authenticated USING (public.current_member_role() IS NOT NULL);
DROP POLICY IF EXISTS kb_attachments_read ON public.kb_attachments;
CREATE POLICY kb_attachments_read ON public.kb_attachments FOR SELECT TO authenticated USING (public.current_member_role() IS NOT NULL);
DROP POLICY IF EXISTS kb_attachments_insert ON public.kb_attachments;
CREATE POLICY kb_attachments_insert ON public.kb_attachments FOR INSERT TO authenticated WITH CHECK (public.kb_can_edit(page_id));
DROP POLICY IF EXISTS kb_attachments_delete ON public.kb_attachments;
CREATE POLICY kb_attachments_delete ON public.kb_attachments FOR DELETE TO authenticated USING (public.kb_can_edit(page_id));

-- Existing task-images policies are permissive. AND this guard for kb paths,
-- including anonymous callers, without changing other upload paths or reads.
DROP POLICY IF EXISTS kb_storage_insert ON storage.objects;
CREATE POLICY kb_storage_insert ON storage.objects AS RESTRICTIVE FOR INSERT TO public
  WITH CHECK (bucket_id != 'task-images' OR name NOT LIKE 'kb/%' OR public.kb_can_edit(split_part(name, '/', 2)));
DROP POLICY IF EXISTS kb_storage_update ON storage.objects;
CREATE POLICY kb_storage_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO public
  USING (bucket_id != 'task-images' OR name NOT LIKE 'kb/%' OR public.kb_can_edit(split_part(name, '/', 2)))
  WITH CHECK (bucket_id != 'task-images' OR name NOT LIKE 'kb/%' OR public.kb_can_edit(split_part(name, '/', 2)));
DROP POLICY IF EXISTS kb_storage_delete ON storage.objects;
CREATE POLICY kb_storage_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO public
  USING (bucket_id != 'task-images' OR name NOT LIKE 'kb/%' OR public.kb_can_edit(split_part(name, '/', 2)));

ALTER TABLE public.kb_pages REPLICA IDENTITY FULL;
ALTER TABLE public.kb_attachments REPLICA IDENTITY FULL;
ALTER TABLE public.kb_revisions REPLICA IDENTITY FULL;
DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['kb_pages','kb_attachments','kb_revisions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = tbl) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', tbl);
    END IF;
  END LOOP;
END $$;
