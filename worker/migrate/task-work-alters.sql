-- Run only after all six fields are confirmed absent by the upgrade probe.
ALTER TABLE tasks ADD COLUMN assignee_revision INTEGER NOT NULL DEFAULT 0 CHECK(assignee_revision>=0);
ALTER TABLE tasks ADD COLUMN reviewer_revision INTEGER NOT NULL DEFAULT 0 CHECK(reviewer_revision>=0);
ALTER TABLE tasks ADD COLUMN assignee_acknowledged_at TEXT;
ALTER TABLE tasks ADD COLUMN reviewer_acknowledged_at TEXT;
ALTER TABLE task_checks ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0);
ALTER TABLE task_todos ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0);
