-- Migration: 20260402_fix_member_data
-- Description: Fix member records to use correct emails and names from mockClient.ts
-- Also fix activity_logs RLS policy for local Docker Supabase

-- (This migration also upserted the rows of an early demo dataset. They were
-- removed: a new install starts with no members.)

-- Fix activity_logs RLS policy for local Docker Supabase
-- Drop existing policies if they exist
DROP POLICY IF EXISTS "activity_logs_select_policy" ON activity_logs;
DROP POLICY IF EXISTS "activity_logs_insert_policy" ON activity_logs;
DROP POLICY IF EXISTS "activity_logs_update_policy" ON activity_logs;
DROP POLICY IF EXISTS "activity_logs_delete_policy" ON activity_logs;

-- Create permissive policies for both authenticated and anon roles (for local development)
CREATE POLICY "activity_logs_select_policy" ON activity_logs
  FOR SELECT
  TO authenticated, anon
  USING (true);

CREATE POLICY "activity_logs_insert_policy" ON activity_logs
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (true);

CREATE POLICY "activity_logs_update_policy" ON activity_logs
  FOR UPDATE
  TO authenticated, anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "activity_logs_delete_policy" ON activity_logs
  FOR DELETE
  TO authenticated, anon
  USING (true);
