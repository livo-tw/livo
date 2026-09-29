-- Migration: 20260404_clear_stale_auth_ids
-- Description: Clear auth_id on all members so auth-to-member links are re-established
-- correctly based on email matching. This fixes the recurring issue where
-- jianhong@livo.test was linked to the wrong member (林佳蓉 instead of 王建宏)
-- because a stale auth_id binding from before the member data correction persisted.

UPDATE members SET auth_id = NULL;
