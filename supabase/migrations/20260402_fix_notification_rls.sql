-- 修正 notifications INSERT 策略：驗證 sender_id 必須對應當前登入用戶的 member_id
-- 目前 "Authenticated write" FOR ALL 策略允許任意填入 sender_id，存在偽造風險

-- 移除現有的寬鬆 ALL 策略
DROP POLICY IF EXISTS "Allow all write" ON public.notifications;
DROP POLICY IF EXISTS "Authenticated write" ON public.notifications;

-- INSERT：sender_id 必須對應當前認證用戶在 members 表中的 id
CREATE POLICY "notifications_insert" ON public.notifications
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_id IN (
      SELECT id FROM public.members WHERE email = auth.email()
    )
  );

-- UPDATE：認證用戶可更新通知（例如標記為已讀）
CREATE POLICY "notifications_update" ON public.notifications
  FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (true);

-- DELETE：認證用戶可刪除通知
CREATE POLICY "notifications_delete" ON public.notifications
  FOR DELETE TO authenticated
  USING (true);
