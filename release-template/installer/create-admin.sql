-- ============================================================
-- LIVO installer: create (or reset the password of) the first
-- super_admin account.
--
-- The installer prepends three set_config() statements before
-- piping this file into psql (as supabase_admin):
--   SELECT set_config('livo.admin_email',    '<email>', false);
--   SELECT set_config('livo.admin_password', '<pw>',    false);
--   SELECT set_config('livo.admin_mode',     'create' | 'reset', false);
--
-- Result is signalled via RAISE NOTICE / RAISE EXCEPTION with
-- LIVO_OK_* / LIVO_ERR_* sentinels that the install scripts parse.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

BEGIN;
SET LOCAL search_path = public, extensions;

DO $livo$
DECLARE
  v_email     text := lower(trim(current_setting('livo.admin_email', true)));
  v_pw        text := current_setting('livo.admin_password', true);
  v_mode      text := coalesce(current_setting('livo.admin_mode', true), 'create');
  v_name      text;
  v_uid       uuid;
  v_member_id text;
BEGIN
  IF v_email IS NULL OR v_email !~ '^[^@]+@[^@]+\.[^@]+$' THEN
    RAISE EXCEPTION 'LIVO_ERR_BAD_EMAIL';
  END IF;
  IF v_pw IS NULL OR length(v_pw) < 8 THEN
    RAISE EXCEPTION 'LIVO_ERR_PW_TOO_SHORT';
  END IF;
  v_name := split_part(v_email, '@', 1);

  SELECT id INTO v_uid FROM auth.users WHERE lower(email) = v_email LIMIT 1;

  IF v_uid IS NULL THEN
    IF v_mode = 'reset' THEN
      RAISE EXCEPTION 'LIVO_ERR_EMAIL_NOT_FOUND';
    END IF;

    v_uid := gen_random_uuid();

    -- Row shape matches what self-hosted GoTrue v2 writes for a confirmed
    -- email/password user. The token columns must be '' (NOT NULL-able
    -- empty strings, not SQL NULL) or GoTrue fails to scan the row at login.
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) VALUES (
      '00000000-0000-0000-0000-000000000000',
      v_uid,
      'authenticated',
      'authenticated',
      v_email,
      crypt(v_pw, gen_salt('bf', 10)),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', v_name),
      now(), now(),
      '', '', '', ''
    );

    INSERT INTO auth.identities (
      id, user_id, provider_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      v_uid,
      v_uid::text,
      jsonb_build_object(
        'sub', v_uid::text,
        'email', v_email,
        'email_verified', true,
        'phone_verified', false
      ),
      'email',
      now(), now(), now()
    );

    RAISE NOTICE 'LIVO_OK_ADMIN_CREATED';
  ELSE
    IF v_mode <> 'reset' THEN
      RAISE EXCEPTION 'LIVO_ERR_EMAIL_EXISTS';
    END IF;

    UPDATE auth.users
       SET encrypted_password = crypt(v_pw, gen_salt('bf', 10)),
           updated_at         = now()
     WHERE id = v_uid;

    RAISE NOTICE 'LIVO_OK_PASSWORD_RESET';
  END IF;

  -- Ensure a members row linked to this auth user (role super_admin).
  SELECT id INTO v_member_id
    FROM public.members
   WHERE auth_id = v_uid OR lower(email) = v_email
   ORDER BY (auth_id = v_uid) DESC NULLS LAST
   LIMIT 1;

  IF v_member_id IS NULL THEN
    INSERT INTO public.members
      (id, name, avatar, role, job_title, color, email, auth_id, is_active, sort_order)
    VALUES
      ('m-' || substr(md5(v_uid::text), 1, 12),
       v_name,
       substr(v_name, 1, 2),
       'super_admin',
       '系統管理員',
       '#0052CC',
       v_email,
       v_uid,
       true,
       0);
    RAISE NOTICE 'LIVO_OK_MEMBER_CREATED';
  ELSE
    UPDATE public.members
       SET auth_id = v_uid, role = 'super_admin', is_active = true
     WHERE id = v_member_id;
    RAISE NOTICE 'LIVO_OK_MEMBER_LINKED';
  END IF;
END
$livo$;

COMMIT;
