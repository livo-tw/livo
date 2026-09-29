
CREATE TABLE public.member_manuals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id text NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  best_state text NOT NULL DEFAULT '',
  communication text NOT NULL DEFAULT '',
  difficulty text NOT NULL DEFAULT '',
  landmine text NOT NULL DEFAULT '',
  bonus text NOT NULL DEFAULT '',
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(member_id)
);

ALTER TABLE public.member_manuals ENABLE ROW LEVEL SECURITY;

-- Everyone can read
CREATE POLICY "Allow all read" ON public.member_manuals FOR SELECT USING (true);

-- Everyone can insert/update (app-level check ensures own record only)
CREATE POLICY "Allow all write" ON public.member_manuals FOR ALL USING (true) WITH CHECK (true);
