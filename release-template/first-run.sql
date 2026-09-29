-- ============================================================
-- LIVO 首次安裝初始化（first-run.sql）
--
-- install.sh / install.bat（installer/install.ps1）會在建立完資料庫結構
-- 後，自動套用本檔。完全幂等（ON CONFLICT DO NOTHING），可安全重複執行。
--
-- 用途：補齊「完整預設狀態」s1–s7。
--   舊的 migration 只保證 s6/s7（完成、不做了）存在；若缺 s1–s5，第一個
--   建立的任務會直接落在「完成」欄，體驗很怪。這裡把 7 個狀態一次補齊，
--   數值對齊 App 內建預設（src/integrations/supabase/mockClient.ts 的 statuses）。
--
-- 備註：交付包不會預載任何示範成員 / 示範任務——這是在打包階段
--   （scripts/build-release.mjs）就從 schema 移除的，不需要在這裡再刪。
-- ============================================================

INSERT INTO public.statuses (id, name, color, sort_order, is_done, auto_start, auto_done) VALUES
  ('s1', '待辦',       '#6B778C', 1, false, false, false),
  ('s2', '正在進行',   '#0065FF', 2, false, true,  false),
  ('s3', '待驗收',     '#FF8B00', 3, false, false, false),
  ('s4', '待討論確認', '#6554C0', 4, false, false, false),
  ('s5', '等待部署',   '#00B8D9', 5, false, false, false),
  ('s6', '完成',       '#36B37E', 6, true,  false, true),
  ('s7', '不做了',     '#97A0AF', 7, true,  false, true)
ON CONFLICT (id) DO NOTHING;
