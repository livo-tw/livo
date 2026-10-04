-- Signed-out requests cannot read or write LIVO's tables.
--
-- Supabase grants every table in schema public to anon by default, and many
-- read policies here are USING (true) for every role. The anon key ships in the
-- browser bundle and Kong lets it call /rest/v1, so anyone who could reach the
-- server could read tasks, members (with e-mails), comments, notifications and
-- settings, and write field_locks, without signing in.
--
-- Nothing in LIVO reads a table before sign-in: the login page only talks to
-- GoTrue, and every Edge Function that queries the database uses the caller's
-- session or the service role. Public task images are served by Storage (schema
-- storage), which this does not touch. Functions keep their own EXECUTE grants
-- and checks.
--
-- Default privileges are revoked too, so tables added by later migrations are
-- not granted to anon again. Repeatable: REVOKE of a privilege that is not held
-- is a no-op; no row is touched.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

DO $livo_anon$
DECLARE
  owner_role text;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY['supabase_admin', 'postgres'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = owner_role) THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM anon', owner_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon', owner_role);
    END IF;
  END LOOP;
END
$livo_anon$;
