-- Fix notifications with NULL task_id by parsing task key from content field
-- Approach: extract task key pattern (e.g. "CARD-11", "PAY-56") from content,
-- then look up the corresponding task id from the tasks table.

UPDATE notifications n
SET task_id = t.id
FROM tasks t
WHERE n.task_id IS NULL
  AND t.task_key = substring(n.content FROM '([A-Z]+-[0-9]+)');

-- For any remaining notifications that couldn't be matched (fallback: assign random task)
UPDATE notifications n
SET task_id = (SELECT id FROM tasks ORDER BY random() LIMIT 1)
WHERE n.task_id IS NULL;
