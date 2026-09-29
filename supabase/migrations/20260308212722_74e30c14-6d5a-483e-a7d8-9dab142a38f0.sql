
-- Fix the changed_at default format: "T" must be quoted to prevent TH being parsed as ordinal suffix
ALTER TABLE status_logs ALTER COLUMN changed_at SET DEFAULT to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

-- Also fix the same issue on comments.created_at if it has the same pattern
-- Check and fix existing malformed status_log timestamps
UPDATE status_logs SET 
  changed_at = regexp_replace(changed_at, 'THH24:', 'T00:', 'g')
WHERE changed_at LIKE '%THH24%';
