ALTER TABLE public.comments ADD COLUMN attachment_url text DEFAULT NULL;
ALTER TABLE public.comments ADD COLUMN attachment_name text DEFAULT NULL;
ALTER TABLE public.comments ADD COLUMN attachment_size bigint DEFAULT 0;