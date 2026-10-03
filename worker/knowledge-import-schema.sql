-- Merge verbatim into schema.sql. Every table is server-only (clientAccess:'none').
CREATE TABLE IF NOT EXISTS knowledge_import_policy (
  workspace_id TEXT PRIMARY KEY DEFAULT 'default',version INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL CHECK(json_valid(data)),updated_by TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_import_jobs (
  id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL DEFAULT 'default',actor_id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),expires_at TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_actor ON knowledge_import_jobs(workspace_id,actor_id,created_at DESC);
CREATE TABLE IF NOT EXISTS knowledge_import_sources (
  id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL DEFAULT 'default',page_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,job_id TEXT NOT NULL,item_id TEXT NOT NULL,
  source_key TEXT NOT NULL,source_hash TEXT NOT NULL,version INTEGER NOT NULL,original TEXT NOT NULL CHECK(json_valid(original)),assets TEXT NOT NULL CHECK(json_valid(assets)),created_by TEXT NOT NULL,created_at TEXT NOT NULL,
  UNIQUE(workspace_id,job_id,item_id),FOREIGN KEY(workspace_id,page_id) REFERENCES kb_pages(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(snapshot_id) REFERENCES kb_source_snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_import_sources_page ON knowledge_import_sources(workspace_id,page_id,source_key,version DESC);
