-- Synthetic dependencies with the delivery schema's real member/auth types.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$
  SELECT nullif(current_setting('request.jwt.claim.role',true),'')
$$;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  email_confirmed_at timestamptz,
  banned_until timestamptz,
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}',
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE auth.identities(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE);
CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE);
CREATE SCHEMA storage;
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id text,owner uuid);
CREATE TYPE public.app_member_role AS ENUM ('admin','member','super_admin');
CREATE TABLE public.members (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL DEFAULT '',
  avatar text NOT NULL,
  color text NOT NULL DEFAULT '#6B778C',
  role public.app_member_role NOT NULL DEFAULT 'member',
  job_title text NOT NULL DEFAULT '',
  is_qa_admin boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  auth_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  theme text NOT NULL DEFAULT 'dark',
  sort_order integer NOT NULL DEFAULT 0
);
ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_member_read ON public.members FOR SELECT TO authenticated USING (true);
GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
GRANT SELECT ON public.members TO authenticated;
GRANT ALL ON public.members,auth.users TO service_role;
GRANT ALL ON auth.identities,auth.sessions,storage.objects TO service_role;
GRANT USAGE ON SCHEMA storage TO service_role;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
  ('00000000-0000-0000-0000-000000000001','member@example.com',now()),
  ('00000000-0000-0000-0000-000000000002','admin@example.com',now()),
  ('00000000-0000-0000-0000-000000000003','super@example.com',now()),
  ('00000000-0000-0000-0000-000000000004','inactive@example.com',now()),
  ('00000000-0000-0000-0000-000000000005','qa@example.com',now()),
  ('00000000-0000-0000-0000-000000000006','unlinked@example.com',now());
INSERT INTO public.members(id,name,email,avatar,role,auth_id,is_active,is_qa_admin) VALUES
  ('m-member','Example Member','member@example.com','M','member','00000000-0000-0000-0000-000000000001',true,false),
  ('m-admin','Example Admin','admin@example.com','A','admin','00000000-0000-0000-0000-000000000002',true,false),
  ('m-super','Example Owner','super@example.com','O','super_admin','00000000-0000-0000-0000-000000000003',true,false),
  ('m-inactive','Example Inactive','inactive@example.com','I','super_admin','00000000-0000-0000-0000-000000000004',false,false),
  ('m-qa','Example Tester','qa@example.com','T','member','00000000-0000-0000-0000-000000000005',true,true);
-- A prior install can already contain duplicate real emails. Upgrading must
-- preserve them while preventing new duplicates and changed email claims.
INSERT INTO public.members(id,name,email,avatar) VALUES
  ('legacy-email-one','Example Legacy','legacy@example.com','L'),
  ('legacy-email-two','Example Legacy','LEGACY@example.com','L');
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
