
-- Drop all existing permissive "Allow all" policies and replace with authenticated-only

-- ============ comments ============
DROP POLICY IF EXISTS "Allow all read " ON public.comments;
DROP POLICY IF EXISTS "Allow all write " ON public.comments;
CREATE POLICY "Authenticated read" ON public.comments FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write" ON public.comments FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ member_manuals ============
DROP POLICY IF EXISTS "Allow all read " ON public.member_manuals;
DROP POLICY IF EXISTS "Allow all write " ON public.member_manuals;
CREATE POLICY "Authenticated read" ON public.member_manuals FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write" ON public.member_manuals FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ members ============
DROP POLICY IF EXISTS "Allow all read " ON public.members;
DROP POLICY IF EXISTS "Allow all write " ON public.members;
CREATE POLICY "Authenticated read" ON public.members FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write" ON public.members FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ notifications ============
DROP POLICY IF EXISTS "Allow all read " ON public.notifications;
DROP POLICY IF EXISTS "Allow all write " ON public.notifications;
CREATE POLICY "Authenticated read" ON public.notifications FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write" ON public.notifications FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ product_lines ============
DROP POLICY IF EXISTS "Allow all read " ON public.product_lines;
DROP POLICY IF EXISTS "Allow all write " ON public.product_lines;
CREATE POLICY "Authenticated read" ON public.product_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write" ON public.product_lines FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ projects ============
DROP POLICY IF EXISTS "Allow all read " ON public.projects;
DROP POLICY IF EXISTS "Allow all write " ON public.projects;
CREATE POLICY "Authenticated read" ON public.projects FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write" ON public.projects FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ sprints ============
DROP POLICY IF EXISTS "Allow all read " ON public.sprints;
DROP POLICY IF EXISTS "Allow all write " ON public.sprints;
CREATE POLICY "Authenticated read" ON public.sprints FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write" ON public.sprints FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ status_logs ============
DROP POLICY IF EXISTS "Allow all read " ON public.status_logs;
DROP POLICY IF EXISTS "Allow all write " ON public.status_logs;
CREATE POLICY "Authenticated read" ON public.status_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write" ON public.status_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ statuses ============
DROP POLICY IF EXISTS "Allow all read " ON public.statuses;
DROP POLICY IF EXISTS "Allow all write " ON public.statuses;
CREATE POLICY "Authenticated read" ON public.statuses FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write" ON public.statuses FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ task_checks ============
DROP POLICY IF EXISTS "Allow all read " ON public.task_checks;
DROP POLICY IF EXISTS "Allow all write " ON public.task_checks;
CREATE POLICY "Authenticated read" ON public.task_checks FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write" ON public.task_checks FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ task_deployments ============
DROP POLICY IF EXISTS "Allow all read " ON public.task_deployments;
DROP POLICY IF EXISTS "Allow all write " ON public.task_deployments;
CREATE POLICY "Authenticated read" ON public.task_deployments FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write" ON public.task_deployments FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ task_specs ============
DROP POLICY IF EXISTS "Allow all read " ON public.task_specs;
DROP POLICY IF EXISTS "Allow all write " ON public.task_specs;
CREATE POLICY "Authenticated read" ON public.task_specs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write" ON public.task_specs FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ task_todos ============
DROP POLICY IF EXISTS "Allow all read " ON public.task_todos;
DROP POLICY IF EXISTS "Allow all write " ON public.task_todos;
CREATE POLICY "Authenticated read" ON public.task_todos FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write" ON public.task_todos FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============ tasks ============
DROP POLICY IF EXISTS "Allow all read " ON public.tasks;
DROP POLICY IF EXISTS "Allow all write " ON public.tasks;
CREATE POLICY "Authenticated read" ON public.tasks FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated write" ON public.tasks FOR ALL TO authenticated USING (true) WITH CHECK (true);
