-- The task-images bucket is public and its original INSERT policy
-- ("Anyone can upload task images", 20260308183925) has no role, so anyone holding
-- the anon key, which ships in the browser bundle, could upload any file without
-- signing in. The app proxy serves those files from the app's own address, so an
-- uploaded HTML file could run script as LIVO when someone opened its link.
-- (server-proxy.cjs now also downloads non-image types inside a sandbox.)
--
-- Every upload in the app comes from a signed-in member (task attachments,
-- comment files, the rich-text editor, knowledge pages), and Edge Functions use
-- the service role. This RESTRICTIVE policy is ANDed with the existing ones, like
-- kb_storage_insert (20261002_knowledge_base.sql): uploads to task-images now
-- need an active member. Reads and other buckets are unchanged.
-- Repeatable: CREATE OR REPLACE and DROP ... IF EXISTS before CREATE; no row is touched.
CREATE OR REPLACE FUNCTION public.livo_is_active_member()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.members m WHERE m.auth_id = auth.uid() AND m.is_active);
$$;
REVOKE ALL ON FUNCTION public.livo_is_active_member() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.livo_is_active_member() TO anon, authenticated, service_role;

DROP POLICY IF EXISTS livo_task_images_member_insert ON storage.objects;
CREATE POLICY livo_task_images_member_insert ON storage.objects AS RESTRICTIVE FOR INSERT TO public
  WITH CHECK (bucket_id <> 'task-images' OR public.livo_is_active_member());
