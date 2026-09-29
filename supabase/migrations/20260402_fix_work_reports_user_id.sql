-- Fix work_reports.user_id: change from UUID to TEXT
-- members.id is TEXT-based (e.g. 'm-xxx'), not UUID format.
-- The original migration incorrectly used UUID type, causing all inserts to fail.

ALTER TABLE work_reports ALTER COLUMN user_id TYPE TEXT;
