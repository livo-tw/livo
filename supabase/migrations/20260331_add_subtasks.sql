-- Add parent_task_id to tasks table for subtask support
-- Only one level of nesting is allowed (enforced at application layer)
-- ON DELETE SET NULL: deleting a parent task orphans its subtasks (they become top-level tasks)

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id text REFERENCES tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tasks_parent_task_id_idx ON tasks(parent_task_id);
