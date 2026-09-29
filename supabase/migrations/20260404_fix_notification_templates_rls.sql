-- ============================================================
-- Migration: 20260404_fix_notification_templates_rls.sql
-- Fix notification_templates INSERT/UPDATE/DELETE RLS policies
-- that compare created_by (member_id) with auth.uid() (UUID).
-- Use current_member_id() instead for correct matching.
-- Also ensure notification_rules has open policies for all authenticated.
-- ============================================================

-- ── 1. Fix notification_templates RLS ─────────────────────────
DROP POLICY IF EXISTS "ntpl_all"    ON public.notification_templates;
DROP POLICY IF EXISTS "ntpl_select" ON public.notification_templates;
DROP POLICY IF EXISTS "ntpl_insert" ON public.notification_templates;
DROP POLICY IF EXISTS "ntpl_update" ON public.notification_templates;
DROP POLICY IF EXISTS "ntpl_delete" ON public.notification_templates;

CREATE POLICY "ntpl_select" ON public.notification_templates
  FOR SELECT USING (true);

CREATE POLICY "ntpl_insert" ON public.notification_templates
  FOR INSERT WITH CHECK (
    auth.uid() IS NOT NULL AND (
      created_by IS NULL
      OR created_by = public.current_member_id()
      OR EXISTS (
        SELECT 1 FROM public.members
        WHERE id = public.current_member_id() AND role IN ('admin', 'super_admin')
      )
    )
  );

CREATE POLICY "ntpl_update" ON public.notification_templates
  FOR UPDATE USING (
    created_by = public.current_member_id()
    OR EXISTS (
      SELECT 1 FROM public.members
      WHERE id = public.current_member_id() AND role IN ('admin', 'super_admin')
    )
  );

CREATE POLICY "ntpl_delete" ON public.notification_templates
  FOR DELETE USING (
    created_by = public.current_member_id()
    OR EXISTS (
      SELECT 1 FROM public.members
      WHERE id = public.current_member_id() AND role IN ('admin', 'super_admin')
    )
  );

-- ── 2. Ensure notification_rules has open policies ────────────
-- The original nrul_all should still be in place, but re-create to be safe
DROP POLICY IF EXISTS "nrul_all"    ON public.notification_rules;
DROP POLICY IF EXISTS "nrul_select" ON public.notification_rules;
DROP POLICY IF EXISTS "nrul_insert" ON public.notification_rules;
DROP POLICY IF EXISTS "nrul_update" ON public.notification_rules;
DROP POLICY IF EXISTS "nrul_delete" ON public.notification_rules;

CREATE POLICY "nrul_all" ON public.notification_rules
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
