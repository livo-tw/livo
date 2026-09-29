CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id text NOT NULL,
  sender_id text NOT NULL,
  type text NOT NULL, -- 'mention', 'assign', 'review'
  task_id text NOT NULL,
  content text NOT NULL DEFAULT '',
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all read" ON public.notifications FOR SELECT USING (true);
CREATE POLICY "Allow all write" ON public.notifications FOR ALL USING (true) WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;