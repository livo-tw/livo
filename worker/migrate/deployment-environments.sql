-- Run as one D1 file/batch after tenancy is complete and before schema.sql.
-- Copy every existing column unchanged; only the fixed environment CHECK goes.
-- The runner probes sqlite_master and skips this rebuild once the CHECK is gone.
-- A failed atomic batch rolls back both the copy and the table swap.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE task_deployments_environment_upgrade (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('deployed','scheduled')),
  deploy_date TEXT
);
INSERT INTO task_deployments_environment_upgrade(workspace_id,id,task_id,environment,status,deploy_date)
  SELECT workspace_id,id,task_id,environment,status,deploy_date FROM task_deployments;
DROP TABLE task_deployments;
ALTER TABLE task_deployments_environment_upgrade RENAME TO task_deployments;
CREATE INDEX IF NOT EXISTS idx_task_deployments_task ON task_deployments(task_id);
PRAGMA defer_foreign_keys=OFF;
