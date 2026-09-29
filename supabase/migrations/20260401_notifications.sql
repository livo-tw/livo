-- Notifications table already created in 20260308185150_*.sql
-- This migration adds an index for faster recipient queries and documents extended types.

-- Index for fast per-recipient notification lookup
CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON public.notifications (recipient_id, created_at DESC);

-- Extended notification types (type column is text, no enum constraint):
-- 'assign'         - 被指派為負責人
-- 'review'         - 被指派為驗收人
-- 'mention'        - 在留言或規格中被 @提及
-- 'comment'        - 我參與的任務（負責人/驗收人）有新留言
-- 'status_changed' - 任務狀態變更（通知負責人和驗收人）
-- 'due_soon'       - 任務截止日前 1 天提醒
-- 'system'         - 系統通知（如未知帳號嘗試登入）
