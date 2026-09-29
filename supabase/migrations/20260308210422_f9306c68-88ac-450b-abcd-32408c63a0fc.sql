UPDATE public.tasks SET sprint_id = NULL WHERE sprint_id IS NOT NULL;
DELETE FROM public.sprints;