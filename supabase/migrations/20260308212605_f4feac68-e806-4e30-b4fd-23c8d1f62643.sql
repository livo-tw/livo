
-- Clean up false-positive strikethrough tags from Jira import
-- The import's -text- regex incorrectly wrapped URL fragments, filenames, and codes in <s> tags
-- Strategy: Remove <s> tags where content contains NO CJK characters (these are false positives)
-- Legitimate strikethrough always wraps Chinese text

-- Fix requirement field
UPDATE task_specs SET 
  requirement = regexp_replace(requirement, '<s>([^<]*?)</s>', '\1', 'g')
WHERE requirement ~ '<s>[^<]*</s>'
  AND requirement !~ '<s>[^<]*[\u4e00-\u9fff]';

-- For rows with mixed legitimate and false <s> tags, do targeted cleanup:
-- Remove <s> tags around purely ASCII content (no CJK chars between tags)
UPDATE task_specs SET 
  requirement = regexp_replace(
    requirement, 
    '<s>([a-zA-Z0-9_./:?=&%+@#~,; -]{1,200})</s>', 
    '\1', 
    'g'
  )
WHERE requirement ~ '<s>[a-zA-Z0-9_./:?=&%+@#~,; -]{1,200}</s>';

-- Same for background and notes
UPDATE task_specs SET 
  background = regexp_replace(background, '<s>([a-zA-Z0-9_./:?=&%+@#~,; -]{1,200})</s>', '\1', 'g')
WHERE background ~ '<s>[a-zA-Z0-9_./:?=&%+@#~,; -]{1,200}</s>';

UPDATE task_specs SET 
  notes = regexp_replace(notes, '<s>([a-zA-Z0-9_./:?=&%+@#~,; -]{1,200})</s>', '\1', 'g')
WHERE notes ~ '<s>[a-zA-Z0-9_./:?=&%+@#~,; -]{1,200}</s>';
