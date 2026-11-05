-- External onboarding is authoritative on the server. User-editable metadata
-- cannot clear the first-password requirement or make a login recoverable.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.external_qa_registrations (
  id uuid PRIMARY KEY,
  nonce uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  account_id text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  is_active boolean NOT NULL,
  project_ids text[] NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.external_qa_registrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.external_qa_registrations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.external_qa_registrations TO service_role;

CREATE OR REPLACE FUNCTION public.livo_external_qa_auth_password_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  was_required boolean;
  reissuing boolean;
  completing boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF COALESCE(NEW.raw_app_meta_data->>'livo_external_qa','false')='true' THEN
      NEW.raw_app_meta_data:=COALESCE(NEW.raw_app_meta_data,'{}'::jsonb)
        ||jsonb_build_object('livo_external_qa_password_change_required',true);
      NEW.raw_user_meta_data:=COALESCE(NEW.raw_user_meta_data,'{}'::jsonb)
        ||jsonb_build_object('livo_password_change_required',true);
    END IF;
    RETURN NEW;
  END IF;
  IF COALESCE(OLD.raw_app_meta_data->>'livo_external_qa','false')<>'true' THEN RETURN NEW; END IF;
  was_required:=COALESCE(OLD.raw_app_meta_data->>'livo_external_qa_password_change_required','true')<>'false';
  reissuing:=COALESCE(current_setting('livo.external_qa_reissuing',true),'')=OLD.id::text;
  completing:=COALESCE(current_setting('livo.external_qa_onboarding_verified',true),'')=OLD.id::text;
  -- A hash write is necessary but not sufficient: GoTrue can re-encrypt a hash
  -- at login without changing the user's password. Only the trusted password
  -- audit event in this same transaction can consume this actor marker.
  IF was_required AND NOT reissuing AND NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password
    AND COALESCE(NEW.encrypted_password,'')<>'' THEN
    PERFORM set_config('livo.external_qa_password_write',OLD.id::text,true);
  END IF;
  NEW.raw_app_meta_data:=COALESCE(NEW.raw_app_meta_data,'{}'::jsonb)
    ||jsonb_build_object('livo_external_qa',true);
  IF was_required AND completing AND NOT reissuing THEN
    NEW.raw_app_meta_data:=NEW.raw_app_meta_data
      ||jsonb_build_object('livo_external_qa_password_change_required',false,
        'livo_external_qa_onboarded_at',clock_timestamp());
    NEW.raw_user_meta_data:=COALESCE(NEW.raw_user_meta_data,'{}'::jsonb)
      ||jsonb_build_object('livo_password_change_required',false);
  ELSE
    NEW.raw_app_meta_data:=NEW.raw_app_meta_data
      ||jsonb_build_object('livo_external_qa_password_change_required',was_required);
    IF OLD.raw_app_meta_data ? 'livo_external_qa_onboarded_at' THEN
      NEW.raw_app_meta_data:=NEW.raw_app_meta_data
        ||jsonb_build_object('livo_external_qa_onboarded_at',OLD.raw_app_meta_data->'livo_external_qa_onboarded_at');
    END IF;
    IF was_required THEN
      NEW.raw_user_meta_data:=COALESCE(NEW.raw_user_meta_data,'{}'::jsonb)
        ||jsonb_build_object('livo_password_change_required',true);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_external_qa_auth_password_guard() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.livo_external_qa_password_audit_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  actor text:=NEW.payload->>'actor_id';
BEGIN
  IF NEW.payload->>'action' IS DISTINCT FROM 'user_updated_password'
    OR actor IS NULL OR actor !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    OR current_setting('livo.external_qa_password_write',true) IS DISTINCT FROM actor
    OR COALESCE(current_setting('livo.external_qa_reissuing',true),'')=actor THEN RETURN NEW; END IF;
  -- GoTrue v2.186 writes password, audit, then user metadata as separate SQL
  -- statements in one transaction. A rolled-back request rolls this back too.
  PERFORM set_config('livo.external_qa_onboarding_verified',actor,true);
  PERFORM set_config('livo.external_qa_password_write','',true);
  UPDATE auth.users SET
    raw_app_meta_data=COALESCE(raw_app_meta_data,'{}'::jsonb)
      ||jsonb_build_object('livo_external_qa_password_change_required',false),
    raw_user_meta_data=COALESCE(raw_user_meta_data,'{}'::jsonb)
      ||jsonb_build_object('livo_password_change_required',false)
  WHERE id=actor::uuid AND raw_app_meta_data->>'livo_external_qa'='true'
    AND raw_app_meta_data->>'livo_external_qa_password_change_required'='true'
    AND COALESCE(encrypted_password,'')<>'';
  PERFORM set_config('livo.external_qa_onboarding_verified','',true);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_external_qa_password_audit_guard() FROM PUBLIC,anon,authenticated;

-- Legacy external accounts have no trustworthy proof of their first password
-- change. Require one fresh change without resetting their existing password.
-- Existing linked logins that have never signed in can safely be reconciled.
INSERT INTO public.external_qa_registrations(id,account_id,email,name,is_active,project_ids,created_by)
SELECT gen_random_uuid(),a.id,lower(btrim(u.email)),a.name,a.is_active,
  ARRAY(SELECT g.project_id FROM public.external_qa_project_grants g WHERE g.account_id=a.id ORDER BY g.project_id),
  'migration'
FROM public.external_qa_accounts a JOIN auth.users u ON u.id=a.auth_id
WHERE u.last_sign_in_at IS NULL
  AND COALESCE(u.raw_user_meta_data->>'livo_password_change_required','false')='true'
  AND COALESCE(u.raw_app_meta_data->>'livo_external_qa','false')='true'
ON CONFLICT DO NOTHING;

UPDATE auth.users u SET
  raw_app_meta_data=COALESCE(u.raw_app_meta_data,'{}'::jsonb)
    ||jsonb_build_object('livo_external_qa',true,'livo_external_qa_password_change_required',true)
    ||COALESCE((SELECT jsonb_build_object('livo_external_qa_registration',r.id::text,'livo_external_qa_nonce',r.nonce::text)
      FROM public.external_qa_registrations r JOIN public.external_qa_accounts a ON a.id=r.account_id
      WHERE a.auth_id=u.id),'{}'::jsonb),
  raw_user_meta_data=COALESCE(u.raw_user_meta_data,'{}'::jsonb)
    ||jsonb_build_object('livo_password_change_required',true)
WHERE (EXISTS(SELECT 1 FROM public.external_qa_accounts a WHERE a.auth_id=u.id)
  OR COALESCE(u.raw_app_meta_data->>'livo_external_qa','false')='true')
  AND NOT (COALESCE(u.raw_app_meta_data,'{}'::jsonb) ? 'livo_external_qa_password_change_required');

DROP TRIGGER IF EXISTS livo_external_qa_auth_password_guard ON auth.users;
CREATE TRIGGER livo_external_qa_auth_password_guard BEFORE INSERT OR UPDATE ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.livo_external_qa_auth_password_guard();
DROP TRIGGER IF EXISTS livo_external_qa_password_audit_guard ON auth.audit_log_entries;
CREATE TRIGGER livo_external_qa_password_audit_guard AFTER INSERT ON auth.audit_log_entries
FOR EACH ROW EXECUTE FUNCTION public.livo_external_qa_password_audit_guard();

CREATE OR REPLACE FUNCTION public.livo_external_qa_registration(
  p_admin_auth uuid,p_action text,p_request_id uuid DEFAULT NULL,p_registration_id uuid DEFAULT NULL,
  p_account_id text DEFAULT NULL,p_revision integer DEFAULT NULL,p_name text DEFAULT NULL,
  p_email text DEFAULT NULL,p_active boolean DEFAULT NULL,p_project_ids text[] DEFAULT NULL,
  p_initial_password text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,extensions AS $$
DECLARE
  actor text;
  registration public.external_qa_registrations%ROWTYPE;
  account public.external_qa_accounts%ROWTYPE;
  login auth.users%ROWTYPE;
  created boolean:=false;
  pending boolean;
  recoverable boolean;
  state jsonb;
  normalized_email text:=lower(btrim(p_email));
BEGIN
  SELECT m.id INTO actor FROM public.members m
  WHERE m.auth_id=p_admin_auth AND m.is_active AND m.role::text='super_admin' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'external_qa_forbidden' USING ERRCODE='42501'; END IF;

  IF p_action='reserve' THEN
    IF p_request_id IS NULL THEN RAISE EXCEPTION 'external_qa_invalid' USING ERRCODE='22023'; END IF;
    -- Serialize retries of one command before claiming an identity. Email's
    -- unique constraint serializes different commands for the same identity.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
    SELECT * INTO registration FROM public.external_qa_registrations WHERE id=p_request_id FOR UPDATE;
    IF FOUND THEN
      IF registration.email IS DISTINCT FROM normalized_email OR registration.name IS DISTINCT FROM btrim(p_name)
        OR registration.is_active IS DISTINCT FROM p_active OR registration.project_ids IS DISTINCT FROM p_project_ids THEN
        RAISE EXCEPTION 'external_qa_stale' USING ERRCODE='PT409';
      END IF;
    ELSE
      PERFORM public.livo_external_qa_admin(p_admin_auth,'prepare',p_name=>p_name,p_email=>p_email,
        p_active=>p_active,p_project_ids=>p_project_ids);
      INSERT INTO public.external_qa_registrations(id,account_id,email,name,is_active,project_ids,created_by)
      VALUES(p_request_id,'eqa-'||gen_random_uuid(),normalized_email,btrim(p_name),p_active,p_project_ids,actor)
      RETURNING * INTO registration;
      created:=true;
    END IF;
    RETURN jsonb_build_object('registrationId',registration.id,'nonce',registration.nonce,
      'id',registration.account_id,'email',registration.email,'authRequired',created);
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('reconcile','prepare_recovery','recover') OR p_registration_id IS NULL THEN
    RAISE EXCEPTION 'external_qa_invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO registration FROM public.external_qa_registrations WHERE id=p_registration_id FOR UPDATE;
  IF NOT FOUND OR (p_account_id IS NOT NULL AND p_account_id IS DISTINCT FROM registration.account_id) THEN
    RAISE EXCEPTION 'external_qa_stale' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO account FROM public.external_qa_accounts WHERE id=registration.account_id FOR UPDATE;
  pending:=NOT FOUND;
  IF p_action IN ('prepare_recovery','recover') AND
    (p_revision IS NULL OR p_revision IS DISTINCT FROM CASE WHEN pending THEN 0 ELSE account.revision END) THEN
    RAISE EXCEPTION 'external_qa_stale' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO login FROM auth.users u
  WHERE lower(btrim(u.email))=registration.email
    AND u.raw_app_meta_data->>'livo_external_qa_registration'=registration.id::text
    AND u.raw_app_meta_data->>'livo_external_qa_nonce'=registration.nonce::text
    AND u.raw_app_meta_data->>'livo_external_qa'='true' FOR UPDATE;
  IF NOT FOUND THEN
    IF NOT pending OR EXISTS(SELECT 1 FROM auth.users u WHERE lower(btrim(u.email))=registration.email)
      OR EXISTS(SELECT 1 FROM public.members m WHERE lower(btrim(m.email))=registration.email) THEN
      RAISE EXCEPTION 'external_qa_email_in_use' USING ERRCODE='PT409';
    END IF;
    RETURN jsonb_build_object('registrationId',registration.id,'nonce',registration.nonce,
      'id',registration.account_id,'email',registration.email,'authRequired',true,'registrationPending',true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.members m WHERE m.auth_id=login.id OR lower(btrim(m.email))=registration.email)
    OR EXISTS(SELECT 1 FROM public.external_qa_accounts a WHERE a.auth_id=login.id AND a.id<>registration.account_id)
    OR (NOT pending AND account.auth_id<>login.id) THEN
    RAISE EXCEPTION 'external_qa_email_in_use' USING ERRCODE='PT409';
  END IF;
  recoverable:=login.raw_app_meta_data->>'livo_external_qa_password_change_required'='true'
    AND NOT (COALESCE(login.raw_app_meta_data,'{}'::jsonb) ? 'livo_external_qa_onboarded_at');
  IF p_action IN ('prepare_recovery','recover') AND NOT recoverable THEN
    RAISE EXCEPTION 'external_qa_already_onboarded' USING ERRCODE='PT409';
  END IF;
  IF pending THEN
    state:=public.livo_external_qa_admin(p_admin_auth,'create',p_account_id=>registration.account_id,
      p_auth_id=>login.id,p_name=>registration.name,p_email=>registration.email,
      p_active=>registration.is_active,p_project_ids=>registration.project_ids);
    SELECT * INTO account FROM public.external_qa_accounts WHERE id=registration.account_id;
  END IF;
  IF p_action='recover' THEN
    IF p_initial_password IS NULL OR length(p_initial_password)<8 OR octet_length(p_initial_password)>72 THEN
      RAISE EXCEPTION 'external_qa_invalid_password' USING ERRCODE='22023';
    END IF;
    -- Hold the auth row across validation and rotation. A concurrent completed
    -- first change wins the lock and makes recovery fail, never resets it.
    PERFORM set_config('livo.external_qa_password_write','',true);
    PERFORM set_config('livo.external_qa_reissuing',login.id::text,true);
    UPDATE auth.users SET encrypted_password=extensions.crypt(p_initial_password,extensions.gen_salt('bf',10)),
      updated_at=clock_timestamp(),
      raw_user_meta_data=COALESCE(raw_user_meta_data,'{}'::jsonb)||jsonb_build_object('livo_password_change_required',true)
    WHERE id=login.id;
    PERFORM set_config('livo.external_qa_reissuing','',true);
    DELETE FROM auth.refresh_tokens WHERE user_id=login.id::text;
    DELETE FROM auth.sessions WHERE user_id=login.id;
    UPDATE public.external_qa_accounts SET revision=revision+1 WHERE id=account.id RETURNING * INTO account;
    INSERT INTO public.external_qa_admin_events(account_id,actor_id,before_state,after_state)
    VALUES(account.id,actor,jsonb_build_object('revision',account.revision-1),
      jsonb_build_object('revision',account.revision,'credentialReissued',true));
  END IF;
  state:=public.livo_external_qa_admin(p_admin_auth,'list');
  SELECT value INTO state FROM jsonb_array_elements(state) WHERE value->>'id'=account.id;
  RETURN jsonb_build_object('account',state||jsonb_build_object('registrationId',registration.id,
      'registrationPending',false,'credentialRecoveryAvailable',recoverable),
    'registrationId',registration.id,'authRequired',false);
END;
$$;
REVOKE ALL ON FUNCTION public.livo_external_qa_registration(uuid,text,uuid,uuid,text,integer,text,text,boolean,text[],text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_external_qa_registration(uuid,text,uuid,uuid,text,integer,text,text,boolean,text[],text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.livo_external_qa_registration_list(p_admin_auth uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  existing jsonb;
  result jsonb;
BEGIN
  existing:=public.livo_external_qa_admin(p_admin_auth,'list');
  SELECT COALESCE(jsonb_agg(value||jsonb_build_object(
    'registrationId',r.id,'registrationPending',false,
    'credentialRecoveryAvailable',r.id IS NOT NULL
      AND u.raw_app_meta_data->>'livo_external_qa_registration'=r.id::text
      AND u.raw_app_meta_data->>'livo_external_qa_nonce'=r.nonce::text
      AND u.raw_app_meta_data->>'livo_external_qa_password_change_required'='true'
      AND NOT (COALESCE(u.raw_app_meta_data,'{}'::jsonb) ? 'livo_external_qa_onboarded_at')
  )),'[]'::jsonb) INTO result
  FROM jsonb_array_elements(existing) item(value)
  JOIN public.external_qa_accounts a ON a.id=value->>'id'
  LEFT JOIN auth.users u ON u.id=a.auth_id
  LEFT JOIN public.external_qa_registrations r ON r.account_id=a.id;
  RETURN result||COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id',r.account_id,'name',r.name,'email',r.email,'isActive',r.is_active,'revision',0,
    'projectIds',r.project_ids,'registrationId',r.id,'registrationPending',true,
    'credentialRecoveryAvailable',NOT EXISTS(SELECT 1 FROM auth.users u
      WHERE lower(btrim(u.email))=r.email AND
        (u.raw_app_meta_data->>'livo_external_qa_registration' IS DISTINCT FROM r.id::text
         OR u.raw_app_meta_data->>'livo_external_qa_nonce' IS DISTINCT FROM r.nonce::text))
  )) FROM public.external_qa_registrations r
  WHERE NOT EXISTS(SELECT 1 FROM public.external_qa_accounts a WHERE a.id=r.account_id)),'[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.livo_external_qa_registration_list(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_external_qa_registration_list(uuid) TO service_role;

SELECT public.livo_apply_active_member_gate();
