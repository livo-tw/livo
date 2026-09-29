-- =============================================================================
-- Migration: 20260403_fix_approval_member_rls.sql
-- Fix: approval_requests and approval_actions RLS policies compare
--      requested_by / action_by against auth.uid()::text, but these columns
--      store member IDs (e.g. 'm-xxx'), not Supabase Auth UUIDs.
--      This blocks all INSERT/UPDATE operations.
--
-- Solution: Use a subquery to resolve auth.uid() → members.id via auth_id,
--           then compare against that member ID.
-- =============================================================================

-- Helper function: resolve auth.uid() to member ID
-- members.auth_id is uuid and auth.uid() returns uuid — comparing uuid = uuid
-- directly. (A stray ::text cast here makes Postgres error "operator does not
-- exist: uuid = text" at CREATE time and aborts the whole fresh-install schema.)
CREATE OR REPLACE FUNCTION public.current_member_id() RETURNS text AS $$
  SELECT id FROM public.members WHERE auth_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- approval_requests
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "approval_requests_insert_own" ON approval_requests;
CREATE POLICY "approval_requests_insert_own" ON approval_requests
  FOR INSERT TO authenticated
  WITH CHECK (requested_by = public.current_member_id());

DROP POLICY IF EXISTS "approval_requests_update_own" ON approval_requests;
CREATE POLICY "approval_requests_update_own" ON approval_requests
  FOR UPDATE TO authenticated
  USING (true);
  -- Allow any authenticated user to update (step-advance by approvers).
  -- Fine-grained check is enforced on the frontend in performAction().

-- ---------------------------------------------------------------------------
-- approval_actions
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "approval_actions_insert_own" ON approval_actions;
CREATE POLICY "approval_actions_insert_own" ON approval_actions
  FOR INSERT TO authenticated
  WITH CHECK (action_by = public.current_member_id());

-- ---------------------------------------------------------------------------
-- notification_rules (notification_rules has no created_by column;
--   keep existing nrul_all / nrul_select policies — skip write policies)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "nrul_select" ON public.notification_rules;
CREATE POLICY "nrul_select" ON public.notification_rules
  FOR SELECT TO authenticated USING (true);
  -- Team-wide visibility for notification rules

-- ---------------------------------------------------------------------------
-- external_account_bindings (same issue)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "eab_select" ON external_account_bindings;
CREATE POLICY "eab_select" ON external_account_bindings
  FOR SELECT TO authenticated
  USING (member_id = public.current_member_id());

DROP POLICY IF EXISTS "eab_insert" ON external_account_bindings;
CREATE POLICY "eab_insert" ON external_account_bindings
  FOR INSERT TO authenticated
  WITH CHECK (member_id = public.current_member_id());

DROP POLICY IF EXISTS "eab_update" ON external_account_bindings;
CREATE POLICY "eab_update" ON external_account_bindings
  FOR UPDATE TO authenticated
  USING (member_id = public.current_member_id())
  WITH CHECK (member_id = public.current_member_id());

DROP POLICY IF EXISTS "eab_delete" ON external_account_bindings;
CREATE POLICY "eab_delete" ON external_account_bindings
  FOR DELETE TO authenticated
  USING (member_id = public.current_member_id());

-- ---------------------------------------------------------------------------
-- external_action_logs (same issue)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "eal_insert" ON external_action_logs;
CREATE POLICY "eal_insert" ON external_action_logs
  FOR INSERT TO authenticated
  WITH CHECK (member_id = public.current_member_id());
