-- 修正 Storage DELETE 策略過寬：限制只有上傳者（owner）或管理員可刪除

-- 移除原有的完全開放刪除策略
DROP POLICY IF EXISTS "Anyone can delete task images" ON storage.objects;

-- 新增限制性刪除策略：只有上傳者或 admin 角色成員可刪除
CREATE POLICY "Owner or admin can delete task images" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'task-images'
    AND (
      -- 上傳者（Supabase Storage 自動記錄 owner = auth.uid()）
      owner = auth.uid()
      OR
      -- 管理員（透過 members 表比對 email）
      EXISTS (
        SELECT 1 FROM public.members
        WHERE email = auth.email()
          AND role = 'admin'
      )
    )
  );
