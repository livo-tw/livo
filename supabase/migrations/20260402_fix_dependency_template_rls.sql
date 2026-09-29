-- 修正 task_templates 和 task_dependencies RLS：加入操作者身份驗證

-- ============================================================
-- task_templates：INSERT 驗證 created_by；UPDATE/DELETE 限創建者或 admin
-- ============================================================

DROP POLICY IF EXISTS "task_templates_insert" ON task_templates;
DROP POLICY IF EXISTS "task_templates_update" ON task_templates;
DROP POLICY IF EXISTS "task_templates_delete" ON task_templates;

-- INSERT：created_by 必須對應當前登入用戶的 member id
CREATE POLICY "task_templates_insert" ON task_templates
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by IN (
      SELECT id FROM public.members WHERE email = auth.email()
    )
  );

-- UPDATE：只有創建者或 admin 可修改
CREATE POLICY "task_templates_update" ON task_templates
  FOR UPDATE TO authenticated
  USING (
    created_by IN (SELECT id FROM public.members WHERE email = auth.email())
    OR EXISTS (SELECT 1 FROM public.members WHERE email = auth.email() AND role = 'admin')
  )
  WITH CHECK (true);

-- DELETE：只有創建者或 admin 可刪除
CREATE POLICY "task_templates_delete" ON task_templates
  FOR DELETE TO authenticated
  USING (
    created_by IN (SELECT id FROM public.members WHERE email = auth.email())
    OR EXISTS (SELECT 1 FROM public.members WHERE email = auth.email() AND role = 'admin')
  );

-- ============================================================
-- task_dependencies：INSERT/DELETE 驗證操作者與任務的關聯
-- （task_id 任務的創建者、經辦人，或 admin 才可操作）
-- ============================================================

DROP POLICY IF EXISTS "task_dependencies_insert" ON task_dependencies;
DROP POLICY IF EXISTS "task_dependencies_delete" ON task_dependencies;

-- INSERT：操作者必須是 task_id 任務的創建者／經辦人，或 admin
CREATE POLICY "task_dependencies_insert" ON task_dependencies
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.tasks t
      JOIN public.members m ON m.email = auth.email()
      WHERE t.id = task_id
        AND (t.creator_id = m.id OR t.assignee_id = m.id OR m.role = 'admin')
    )
  );

-- DELETE：同上
CREATE POLICY "task_dependencies_delete" ON task_dependencies
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.tasks t
      JOIN public.members m ON m.email = auth.email()
      WHERE t.id = task_id
        AND (t.creator_id = m.id OR t.assignee_id = m.id OR m.role = 'admin')
    )
  );
