ALTER TABLE public.task_specs ADD CONSTRAINT task_specs_task_id_unique UNIQUE (task_id);

ALTER PUBLICATION supabase_realtime ADD TABLE public.task_attachments;