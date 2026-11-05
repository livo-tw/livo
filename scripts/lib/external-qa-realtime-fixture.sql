-- Final subscription shape from supabase/realtime v2.76.5 migrations
-- 20211116024918, 20211210212804 and 20251120212548. No production data.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE supabase_realtime_admin NOLOGIN;
CREATE TYPE public.app_member_role AS ENUM ('member','admin','super_admin');
CREATE TABLE public.members (
  id text PRIMARY KEY, auth_id uuid UNIQUE, is_active boolean NOT NULL DEFAULT true,
  role public.app_member_role NOT NULL DEFAULT 'member'
);
CREATE TABLE public.external_qa_accounts (
  id text PRIMARY KEY, auth_id uuid UNIQUE NOT NULL, is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE public.tasks(id text PRIMARY KEY);
CREATE SCHEMA realtime;
CREATE TYPE realtime.equality_op AS ENUM ('eq','neq','lt','lte','gt','gte');
CREATE TYPE realtime.user_defined_filter AS (column_name text,op realtime.equality_op,value text);
CREATE FUNCTION realtime.to_regrole(text) RETURNS regrole LANGUAGE sql IMMUTABLE STRICT AS $$SELECT $1::regrole$$;
CREATE TABLE realtime.subscription (
  id bigint NOT NULL GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id uuid NOT NULL,
  entity regclass NOT NULL,
  filters realtime.user_defined_filter[] NOT NULL DEFAULT '{}',
  claims jsonb NOT NULL,
  claims_role regrole NOT NULL GENERATED ALWAYS AS (realtime.to_regrole(claims->>'role')) STORED,
  created_at timestamp NOT NULL DEFAULT timezone('utc',now()),
  action_filter text DEFAULT '*' CHECK(action_filter IN ('*','INSERT','UPDATE','DELETE'))
);
CREATE UNIQUE INDEX subscription_subscription_id_entity_filters_action_filter_key
  ON realtime.subscription(subscription_id,entity,filters,action_filter);
CREATE INDEX ix_realtime_subscription_entity ON realtime.subscription USING hash(entity);
CREATE TABLE realtime.messages(extension text NOT NULL);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY existing_presence_policy ON realtime.messages TO authenticated USING(extension='presence');
INSERT INTO realtime.messages VALUES('presence');
GRANT USAGE ON SCHEMA realtime,public TO supabase_realtime_admin;
GRANT SELECT,INSERT,UPDATE,DELETE ON realtime.subscription TO supabase_realtime_admin;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA realtime TO supabase_realtime_admin;

CREATE SCHEMA realtime_test;
CREATE TABLE realtime_test.assertions(n integer NOT NULL);
INSERT INTO realtime_test.assertions VALUES(0);
CREATE FUNCTION realtime_test.check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'assertion failed: %',label; END IF;
  UPDATE realtime_test.assertions SET n=n+1;
END;
$$;
CREATE FUNCTION realtime_test.expect_error(label text,statement text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM='realtime_internal_member_required' THEN
      UPDATE realtime_test.assertions SET n=n+1;
      RETURN;
    END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'expected denial: %',label;
END;
$$;
GRANT USAGE ON SCHEMA realtime_test TO supabase_realtime_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA realtime_test TO supabase_realtime_admin;
GRANT SELECT,UPDATE ON realtime_test.assertions TO supabase_realtime_admin;
