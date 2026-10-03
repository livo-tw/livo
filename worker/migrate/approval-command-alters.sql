-- Applied only after PRAGMA confirms these columns are absent. Existing rows remain intact.
ALTER TABLE approval_requests ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0);
ALTER TABLE approval_requests ADD COLUMN steps_snapshot TEXT;
ALTER TABLE approval_requests ADD COLUMN rule_snapshot TEXT;
ALTER TABLE approval_actions ADD COLUMN command_id TEXT;
ALTER TABLE approval_actions ADD COLUMN request_version INTEGER;
