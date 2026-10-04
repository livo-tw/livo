-- ISOLATED TEST DATABASE ONLY. Extends task-work-postgres-fixture.sql with the
-- minimum knowledge/QA dependencies so the actual approval, planning, TaskWork,
-- knowledge, QA and release migrations can run in their real filename order.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA storage;
CREATE TABLE storage.buckets(id text PRIMARY KEY,name text NOT NULL,public boolean NOT NULL DEFAULT false,file_size_limit bigint,allowed_mime_types text[]);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text REFERENCES storage.buckets(id),name text,metadata jsonb,
 created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),last_accessed_at timestamptz,UNIQUE(bucket_id,name));
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;
GRANT SELECT ON storage.buckets TO authenticated;
GRANT ALL ON storage.objects,storage.buckets TO service_role;
ALTER TABLE public.members ADD COLUMN job_title text NOT NULL DEFAULT '';
ALTER TABLE public.system_settings ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE public.field_locks(lock_key text PRIMARY KEY,locked_by text,expires_at timestamptz);
CREATE FUNCTION public.current_member_role() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT role FROM public.members WHERE auth_id=auth.uid() AND is_active LIMIT 1 $$;
CREATE FUNCTION public.is_livo_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT COALESCE(public.current_member_role() IN('admin','super_admin'),false) $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.field_locks TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
CREATE PUBLICATION supabase_realtime;
UPDATE public.members SET job_title='Engineer';
-- Expect success; deferred constraints are checked inside the handler.
CREATE FUNCTION work_test.ok(label text,statement text) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
 EXECUTE statement; SET CONSTRAINTS ALL IMMEDIATE;
 INSERT INTO work_test.results VALUES(label,true,NULL);
EXCEPTION WHEN OTHERS THEN INSERT INTO work_test.results VALUES(label,false,SQLERRM);
END $$;
CREATE FUNCTION work_test.fails(label text,statement text,expected text) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
 BEGIN EXECUTE statement; SET CONSTRAINTS ALL IMMEDIATE;
 EXCEPTION WHEN OTHERS THEN
  INSERT INTO work_test.results VALUES(label,position(expected IN SQLERRM)>0,CASE WHEN position(expected IN SQLERRM)=0 THEN SQLERRM END); RETURN;
 END;
 INSERT INTO work_test.results VALUES(label,false,'statement unexpectedly succeeded');
END $$;
GRANT EXECUTE ON FUNCTION work_test.ok(text,text),work_test.fails(text,text,text) TO anon,authenticated,service_role;
