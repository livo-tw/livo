-- ============================================================================
-- Migration: rename legacy demo member ids (u-xxx → m-xxx)
-- ============================================================================
-- The original migration renamed the ids of an early demo dataset. A new
-- install has no such rows, so this file is intentionally a no-op
-- (scripts/build-release.mjs also leaves it out of the merged schema). It is
-- kept so migration history stays in order.
SELECT 1;
