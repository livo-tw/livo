CREATE TABLE public.user_column_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id text NOT NULL,
  view_key text NOT NULL,
  visible_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, view_key)
);

ALTER TABLE public.user_column_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all read user_column_configs" ON public.user_column_configs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow all write user_column_configs" ON public.user_column_configs FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);