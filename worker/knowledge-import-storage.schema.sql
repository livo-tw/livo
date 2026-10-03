-- Reservations count toward the same workspace usage as normal and QA uploads.
-- Server-only ledger: no client query access and no actor-dependent cleanup.
CREATE TABLE IF NOT EXISTS knowledge_import_files (
  workspace_id TEXT NOT NULL, file_key TEXT NOT NULL, job_id TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes>=0), content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('writing','stored','deleting')),
  operation_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,file_key)
);
CREATE INDEX IF NOT EXISTS idx_import_files_job ON knowledge_import_files(workspace_id,job_id);
CREATE TRIGGER IF NOT EXISTS knowledge_import_files_quota BEFORE INSERT ON knowledge_import_files
WHEN NEW.state='writing' AND NEW.workspace_id!='default'
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM workspaces w WHERE w.id=NEW.workspace_id
    AND w.storage_used_bytes+NEW.bytes+COALESCE((SELECT SUM(expected_size) FROM qa_upload_sessions
      WHERE workspace_id=NEW.workspace_id AND state IN ('initializing','uploading','finalizing','aborting')),0)>w.storage_limit_mb*1048576)
    THEN RAISE(ABORT,'storage_quota_exceeded') END;
END;
CREATE TRIGGER IF NOT EXISTS knowledge_import_files_reserved AFTER INSERT ON knowledge_import_files
BEGIN
  UPDATE workspaces SET storage_used_bytes=storage_used_bytes+NEW.bytes WHERE id=NEW.workspace_id;
END;
CREATE TRIGGER IF NOT EXISTS knowledge_import_files_released AFTER DELETE ON knowledge_import_files
BEGIN
  UPDATE workspaces SET storage_used_bytes=MAX(0,storage_used_bytes-OLD.bytes) WHERE id=OLD.workspace_id;
END;
CREATE TRIGGER IF NOT EXISTS knowledge_import_files_immutable BEFORE UPDATE OF workspace_id,file_key,job_id,bytes,content_hash ON knowledge_import_files
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.file_key IS NOT OLD.file_key OR NEW.job_id IS NOT OLD.job_id
  OR NEW.bytes IS NOT OLD.bytes OR (NEW.content_hash IS NOT OLD.content_hash AND OLD.content_hash!='legacy')
BEGIN SELECT RAISE(ABORT,'storage_identity_immutable'); END;

-- Admission remains closed until historic, unmetered import objects are counted.
CREATE TABLE IF NOT EXISTS knowledge_import_usage_reconciliations (
  workspace_id TEXT PRIMARY KEY, cursor TEXT, version INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)), updated_at TEXT NOT NULL
);
