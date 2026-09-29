-- ============================================================================
-- Migration: 20260713_permission_floor.sql
-- Server-side permission floor for the self-host (Docker/Supabase) build.
--
-- Problem: legacy write policies are permissive ("FOR ALL TO authenticated
-- USING (true)") on ~40 tables — any member with a JWT could delete projects,
-- rewrite statuses, wipe backup history, or promote their own role. The
-- frontend enforces roles, but nothing on the server did.
--
-- This migration replaces every client WRITE policy (INSERT/UPDATE/DELETE and
-- write-capable FOR ALL) with an audited role floor. SELECT policies are left
-- untouched — read semantics do not change. Where a table's ONLY read path was
-- a permissive FOR ALL policy (which we must drop because it is also a write
-- policy), an equivalent "pf_<table>_read" FOR SELECT TO authenticated
-- USING (true) policy is created so reads keep working exactly as before.
--
-- Roles: member < admin < super_admin (public.members.role, resolved from
-- auth.uid() via members.auth_id — same chain as public.current_member_id()).
-- Matrix legend (insert/update/delete):
--   all   = any authenticated member
--   own   = rows whose owner column = current_member_id(); admin+ unrestricted
--   admin = admin or super_admin only
--   super = super_admin only
--   none  = no client writes at all (service_role / SECURITY DEFINER only)
--
-- Deliberately untouched:
--   * field_locks         — worker-era collaboration table; its 8 existing
--                           policies (authenticated + anon CRUD) are the
--                           intended contract for live field locking.
--   * slack_config        — already RLS-locked server-only (zero policies).
--   * interaction_tokens  — already locked down in 20260402_fix_approval_rls
--                           (select none / insert / update none).
--   * orders              — server-only seller table (excluded from release).
--   * profiles SELECT     — own-profile select stays; profile creation is done
--                           by the on_auth_user_created SECURITY DEFINER
--                           trigger, so dropping client INSERT/UPDATE is safe.
--
-- Tables skipped gracefully when absent from the merged schema (to_regclass
-- check + NOTICE): tags / task_tags exist only in the Cloudflare D1 build —
-- there is no Postgres migration creating them, so they will always be
-- skipped here (rows kept in the matrix for parity with the audit sheet).
-- user_board_prefs exists (20260401_add_user_board_prefs.sql) and is applied.
--
-- Deviation from the raw audit sheet (documented on purpose):
--   members UPDATE also allows an authenticated user whose JWT email matches
--   an UNLINKED member row (auth_id IS NULL) to update it. Without this, the
--   login-link flow (src/App.tsx + useAuthState.ts: match member by email,
--   then set auth_id = auth.uid()) breaks for every first login, and the user
--   would never resolve current_member_id() afterwards. The BEFORE UPDATE
--   trigger below restricts that path to theme/auth_id changes on the row
--   bearing the caller's own verified email.
--
-- Idempotent: safe to re-run (CREATE OR REPLACE, DROP POLICY IF EXISTS,
-- dynamic drops, DROP TRIGGER IF EXISTS). All CREATE POLICY statements live
-- inside DO/EXECUTE so build-release.mjs's makeIdempotent pass ignores them.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 0. Role helpers (SECURITY DEFINER, STABLE)
--    current_member_role() returns NULL when the caller has no linked member
--    row — NULL is treated as "no write" by the admin/super helpers.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.current_member_role()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT role::text FROM public.members WHERE auth_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_livo_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT COALESCE(public.current_member_role() IN ('admin', 'super_admin'), false);
$$;

CREATE OR REPLACE FUNCTION public.is_livo_super()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT COALESCE(public.current_member_role() = 'super_admin', false);
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. members BEFORE UPDATE column guard
--    RLS says WHICH rows may be updated; this trigger says WHICH COLUMNS.
--    service_role (Edge Functions) and no-JWT sessions (psql / installer /
--    GoTrue FK cascades) are exempted immediately — RLS-bypassing writers
--    still pass through triggers, so the exemption must come first.
--      super_admin → any column
--      admin       → only theme / auth_id / sort_order may change
--      member (or a JWT not yet linked to a member row)
--                  → own row only, and only theme / auth_id may change;
--                    auth_id may only be set to the caller's own uid or NULL
--                    (covers: first-login email claim, stale-link clearing
--                    where the row is located by auth_id and auth_id → NULL).
-- ────────────────────────────────────────────────────────────────────────────

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

  IF caller_role = 'admin' THEN
    -- Everything except theme / auth_id / sort_order must be unchanged.
    IF (to_jsonb(NEW) - ARRAY['theme', 'auth_id', 'sort_order'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['theme', 'auth_id', 'sort_order']) THEN
      RAISE EXCEPTION '權限不足：管理員僅能調整成員的排序、佈景主題與登入綁定，其他欄位（如角色、姓名）需由超級管理員修改'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- member, or an authenticated JWT not linked to any member row yet
  -- (first-login email claim — current_member_role() is NULL then).
  is_own_row :=
       (OLD.auth_id IS NOT NULL AND OLD.auth_id = caller_uid)
    OR (OLD.id = public.current_member_id())
    OR (auth.email() IS NOT NULL AND OLD.email = auth.email()
        AND (OLD.auth_id IS NULL OR OLD.auth_id = caller_uid));
  IF NOT is_own_row THEN
    RAISE EXCEPTION '權限不足：僅能修改自己的成員資料'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF (to_jsonb(NEW) - ARRAY['theme', 'auth_id'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['theme', 'auth_id']) THEN
    RAISE EXCEPTION '權限不足：一般成員僅能修改自己的佈景主題與登入綁定'
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

DROP TRIGGER IF EXISTS livo_members_update_guard ON public.members;
CREATE TRIGGER livo_members_update_guard
  BEFORE UPDATE ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.livo_members_update_guard();

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Session-local plumbing (pg_temp — vanishes when the session ends,
--    nothing is left behind in the customer schema).
--      pf_reset(tbl)          drop EVERY write-capable policy (INSERT/UPDATE/
--                             DELETE/ALL) on public.tbl; if no dedicated
--                             SELECT policy remains, add pf_<tbl>_read so the
--                             previous read access is preserved.
--      pf_pred(kind, own_col) matrix keyword → SQL predicate.
--      pf_policy(tbl,op,pred) create pf_<tbl>_<op> for one verb.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pg_temp.pf_reset(tbl text)
RETURNS void LANGUAGE plpgsql AS $pf_fn$
DECLARE
  pol record;
BEGIN
  FOR pol IN
    SELECT p.polname
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = tbl
       AND p.polcmd::text IN ('a', 'w', 'd', '*')   -- INSERT/UPDATE/DELETE/ALL
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.polname, tbl);
  END LOOP;

  -- FOR ALL policies also carried the read path; make sure reads survive.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = tbl AND p.polcmd::text = 'r'
  ) THEN
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      'pf_' || tbl || '_read', tbl);
  END IF;
END;
$pf_fn$;

CREATE OR REPLACE FUNCTION pg_temp.pf_pred(kind text, own_col text)
RETURNS text LANGUAGE plpgsql AS $pf_fn$
BEGIN
  IF kind = 'all'   THEN RETURN 'true'; END IF;
  IF kind = 'admin' THEN RETURN 'public.is_livo_admin()'; END IF;
  IF kind = 'super' THEN RETURN 'public.is_livo_super()'; END IF;
  IF kind = 'own'   THEN
    IF own_col IS NULL THEN
      RAISE EXCEPTION 'permission_floor: own rule without owner column';
    END IF;
    RETURN format('(public.is_livo_admin() OR %I = public.current_member_id())', own_col);
  END IF;
  RAISE EXCEPTION 'permission_floor: unknown rule kind %', kind;
END;
$pf_fn$;

CREATE OR REPLACE FUNCTION pg_temp.pf_policy(tbl text, op text, pred text)
RETURNS void LANGUAGE plpgsql AS $pf_fn$
DECLARE
  pol text := 'pf_' || tbl || '_' || op;
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol, tbl);
  IF op = 'insert' THEN
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)',
      pol, tbl, pred);
  ELSIF op = 'update' THEN
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)',
      pol, tbl, pred, pred);
  ELSIF op = 'delete' THEN
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (%s)',
      pol, tbl, pred);
  END IF;
END;
$pf_fn$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. The audited matrix (every table except members, which is special-cased
--    below). Missing tables are skipped with a NOTICE.
-- ────────────────────────────────────────────────────────────────────────────

DO $livo_pf$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- table                          insert   update   delete   owner column
      ('profiles',                      'none',  'none',  'none',  NULL::text),
      ('product_lines',                 'admin', 'admin', 'admin', NULL),
      ('projects',                      'all',   'admin', 'super', NULL),
      ('statuses',                      'admin', 'admin', 'admin', NULL),
      ('sprints',                       'all',   'all',   'none',  NULL),
      ('tasks',                         'all',   'all',   'admin', NULL),
      ('task_deployments',              'all',   'none',  'all',   NULL),
      ('task_specs',                    'all',   'all',   'all',   NULL),
      ('task_checks',                   'all',   'all',   'all',   NULL),
      ('task_todos',                    'all',   'all',   'all',   NULL),
      ('comments',                      'all',   'own',   'own',   'user_id'),
      ('status_logs',                   'all',   'none',  'super', NULL),
      ('notifications',                 'all',   'own',   'super', 'recipient_id'),
      ('member_manuals',                'own',   'own',   'none',  'member_id'),
      ('tags',                          'all',   'none',  'all',   NULL),  -- D1-only; skipped on Postgres
      ('task_tags',                     'all',   'none',  'all',   NULL),  -- D1-only; skipped on Postgres
      ('backup_settings',               'super', 'super', 'none',  NULL),
      ('backup_history',                'none',  'none',  'super', NULL),
      ('task_attachments',              'all',   'none',  'all',   NULL),
      ('user_column_configs',           'own',   'own',   'none',  'member_id'),
      ('activity_logs',                 'all',   'none',  'super', NULL),
      ('system_settings',               'admin', 'admin', 'none',  NULL),
      ('team_settings',                 'admin', 'admin', 'none',  NULL),
      ('user_notification_preferences', 'own',   'own',   'none',  'user_id'),
      ('user_report_configs',           'own',   'own',   'none',  'user_id'),
      ('custom_fields',                 'admin', 'admin', 'admin', NULL),
      ('task_custom_field_values',      'all',   'all',   'none',  NULL),
      ('task_dependencies',             'all',   'none',  'all',   NULL),
      ('task_templates',                'admin', 'admin', 'admin', NULL),
      ('work_reports',                  'own',   'own',   'none',  'user_id'),
      ('user_board_prefs',              'own',   'own',   'none',  'user_id'),
      ('status_transition_rules',       'admin', 'none',  'admin', NULL),
      ('approval_rules',                'admin', 'admin', 'admin', NULL),
      ('approval_rule_steps',           'admin', 'admin', 'admin', NULL),
      ('approval_requests',             'own',   'all',   'none',  'requested_by'),
      ('approval_actions',              'own',   'none',  'none',  'action_by'),
      ('external_account_bindings',     'own',   'own',   'own',   'member_id'),
      ('external_action_logs',          'own',   'none',  'none',  'member_id'),
      ('slack_thread_mappings',         'none',  'none',  'none',  NULL),
      ('due_date_reminders',            'none',  'none',  'none',  NULL),
      ('report_send_targets',           'all',   'admin', 'admin', NULL),
      ('report_send_logs',              'all',   'all',   'none',  NULL),
      ('notification_templates',        'admin', 'admin', 'admin', NULL),
      ('notification_rules',            'admin', 'admin', 'admin', NULL),
      ('notification_delivery_logs',    'all',   'none',  'none',  NULL),
      ('standup_sessions',              'all',   'all',   'none',  NULL),
      ('standup_member_durations',      'all',   'all',   'all',   NULL)
    ) AS m(tbl, ins, upd, del, own_col)
  LOOP
    IF to_regclass('public.' || r.tbl) IS NULL THEN
      RAISE NOTICE '[permission_floor] skipped %: table not present in this install', r.tbl;
      CONTINUE;
    END IF;

    PERFORM pg_temp.pf_reset(r.tbl);
    IF r.ins <> 'none' THEN
      PERFORM pg_temp.pf_policy(r.tbl, 'insert', pg_temp.pf_pred(r.ins, r.own_col));
    END IF;
    IF r.upd <> 'none' THEN
      PERFORM pg_temp.pf_policy(r.tbl, 'update', pg_temp.pf_pred(r.upd, r.own_col));
    END IF;
    IF r.del <> 'none' THEN
      PERFORM pg_temp.pf_policy(r.tbl, 'delete', pg_temp.pf_pred(r.del, r.own_col));
    END IF;
  END LOOP;
END
$livo_pf$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. members (SPECIAL): no client INSERT/DELETE (member lifecycle goes through
--    the manage-member Edge Function on service_role). UPDATE is row-gated
--    here and column-gated by the trigger in section 1.
-- ────────────────────────────────────────────────────────────────────────────

DO $livo_pf$
BEGIN
  IF to_regclass('public.members') IS NULL THEN
    RAISE NOTICE '[permission_floor] skipped members: table not present in this install';
    RETURN;
  END IF;

  -- Drops "Allow all write" + "Authenticated write" (both FOR ALL); the two
  -- SELECT policies ("Allow all read", "Authenticated read") stay untouched.
  PERFORM pg_temp.pf_reset('members');

  EXECUTE 'CREATE POLICY "pf_members_update" ON public.members'
       || ' FOR UPDATE TO authenticated'
       || ' USING ('
       || '   public.is_livo_admin()'
       || '   OR id = public.current_member_id()'
       || '   OR (auth.uid() IS NOT NULL AND email = auth.email()'
       || '       AND (auth_id IS NULL OR auth_id = auth.uid()))'
       || ' )'
       || ' WITH CHECK ('
       || '   public.is_livo_admin()'
       || '   OR id = public.current_member_id()'
       || '   OR (auth.uid() IS NOT NULL AND email = auth.email()'
       || '       AND (auth_id IS NULL OR auth_id = auth.uid()))'
       || ' )';
END
$livo_pf$;
