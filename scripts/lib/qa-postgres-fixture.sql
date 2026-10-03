-- Test-only minimum of existing Docker dependencies, never a production schema.
-- The two QA migrations below are loaded unchanged from the real source files.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
CREATE TABLE public.members (
  id text PRIMARY KEY, auth_id uuid UNIQUE, role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE public.projects (id text PRIMARY KEY,is_archived boolean NOT NULL DEFAULT false);
CREATE TABLE public.tasks (id text PRIMARY KEY,project_id text NOT NULL REFERENCES public.projects(id));
CREATE TABLE public.system_settings (key text PRIMARY KEY,value jsonb,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),recipient_id text NOT NULL,sender_id text,
  type text NOT NULL,task_id text,content text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY,name text NOT NULL,public boolean NOT NULL DEFAULT false,
  file_size_limit bigint,allowed_mime_types text[]
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text REFERENCES storage.buckets(id),
  name text,metadata jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),last_accessed_at timestamptz,
  UNIQUE(bucket_id,name)
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
-- Deliberately permissive legacy policy: QA's restrictive policy must still win.
CREATE POLICY legacy_storage_all ON storage.objects TO anon,authenticated USING(true) WITH CHECK(true);
GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public,storage TO service_role;
GRANT ALL ON storage.objects TO anon,authenticated;
-- Deliberately permissive settings access to exercise the new direct-write guard.
GRANT ALL ON public.system_settings TO anon,authenticated;
CREATE FUNCTION public.livo_slack_enabled() RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
  SELECT COALESCE((SELECT value->'slackActions'='true'::jsonb FROM public.system_settings WHERE key='feature_toggles'),false)
$$;
INSERT INTO public.members(id,auth_id,role) VALUES
  ('m-member','00000000-0000-0000-0000-000000000001','member'),
  ('m-admin','00000000-0000-0000-0000-000000000002','admin'),
  ('m-super','00000000-0000-0000-0000-000000000003','super_admin'),
  ('m-assignee','00000000-0000-0000-0000-000000000004','member'),
  ('m-qa','00000000-0000-0000-0000-000000000005','member');
INSERT INTO public.projects(id) VALUES('p-test');
INSERT INTO public.tasks(id,project_id) VALUES('t-test','p-test');
INSERT INTO public.system_settings(key,value) VALUES('feature_toggles','{"qa":true,"slackActions":true}');

CREATE SCHEMA qa_test;
CREATE TABLE qa_test.results(label text PRIMARY KEY);
GRANT USAGE ON SCHEMA qa_test TO anon,authenticated,service_role;
GRANT INSERT,SELECT ON qa_test.results TO anon,authenticated,service_role;
CREATE FUNCTION qa_test.check(ok boolean,label text) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'ASSERTION FAILED: %',label; END IF;
  INSERT INTO qa_test.results VALUES(label);
END;
$$;
CREATE FUNCTION qa_test.expect_error(label text,statement text,expected_code text,expected_message text DEFAULT '')
RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE actual_code text; actual_message text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_code=RETURNED_SQLSTATE,actual_message=MESSAGE_TEXT;
    IF actual_code<>expected_code OR position(expected_message IN actual_message)=0 THEN
      RAISE EXCEPTION 'ASSERTION FAILED: %; got [%] %, expected [%] %',label,actual_code,actual_message,expected_code,expected_message;
    END IF;
    INSERT INTO qa_test.results VALUES(label);
    RETURN;
  END;
  RAISE EXCEPTION 'ASSERTION FAILED: %; expected SQLSTATE %, statement succeeded',label,expected_code;
END;
$$;
