
ALTER TABLE public.members ADD COLUMN sort_order integer NOT NULL DEFAULT 0;

-- The original migration also set sort_order for the developer's own team
-- members by name. That data step never applies to a new install and has
-- been removed.
