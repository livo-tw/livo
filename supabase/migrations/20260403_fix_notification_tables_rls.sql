-- ============================================================
-- Migration: 20260403_fix_notification_tables_rls.sql
-- 1. 收緊 notification_templates / delivery_logs / due_date_reminders RLS
-- 2. approval_requests.rule_id 加 ON DELETE CASCADE
-- 3. external_account_bindings.member_id 加 FK → members(id) ON DELETE CASCADE
-- 4. external_action_logs.binding_id 改為 ON DELETE SET NULL
-- ============================================================

-- ── 1. notification_templates RLS ─────────────────────────────
-- 所有人可讀；INSERT/UPDATE/DELETE 只有 created_by 本人或管理員

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
      created_by = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.members
        WHERE email = auth.email() AND role = 'admin'
      )
    )
  );

CREATE POLICY "ntpl_update" ON public.notification_templates
  FOR UPDATE USING (
    created_by = auth.uid()::text
    OR EXISTS (
      SELECT 1 FROM public.members
      WHERE email = auth.email() AND role = 'admin'
    )
  );

CREATE POLICY "ntpl_delete" ON public.notification_templates
  FOR DELETE USING (
    created_by = auth.uid()::text
    OR EXISTS (
      SELECT 1 FROM public.members
      WHERE email = auth.email() AND role = 'admin'
    )
  );

-- ── 2. notification_delivery_logs RLS ─────────────────────────
-- 所有人可讀（審計日誌）；INSERT 系統寫入（service_role bypass RLS）；UPDATE/DELETE 禁止

DROP POLICY IF EXISTS "ndlog_all"    ON public.notification_delivery_logs;
DROP POLICY IF EXISTS "ndlog_select" ON public.notification_delivery_logs;
DROP POLICY IF EXISTS "ndlog_insert" ON public.notification_delivery_logs;

CREATE POLICY "ndlog_select" ON public.notification_delivery_logs
  FOR SELECT USING (true);

CREATE POLICY "ndlog_insert" ON public.notification_delivery_logs
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- ── 3. due_date_reminders RLS ──────────────────────────────────
-- 所有人可讀；INSERT 系統寫入；UPDATE/DELETE 禁止

DROP POLICY IF EXISTS "ddr_all"    ON public.due_date_reminders;
DROP POLICY IF EXISTS "ddr_select" ON public.due_date_reminders;
DROP POLICY IF EXISTS "ddr_insert" ON public.due_date_reminders;

CREATE POLICY "ddr_select" ON public.due_date_reminders
  FOR SELECT USING (true);

CREATE POLICY "ddr_insert" ON public.due_date_reminders
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

-- ── 4. approval_requests.rule_id → ON DELETE CASCADE ──────────
-- 先刪除舊 FK constraint（名稱可能為 approval_requests_rule_id_fkey）
DO $$
DECLARE
  _constraint text;
BEGIN
  SELECT conname INTO _constraint
    FROM pg_constraint
   WHERE conrelid = 'public.approval_requests'::regclass
     AND contype = 'f'
     AND conkey @> ARRAY[
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.approval_requests'::regclass
           AND attname = 'rule_id')
     ];
  IF _constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.approval_requests DROP CONSTRAINT %I', _constraint);
  END IF;
END$$;

ALTER TABLE public.approval_requests
  ADD CONSTRAINT approval_requests_rule_id_fkey
  FOREIGN KEY (rule_id) REFERENCES public.approval_rules(id) ON DELETE CASCADE;

-- ── 5. external_account_bindings.member_id → FK members(id) ON DELETE CASCADE ──
-- 先移除可能存在的舊 FK
DO $$
DECLARE
  _constraint text;
BEGIN
  SELECT conname INTO _constraint
    FROM pg_constraint
   WHERE conrelid = 'public.external_account_bindings'::regclass
     AND contype = 'f'
     AND conkey @> ARRAY[
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.external_account_bindings'::regclass
           AND attname = 'member_id')
     ];
  IF _constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.external_account_bindings DROP CONSTRAINT %I', _constraint);
  END IF;
END$$;

ALTER TABLE public.external_account_bindings
  ADD CONSTRAINT external_account_bindings_member_id_fkey
  FOREIGN KEY (member_id) REFERENCES public.members(id) ON DELETE CASCADE;

-- ── 6. external_action_logs.binding_id → ON DELETE SET NULL ───
DO $$
DECLARE
  _constraint text;
BEGIN
  SELECT conname INTO _constraint
    FROM pg_constraint
   WHERE conrelid = 'public.external_action_logs'::regclass
     AND contype = 'f'
     AND conkey @> ARRAY[
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.external_action_logs'::regclass
           AND attname = 'binding_id')
     ];
  IF _constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.external_action_logs DROP CONSTRAINT %I', _constraint);
  END IF;
END$$;

ALTER TABLE public.external_action_logs
  ADD CONSTRAINT external_action_logs_binding_id_fkey
  FOREIGN KEY (binding_id) REFERENCES public.external_account_bindings(id) ON DELETE SET NULL;
