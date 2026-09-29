-- =============================================================================
-- Migration: 20260402_fix_approval_rls.sql
-- Fixes:
--   M5 — approval_actions INSERT must enforce action_by = auth.uid() (member id);
--        approval_requests UPDATE restricted to requested_by only via RLS
--        (step-approver check is enforced on the frontend in performAction).
--   M6 — interaction_tokens RLS: block frontend SELECT/UPDATE;
--        INSERT allowed for authenticated users (token creation);
--        UPDATE blocked (is_used must only be set server-side / Edge Function).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- M5: approval_actions
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "authenticated_all_approval_actions" ON approval_actions;

-- Anyone authenticated can read all actions (needed for progress display)
CREATE POLICY "approval_actions_select" ON approval_actions
  FOR SELECT TO authenticated USING (true);

-- INSERT only allowed when action_by matches the caller's auth UID
-- (members.id is stored as text; auth.uid() returns uuid — cast to text for comparison)
CREATE POLICY "approval_actions_insert_own" ON approval_actions
  FOR INSERT TO authenticated
  WITH CHECK (action_by = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- M5: approval_requests
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "authenticated_all_approval_requests" ON approval_requests;

-- Anyone authenticated can read all requests (needed for pending list / progress)
CREATE POLICY "approval_requests_select" ON approval_requests
  FOR SELECT TO authenticated USING (true);

-- INSERT: only the requester can open a new approval (requested_by = caller)
CREATE POLICY "approval_requests_insert_own" ON approval_requests
  FOR INSERT TO authenticated
  WITH CHECK (requested_by = auth.uid()::text);

-- UPDATE: only the requester can cancel their own request.
-- Step-advance and status updates by approvers are validated on the frontend;
-- a tighter server-side check requires a DB function (out of scope here).
CREATE POLICY "approval_requests_update_own" ON approval_requests
  FOR UPDATE TO authenticated
  USING (requested_by = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- M6: interaction_tokens
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "authenticated_all_interaction_tokens" ON interaction_tokens;

-- SELECT: blocked for all frontend clients (tokens should never be read client-side)
CREATE POLICY "interaction_tokens_select_none" ON interaction_tokens
  FOR SELECT TO authenticated USING (false);

-- INSERT: allowed for authenticated users (Edge Function / server creates tokens)
CREATE POLICY "interaction_tokens_insert" ON interaction_tokens
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- UPDATE: blocked (marking is_used must only be done server-side / Edge Function)
CREATE POLICY "interaction_tokens_update_none" ON interaction_tokens
  FOR UPDATE TO authenticated
  USING (false);
