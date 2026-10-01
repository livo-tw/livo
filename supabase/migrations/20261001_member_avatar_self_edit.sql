-- ============================================================================
-- Migration: 20261001_member_avatar_self_edit.sql
-- Let every member change their own avatar badge (the short text in the
-- round badge) and its colour from 個人設定. Parity with the Cloudflare
-- build's members rule (worker/src/memberProfile.ts).
--
-- Replaces public.livo_members_update_guard() from
-- 20260713_permission_floor.sql. Column rules after this migration:
--   super_admin → any column (unchanged)
--   admin       → theme / auth_id / sort_order on any row (unchanged),
--                 plus avatar / color on their OWN row
--   member      → own row only: theme / auth_id (unchanged), plus avatar /
--                 color
-- A changed avatar must be 1–16 characters and not blank; a changed colour
-- must be #RRGGBB. The RLS row policy (pf_members_update) already lets a
-- member update their own row, so it stays as is.
--
-- Idempotent (CREATE OR REPLACE): part of the merged schema on fresh
-- installs, applied by the installer's upgrade step on existing installs.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.livo_members_update_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions
AS $livo_guard$
DECLARE
  jwt_role    text;
  caller_uid  uuid;
  caller_role text;
  is_own_row  boolean;
BEGIN
  -- service_role / maintenance exemption (Edge Functions bypass RLS but NOT
  -- triggers; psql, the installer and GoTrue cascades carry no JWT at all).
  jwt_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  );
  caller_uid := auth.uid();
  IF jwt_role = 'service_role' OR caller_uid IS NULL THEN
    RETURN NEW;
  END IF;

  caller_role := public.current_member_role();

  IF caller_role = 'super_admin' THEN
    RETURN NEW;
  END IF;

  -- The caller's own row; for a JWT not linked to a member yet (first-login
  -- email claim, current_member_role() is NULL) the row bearing their email.
  is_own_row :=
       (OLD.auth_id IS NOT NULL AND OLD.auth_id = caller_uid)
    OR (OLD.id = public.current_member_id())
    OR (auth.email() IS NOT NULL AND OLD.email = auth.email()
        AND (OLD.auth_id IS NULL OR OLD.auth_id = caller_uid));

  -- Avatar badge: own row only, whatever the role, and well-formed.
  IF NEW.avatar IS DISTINCT FROM OLD.avatar OR NEW.color IS DISTINCT FROM OLD.color THEN
    IF NOT is_own_row THEN
      RAISE EXCEPTION '權限不足：頭像與顏色只能由本人修改'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.avatar IS DISTINCT FROM OLD.avatar
       AND (btrim(COALESCE(NEW.avatar, '')) = '' OR char_length(NEW.avatar) > 16) THEN
      RAISE EXCEPTION '頭像文字需為 1 到 16 個字元'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.color IS DISTINCT FROM OLD.color
       AND COALESCE(NEW.color, '') !~ '^#[0-9A-Fa-f]{6}$' THEN
      RAISE EXCEPTION '顏色格式需為 #RRGGBB'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF caller_role = 'admin' THEN
    -- Everything except theme / auth_id / sort_order (and the own badge,
    -- checked above) must be unchanged.
    IF (to_jsonb(NEW) - ARRAY['theme', 'auth_id', 'sort_order', 'avatar', 'color'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['theme', 'auth_id', 'sort_order', 'avatar', 'color']) THEN
      RAISE EXCEPTION '權限不足：管理員僅能調整成員的排序、佈景主題與登入綁定，其他欄位（如角色、姓名）需由超級管理員修改'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- member, or an authenticated JWT not linked to any member row yet
  IF NOT is_own_row THEN
    RAISE EXCEPTION '權限不足：僅能修改自己的成員資料'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF (to_jsonb(NEW) - ARRAY['theme', 'auth_id', 'avatar', 'color'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['theme', 'auth_id', 'avatar', 'color']) THEN
    RAISE EXCEPTION '權限不足：一般成員僅能修改自己的佈景主題、頭像與登入綁定'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- auth_id may only point at the caller themselves (or be cleared).
  IF NEW.auth_id IS NOT NULL
     AND NEW.auth_id IS DISTINCT FROM OLD.auth_id
     AND NEW.auth_id <> caller_uid THEN
    RAISE EXCEPTION '權限不足：登入綁定只能指向自己的帳號'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$livo_guard$;
