CREATE TABLE public.sprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_count integer NOT NULL DEFAULT 0,
  pending_count integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);

ALTER TABLE public.sprints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all read" ON public.sprints FOR SELECT USING (true);
CREATE POLICY "Allow all write" ON public.sprints FOR ALL USING (true) WITH CHECK (true);