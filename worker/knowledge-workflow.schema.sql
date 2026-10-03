-- Canonical fragment merged into worker/schema.sql by the integration task.
CREATE TABLE IF NOT EXISTS kb_source_snapshots (
  workspace_id TEXT NOT NULL DEFAULT 'default', id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES kb_pages(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL, source_title TEXT NOT NULL, source_url TEXT, source_key TEXT, source_version TEXT,
  body TEXT NOT NULL, body_hash TEXT NOT NULL, page_version INTEGER NOT NULL, provenance TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kb_snapshot_page ON kb_source_snapshots(workspace_id,page_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS kb_snapshot_identity ON kb_source_snapshots(workspace_id,page_id,body_hash,source_kind,COALESCE(source_key,''));
CREATE TRIGGER IF NOT EXISTS kb_snapshot_immutable BEFORE UPDATE ON kb_source_snapshots BEGIN SELECT RAISE(ABORT,'kb_workflow_immutable'); END;
CREATE TABLE IF NOT EXISTS kb_checklist_items (
  workspace_id TEXT NOT NULL DEFAULT 'default', id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES kb_pages(id) ON DELETE CASCADE,
  anchor_id TEXT NOT NULL, text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 2000), is_done INTEGER NOT NULL DEFAULT 0 CHECK(is_done IN(0,1)),
  version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  completed_by TEXT, completed_at TEXT, UNIQUE(workspace_id,page_id,anchor_id)
);
CREATE TABLE IF NOT EXISTS kb_work_links (
  workspace_id TEXT NOT NULL DEFAULT 'default', id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES kb_pages(id) ON DELETE CASCADE,
  anchor_id TEXT NOT NULL, checklist_id TEXT REFERENCES kb_checklist_items(id) ON DELETE RESTRICT,
  snapshot_id TEXT REFERENCES kb_source_snapshots(id) ON DELETE RESTRICT,
  target_kind TEXT NOT NULL CHECK(target_kind IN('task','qa')), target_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN('reference','meeting','decision','verification')), created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(workspace_id,page_id,anchor_id,target_kind,target_id), UNIQUE(workspace_id,checklist_id)
);
CREATE INDEX IF NOT EXISTS kb_link_target ON kb_work_links(workspace_id,target_kind,target_id);
CREATE INDEX IF NOT EXISTS kb_link_page ON kb_work_links(workspace_id,page_id);
CREATE TABLE IF NOT EXISTS kb_workflow_commands (
  workspace_id TEXT NOT NULL DEFAULT 'default', id TEXT NOT NULL, actor_id TEXT NOT NULL, page_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, result_json TEXT NOT NULL, allowed INTEGER NOT NULL CHECK(allowed=1), created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
);
-- Preserve existing keys; reject only new collisions, including legacy clients.
DROP TRIGGER IF EXISTS kb_task_key_insert;
CREATE TRIGGER kb_task_key_insert BEFORE INSERT ON tasks WHEN EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND task_key=NEW.task_key AND id<>NEW.id)
BEGIN SELECT RAISE(ABORT,'kb_workflow_task_key_conflict'); END;
CREATE TRIGGER IF NOT EXISTS kb_task_key_update BEFORE UPDATE OF task_key ON tasks WHEN OLD.task_key<>NEW.task_key AND EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND task_key=NEW.task_key AND id<>NEW.id)
BEGIN SELECT RAISE(ABORT,'kb_workflow_task_key_conflict'); END;
