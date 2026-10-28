-- Only applied after PRAGMA probes confirm these columns are absent.
ALTER TABLE statuses ADD COLUMN is_cancelled INTEGER NOT NULL DEFAULT 0 CHECK(is_cancelled IN(0,1) AND (is_cancelled=0 OR is_done=1));
UPDATE statuses SET is_cancelled=1,is_done=1 WHERE id='s7' OR id=substr(workspace_id,1,8)||'-s7';
ALTER TABLE sprints ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0);
ALTER TABLE sprints ADD COLUMN cancelled_count INTEGER CHECK(cancelled_count IS NULL OR cancelled_count>=0);
ALTER TABLE sprints ADD COLUMN history_captured_at TEXT;
