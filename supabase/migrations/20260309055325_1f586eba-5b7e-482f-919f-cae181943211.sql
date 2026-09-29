
CREATE TABLE public.task_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id text NOT NULL,
  file_name text NOT NULL,
  file_size bigint NOT NULL DEFAULT 0,
  file_type text NOT NULL DEFAULT '',
  storage_path text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  uploaded_by text NOT NULL DEFAULT ''
);

ALTER TABLE public.task_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all read task_attachments" ON public.task_attachments FOR SELECT USING (true);
CREATE POLICY "Allow all write task_attachments" ON public.task_attachments FOR ALL USING (true) WITH CHECK (true);
