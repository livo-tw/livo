-- ============================================================
-- Fix RLS Permissions & Integrity Constraints
-- 20260402_fix_rls_permissions.sql
--
-- Fixes:
--   #3  notification_rules / external_account_bindings /
--       external_action_logs RLS 过于宽松
--   #4  approval_rules from_status/to_status 无外键约束
--   #5  approval_rule_steps.approver_user_id 无 FK 约束
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- #3a  notification_rules — 限制为 created_by 本人可见/修改
-- ────────────────────────────────────────────────────────────

-- notification_rules 原表无 created_by 栏位，先补上
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name  = 'notification_rules'
      AND column_name = 'created_by'
  ) THEN
    ALTER TABLE public.notification_rules ADD COLUMN created_by TEXT;
  END IF;
END $$;

-- 移除旧的宽松 policy
DROP POLICY IF EXISTS "nrul_all" ON public.notification_rules;

-- SELECT / UPDATE / DELETE：只能操作自己建立的规则
DROP POLICY IF EXISTS "nrul_select" ON public.notification_rules;
CREATE POLICY "nrul_select" ON public.notification_rules
  FOR SELECT TO authenticated
  USING (created_by = auth.uid()::text);

DROP POLICY IF EXISTS "nrul_insert" ON public.notification_rules;
CREATE POLICY "nrul_insert" ON public.notification_rules
  FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid()::text);

DROP POLICY IF EXISTS "nrul_update" ON public.notification_rules;
CREATE POLICY "nrul_update" ON public.notification_rules
  FOR UPDATE TO authenticated
  USING  (created_by = auth.uid()::text)
  WITH CHECK (created_by = auth.uid()::text);

DROP POLICY IF EXISTS "nrul_delete" ON public.notification_rules;
CREATE POLICY "nrul_delete" ON public.notification_rules
  FOR DELETE TO authenticated
  USING (created_by = auth.uid()::text);

-- ────────────────────────────────────────────────────────────
-- #3b  external_account_bindings — 限制为 member_id 本人
-- ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "authenticated_all_external_bindings" ON external_account_bindings;

DROP POLICY IF EXISTS "eab_select" ON external_account_bindings;
CREATE POLICY "eab_select" ON external_account_bindings
  FOR SELECT TO authenticated
  USING (member_id = auth.uid()::text);

DROP POLICY IF EXISTS "eab_insert" ON external_account_bindings;
CREATE POLICY "eab_insert" ON external_account_bindings
  FOR INSERT TO authenticated
  WITH CHECK (member_id = auth.uid()::text);

DROP POLICY IF EXISTS "eab_update" ON external_account_bindings;
CREATE POLICY "eab_update" ON external_account_bindings
  FOR UPDATE TO authenticated
  USING  (member_id = auth.uid()::text)
  WITH CHECK (member_id = auth.uid()::text);

DROP POLICY IF EXISTS "eab_delete" ON external_account_bindings;
CREATE POLICY "eab_delete" ON external_account_bindings
  FOR DELETE TO authenticated
  USING (member_id = auth.uid()::text);

-- ────────────────────────────────────────────────────────────
-- #3c  external_action_logs
--       SELECT 团队可见，INSERT 限制为操作者本人，禁止 UPDATE/DELETE
-- ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "authenticated_all_external_action_logs" ON external_action_logs;

DROP POLICY IF EXISTS "eal_select" ON external_action_logs;
CREATE POLICY "eal_select" ON external_action_logs
  FOR SELECT TO authenticated
  USING (true);                        -- 审计日志团队可见

DROP POLICY IF EXISTS "eal_insert" ON external_action_logs;
CREATE POLICY "eal_insert" ON external_action_logs
  FOR INSERT TO authenticated
  WITH CHECK (member_id = auth.uid()::text);

-- UPDATE / DELETE 不建立 policy → 所有人都无法执行（审计日志不可篡改）

-- ────────────────────────────────────────────────────────────
-- #4  approval_rules.from_status / to_status 外键约束
--
-- statuses 表以 name 作为人类可读键，但无唯一约束。
-- 先在 statuses.name 上加唯一索引，再建 FK。
-- 注意：若现有数据中 statuses.name 有重复，此步骤会失败；
--       届时需先清理重复数据再执行。
-- ────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS uq_statuses_name
  ON public.statuses(name);

-- from_status FK
ALTER TABLE public.approval_rules
  DROP CONSTRAINT IF EXISTS fk_approval_rules_from_status;
ALTER TABLE public.approval_rules
  ADD CONSTRAINT fk_approval_rules_from_status
  FOREIGN KEY (from_status) REFERENCES public.statuses(name)
  ON DELETE CASCADE;

-- to_status FK
ALTER TABLE public.approval_rules
  DROP CONSTRAINT IF EXISTS fk_approval_rules_to_status;
ALTER TABLE public.approval_rules
  ADD CONSTRAINT fk_approval_rules_to_status
  FOREIGN KEY (to_status) REFERENCES public.statuses(name)
  ON DELETE CASCADE;

-- ────────────────────────────────────────────────────────────
-- #5  approval_rule_steps.approver_user_id → members(id)
--     ON DELETE SET NULL（approver_type='role' 时此栏可为 NULL）
-- ────────────────────────────────────────────────────────────

ALTER TABLE public.approval_rule_steps
  DROP CONSTRAINT IF EXISTS fk_approval_steps_approver_user;
ALTER TABLE public.approval_rule_steps
  ADD CONSTRAINT fk_approval_steps_approver_user
  FOREIGN KEY (approver_user_id) REFERENCES public.members(id)
  ON DELETE SET NULL;
