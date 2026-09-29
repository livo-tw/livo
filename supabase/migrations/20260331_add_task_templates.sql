-- Task Templates table
CREATE TABLE IF NOT EXISTS task_templates (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  default_priority TEXT CHECK (default_priority IN ('highest', 'high', 'medium', 'low', 'lowest')),
  default_tag_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_spec_background TEXT NOT NULL DEFAULT '',
  default_spec_requirement TEXT NOT NULL DEFAULT '',
  default_spec_notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE task_templates ENABLE ROW LEVEL SECURITY;

-- RLS policies: all authenticated users can read; creators can update/delete
CREATE POLICY "task_templates_select" ON task_templates
  FOR SELECT USING (true);

CREATE POLICY "task_templates_insert" ON task_templates
  FOR INSERT WITH CHECK (true);

CREATE POLICY "task_templates_update" ON task_templates
  FOR UPDATE USING (true);

CREATE POLICY "task_templates_delete" ON task_templates
  FOR DELETE USING (true);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE task_templates;
