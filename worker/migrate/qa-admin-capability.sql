-- Additive only: never rebuild the members parent or trigger FK cascades.
-- schema-upgrades.mjs probes this column before each execution.
ALTER TABLE members ADD COLUMN is_qa_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_qa_admin IN (0,1));
