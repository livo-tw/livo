-- Disposable fixture: the real members.role enum and auth UUID shape are retained.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE TYPE public.app_member_role AS ENUM ('admin','member','super_admin');
CREATE TABLE public.members(id text PRIMARY KEY,auth_id uuid UNIQUE,role public.app_member_role NOT NULL,
  is_active boolean NOT NULL DEFAULT true,is_qa_admin boolean NOT NULL DEFAULT false);
CREATE TABLE public.system_settings(key text PRIMARY KEY,value jsonb,updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.members(id,auth_id,role,is_active,is_qa_admin) VALUES
 ('example-member','00000000-0000-0000-0000-000000000001','member',true,false),
 ('example-admin','00000000-0000-0000-0000-000000000002','admin',true,false),
 ('example-super','00000000-0000-0000-0000-000000000003','super_admin',true,false),
 ('example-qa-admin','00000000-0000-0000-0000-000000000004','member',true,true),
 ('example-inactive','00000000-0000-0000-0000-000000000005','admin',false,false);
INSERT INTO public.system_settings(key,value) VALUES('feature_toggles','{"qa":true,"slackActions":true}'),
 ('qa_workflow','{"version":2,"order":["new","triaged","in_progress","verification","verified","failed","closed","dismissed"],"labels":{},"groups":[]}');
CREATE FUNCTION public.livo_qa_enabled() RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT COALESCE((SELECT value->'qa'='true'::jsonb FROM public.system_settings WHERE key='feature_toggles'),false)
$$;
GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
-- Deliberately permissive legacy table writes: the new guarded key must still reject them.
GRANT ALL ON public.system_settings TO authenticated;
GRANT SELECT ON public.members TO authenticated;
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
DECLARE actual_code text;actual_message text;
BEGIN
 BEGIN EXECUTE statement;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS actual_code=RETURNED_SQLSTATE,actual_message=MESSAGE_TEXT;
  IF actual_code<>expected_code OR position(expected_message IN actual_message)=0 THEN
   RAISE EXCEPTION 'ASSERTION FAILED: %; got [%] %, expected [%] %',label,actual_code,actual_message,expected_code,expected_message;
  END IF;
  INSERT INTO qa_test.results VALUES(label);RETURN;
 END;
 RAISE EXCEPTION 'ASSERTION FAILED: %; expected SQLSTATE %, statement succeeded',label,expected_code;
END;
$$;
