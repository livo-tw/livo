-- Task Dependencies table
-- Stores finish-to-start dependency relationships between tasks
CREATE TABLE IF NOT EXISTS task_dependencies (
  id TEXT PRIMARY KEY DEFAULT ('td_' || extract(epoch from now())::bigint || '_' || substr(md5(random()::text), 1, 6)),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL DEFAULT 'finish_to_start',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Prevent duplicate dependencies
  CONSTRAINT uq_task_dependency UNIQUE (task_id, depends_on_task_id),

  -- Prevent self-dependency
  CONSTRAINT chk_no_self_dependency CHECK (task_id <> depends_on_task_id)
);

-- Index for querying dependencies by task
CREATE INDEX IF NOT EXISTS idx_task_dependencies_task_id ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);

-- Enable RLS
ALTER TABLE task_dependencies ENABLE ROW LEVEL SECURITY;

-- RLS policies: all authenticated users can read/write (same pattern as other tables)
CREATE POLICY "task_dependencies_select" ON task_dependencies FOR SELECT TO authenticated USING (true);
CREATE POLICY "task_dependencies_insert" ON task_dependencies FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "task_dependencies_delete" ON task_dependencies FOR DELETE TO authenticated USING (true);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE task_dependencies;
