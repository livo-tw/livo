-- Migration: 20260404_approval_requests_nullable_rule
-- Description: Make rule_id nullable in approval_requests so that tasks with
-- requiresApproval=true can create approval requests even without a matching rule.

ALTER TABLE approval_requests ALTER COLUMN rule_id DROP NOT NULL;
