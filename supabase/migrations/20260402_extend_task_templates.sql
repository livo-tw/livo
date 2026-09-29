-- Extend task_templates to support checklist and todo items

-- Add columns for default checklist and todo items
ALTER TABLE task_templates
ADD COLUMN IF NOT EXISTS default_check_items JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS default_todo_items JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Add comment to explain the new columns
COMMENT ON COLUMN task_templates.default_check_items IS 'Array of default checklist item texts, e.g., ["Check 1", "Check 2"]';
COMMENT ON COLUMN task_templates.default_todo_items IS 'Array of default todo item texts, e.g., ["Todo 1", "Todo 2"]';
