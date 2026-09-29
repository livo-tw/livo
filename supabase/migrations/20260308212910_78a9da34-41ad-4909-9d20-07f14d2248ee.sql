
CREATE TABLE public.task_todos (
  id text NOT NULL PRIMARY KEY,
  task_id text NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  text text NOT NULL,
  is_done boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0
);

ALTER TABLE public.task_todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all read" ON public.task_todos FOR SELECT USING (true);
CREATE POLICY "Allow all write" ON public.task_todos FOR ALL USING (true) WITH CHECK (true);
