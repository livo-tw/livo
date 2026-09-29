-- Add requires_approval flag to tasks table
-- When true, status transitions for this task will go through the approval workflow
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT false;
