-- Create storage bucket for backups (idempotent: safe to re-run)
INSERT INTO storage.buckets (id, name, public) VALUES ('backups', 'backups', false)
ON CONFLICT (id) DO NOTHING;

-- RLS for backups bucket: only authenticated users can read
-- (DROP IF EXISTS + CREATE keeps re-runs from failing on duplicate policies)
DROP POLICY IF EXISTS "Authenticated users can read backups" ON storage.objects;
CREATE POLICY "Authenticated users can read backups" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'backups');
DROP POLICY IF EXISTS "Service role can insert backups" ON storage.objects;
CREATE POLICY "Service role can insert backups" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'backups');

-- Create backup settings table
CREATE TABLE IF NOT EXISTS public.backup_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled boolean NOT NULL DEFAULT false,
  interval_days integer NOT NULL DEFAULT 7,
  backup_hour integer NOT NULL DEFAULT 3,
  notify_email text NOT NULL DEFAULT '',
  last_backup_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.backup_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read backup_settings" ON public.backup_settings;
CREATE POLICY "Authenticated read backup_settings" ON public.backup_settings FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated write backup_settings" ON public.backup_settings;
CREATE POLICY "Authenticated write backup_settings" ON public.backup_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Insert default settings row (only when none exists yet — no unique key on
-- this table, so a bare INSERT would duplicate the row on re-run)
INSERT INTO public.backup_settings (enabled, interval_days, backup_hour)
SELECT false, 7, 3
WHERE NOT EXISTS (SELECT 1 FROM public.backup_settings);

-- Create backup history table
CREATE TABLE IF NOT EXISTS public.backup_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  file_size bigint NOT NULL DEFAULT 0,
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.backup_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read backup_history" ON public.backup_history;
CREATE POLICY "Authenticated read backup_history" ON public.backup_history FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Authenticated write backup_history" ON public.backup_history;
CREATE POLICY "Authenticated write backup_history" ON public.backup_history FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Enable pg_cron and pg_net extensions
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
