-- ISOLATED TEST DATABASE ONLY. Minimal dependencies for the two KB migrations.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE public.members(id text PRIMARY KEY,auth_id uuid,role text,job_title text NOT NULL DEFAULT '',is_active boolean NOT NULL DEFAULT true,email text);
CREATE TABLE public.projects(id text PRIMARY KEY,is_archived boolean NOT NULL DEFAULT false);
CREATE TABLE public.field_locks(lock_key text PRIMARY KEY,locked_by text,expires_at timestamptz);
CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean DEFAULT false);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_storage_broad ON storage.objects FOR ALL TO authenticated USING(true) WITH CHECK(true);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'email'$$;
CREATE FUNCTION public.current_member_id() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$SELECT id FROM members WHERE auth_id=auth.uid() LIMIT 1$$;
CREATE FUNCTION public.current_member_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$SELECT role FROM members WHERE auth_id=auth.uid() LIMIT 1$$;
CREATE FUNCTION public.is_livo_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$SELECT coalesce(public.current_member_role() IN ('admin','super_admin'),false)$$;
GRANT USAGE ON SCHEMA public,auth,storage TO authenticated,anon;
GRANT SELECT ON public.members,public.projects TO authenticated;
GRANT UPDATE ON public.members TO authenticated;
GRANT SELECT ON storage.buckets TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.field_locks,storage.objects TO authenticated;
CREATE PUBLICATION supabase_realtime;
INSERT INTO public.members(id,auth_id,role,job_title,is_active) VALUES
 ('pm-admin','10000000-0000-0000-0000-000000000001','admin','PM',true),
 ('engineer','10000000-0000-0000-0000-000000000002','member','Engineer',true),
 ('other-admin','10000000-0000-0000-0000-000000000003','admin','Engineer',true),
 ('other-super','10000000-0000-0000-0000-000000000004','super_admin','Engineer',true),
 ('pm-member','10000000-0000-0000-0000-000000000005','member','PM',true),
 ('inactive-pm','10000000-0000-0000-0000-000000000006','member','PM',false);
