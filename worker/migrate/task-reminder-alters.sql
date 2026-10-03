-- Applied once after probing all four columns; partial upgrades fail closed.
ALTER TABLE tasks ADD COLUMN due_date_kind TEXT CHECK(due_date_kind IS NULL OR due_date_kind IN ('estimated','committed'));
ALTER TABLE tasks ADD COLUMN due_date_version INTEGER NOT NULL DEFAULT 0 CHECK(due_date_version>=0);
ALTER TABLE tasks ADD COLUMN due_date_change_reason TEXT;
ALTER TABLE tasks ADD COLUMN due_date_changed_by TEXT;
