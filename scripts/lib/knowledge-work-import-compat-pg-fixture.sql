-- Synthetic dependencies not provided by the historical workflow runner.
-- The actual Phase5 knowledge SQL and import maintenance SQL are tested together.
CREATE TABLE public.task_attachments(id text PRIMARY KEY,task_id text REFERENCES public.tasks(id),file_name text);
CREATE FUNCTION public.livo_jira_clear_tasks() RETURNS jsonb LANGUAGE sql AS $$SELECT '{"cleared":true}'::jsonb$$;
