-- Migration: 自訂欄位功能
-- 建立 custom_fields 和 task_custom_field_values 兩張表

-- 1. custom_fields：存欄位定義（專案層級）
CREATE TABLE IF NOT EXISTS public.custom_fields (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  field_type TEXT NOT NULL CHECK (field_type IN ('text', 'textarea', 'number', 'select', 'date', 'boolean', 'user')),
  options JSONB DEFAULT NULL,       -- 下拉選單的選項陣列 ["選項A","選項B",...]
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  default_value TEXT DEFAULT NULL,  -- 統一存文字，前端依 field_type 轉換
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. task_custom_field_values：存任務的欄位值（task × field）
CREATE TABLE IF NOT EXISTS public.task_custom_field_values (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES public.custom_fields(id) ON DELETE CASCADE,
  value_text TEXT DEFAULT NULL,
  value_number NUMERIC DEFAULT NULL,
  value_date DATE DEFAULT NULL,
  value_boolean BOOLEAN DEFAULT NULL,
  value_user_id TEXT DEFAULT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, field_id)
);

-- 3. RLS（與現有模式一致：authenticated 可讀寫）
ALTER TABLE public.custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_custom_field_values ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read custom_fields"
  ON public.custom_fields FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write custom_fields"
  ON public.custom_fields FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read task_custom_field_values"
  ON public.task_custom_field_values FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write task_custom_field_values"
  ON public.task_custom_field_values FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 4. 開啟 Realtime（配合 AppContext 訂閱）
ALTER PUBLICATION supabase_realtime ADD TABLE public.custom_fields;
ALTER PUBLICATION supabase_realtime ADD TABLE public.task_custom_field_values;

-- 5. Index 加速查詢
CREATE INDEX IF NOT EXISTS idx_custom_fields_project_id ON public.custom_fields(project_id);
CREATE INDEX IF NOT EXISTS idx_task_custom_field_values_task_id ON public.task_custom_field_values(task_id);
CREATE INDEX IF NOT EXISTS idx_task_custom_field_values_field_id ON public.task_custom_field_values(field_id);
