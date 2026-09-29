
-- Create priority enum
CREATE TYPE public.task_priority AS ENUM ('highest', 'high', 'medium', 'low', 'lowest');

-- Create deployment environment enum
CREATE TYPE public.deploy_environment AS ENUM ('Dev', 'QA', 'Stage', 'Live Staging', 'Prod');

-- Create deployment status enum
CREATE TYPE public.deploy_status AS ENUM ('deployed', 'scheduled');

-- Create user role enum
CREATE TYPE public.app_member_role AS ENUM ('admin', 'member');

-- Users table (team members, not auth users)
CREATE TABLE public.members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL,
  role app_member_role NOT NULL DEFAULT 'member',
  job_title TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#6B778C',
  email TEXT NOT NULL DEFAULT ''
);

-- Product lines
CREATE TABLE public.product_lines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '📁',
  color TEXT NOT NULL DEFAULT '#6B778C',
  sort_order INT NOT NULL DEFAULT 0
);

-- Projects
CREATE TABLE public.projects (
  id TEXT PRIMARY KEY,
  line_id TEXT NOT NULL REFERENCES public.product_lines(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6B778C',
  is_archived BOOLEAN NOT NULL DEFAULT false
);

-- Statuses
CREATE TABLE public.statuses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6B778C',
  sort_order INT NOT NULL DEFAULT 0,
  is_done BOOLEAN NOT NULL DEFAULT false,
  auto_start BOOLEAN NOT NULL DEFAULT false,
  auto_done BOOLEAN NOT NULL DEFAULT false
);

-- Tasks
CREATE TABLE public.tasks (
  id TEXT PRIMARY KEY,
  task_key TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status_id TEXT NOT NULL REFERENCES public.statuses(id),
  priority task_priority NOT NULL DEFAULT 'medium',
  creator_id TEXT NOT NULL REFERENCES public.members(id),
  assignee_id TEXT REFERENCES public.members(id),
  reviewer_id TEXT REFERENCES public.members(id),
  due_date TEXT,
  started_at TEXT,
  completed_at TEXT,
  gitlab_url TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD'),
  comment_count INT NOT NULL DEFAULT 0
);

-- Task deployments
CREATE TABLE public.task_deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id TEXT NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  environment deploy_environment NOT NULL,
  status deploy_status NOT NULL DEFAULT 'scheduled',
  deploy_date TEXT
);

-- Task specs
CREATE TABLE public.task_specs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  background TEXT NOT NULL DEFAULT '',
  requirement TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);

-- Task checks
CREATE TABLE public.task_checks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  is_done BOOLEAN NOT NULL DEFAULT false,
  sort_order INT NOT NULL DEFAULT 0
);

-- Comments
CREATE TABLE public.comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES public.members(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DDTHH24:MI:SSZ')
);

-- Status logs
CREATE TABLE public.status_logs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  from_status_id TEXT REFERENCES public.statuses(id),
  to_status_id TEXT NOT NULL REFERENCES public.statuses(id),
  changed_by TEXT NOT NULL REFERENCES public.members(id),
  changed_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DDTHH24:MI:SSZ')
);

-- Enable RLS on all tables
ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.status_logs ENABLE ROW LEVEL SECURITY;

-- For now, allow public read/write access (no auth yet)
-- These should be tightened when authentication is added
CREATE POLICY "Allow all read" ON public.members FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow all write" ON public.members FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow all read" ON public.product_lines FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow all write" ON public.product_lines FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow all read" ON public.projects FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow all write" ON public.projects FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow all read" ON public.statuses FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow all write" ON public.statuses FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow all read" ON public.tasks FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow all write" ON public.tasks FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow all read" ON public.task_deployments FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow all write" ON public.task_deployments FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow all read" ON public.task_specs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow all write" ON public.task_specs FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow all read" ON public.task_checks FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow all write" ON public.task_checks FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow all read" ON public.comments FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow all write" ON public.comments FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow all read" ON public.status_logs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allow all write" ON public.status_logs FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
