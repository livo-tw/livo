-- A signed-in session must belong to an active member to use any LIVO table.
--
-- Many read policies are USING (true) for authenticated, and several write
-- policies too (tasks, specs, todos, checks, sprints ...). Before this release the
-- shipped GoTrue settings allowed public sign-up with auto-confirm, so anyone who
-- could reach a #40-era server could register a login with no members row and, as
-- "authenticated", read every table and edit any task. Turning sign-up off stops
-- new accounts but not the ones already registered. A member deactivated less than
-- an hour ago also kept working with the token it already had.
--
-- Every login LIVO creates is linked to its members row at creation (the
-- installer's create-admin.sql, manage-member, the Jira import, account
-- activation), so this costs members nothing. An unlinked login now sees no data;
-- the web app tells the person the account is not linked and signs them out, and a
-- super_admin can link it from Team settings.
--
-- One RESTRICTIVE policy per table is ANDed with the existing policies, so every
-- current rule still applies on top. The service role (Edge Functions) and
-- SECURITY DEFINER commands are not affected. A table added later gets the gate by
-- calling public.livo_apply_active_member_gate() at the end of its migration.
-- Repeatable: CREATE OR REPLACE, DROP POLICY IF EXISTS before CREATE; no row is touched.
CREATE OR REPLACE FUNCTION public.livo_is_active_member()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.members m WHERE m.auth_id = auth.uid() AND m.is_active);
$$;
REVOKE ALL ON FUNCTION public.livo_is_active_member() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.livo_is_active_member() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.livo_apply_active_member_gate()
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  t record;
  n integer := 0;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS livo_active_member_only ON public.%I', t.relname);
    -- (SELECT ...) makes the check run once per statement, not once per row.
    EXECUTE format(
      'CREATE POLICY livo_active_member_only ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING ((SELECT public.livo_is_active_member())) WITH CHECK ((SELECT public.livo_is_active_member()))',
      t.relname);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_apply_active_member_gate() FROM PUBLIC, anon, authenticated;

SELECT public.livo_apply_active_member_gate();
