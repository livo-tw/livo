-- Restore missing "完成" and "不做了" statuses if they were deleted
-- These are terminal statuses (is_done=true) required for task completion tracking

INSERT INTO public.statuses (id, name, color, sort_order, is_done, auto_start, auto_done)
VALUES
  ('s6', '完成',   '#36B37E', 6, true, false, true),
  ('s7', '不做了', '#97A0AF', 7, true, false, true)
ON CONFLICT (id) DO NOTHING;
