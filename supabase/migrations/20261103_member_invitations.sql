-- Bearer invitations admit one email-verified new account. Public clients have
-- no table/RPC access; the Edge Function validates JWTs and uses service_role.
CREATE TABLE IF NOT EXISTS public.member_invitations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'default' CHECK (workspace_id='default'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  role public.app_member_role NOT NULL DEFAULT 'member',
  job_title text NOT NULL DEFAULT '' CHECK (length(job_title)<=200),
  is_qa_admin boolean NOT NULL DEFAULT false CHECK (NOT is_qa_admin OR role::text='member'),
  -- Retain an unusable invitation if its issuer is later deleted.
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '7 days'),
  revoked_at timestamptz,
  used_at timestamptz,
  used_member_id text
);
CREATE TABLE IF NOT EXISTS public.member_invitation_confirmations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL DEFAULT 'default' CHECK (workspace_id='default'),
  invitation_id text NOT NULL REFERENCES public.member_invitations(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  email text NOT NULL CHECK (length(email)<=254 AND email=lower(trim(email))),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  send_state text NOT NULL DEFAULT 'pending' CHECK (send_state IN ('pending','sent','failed')),
  sent_at timestamptz,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS member_invitation_confirmation_resend ON public.member_invitation_confirmations(invitation_id,email,created_at DESC);
CREATE INDEX IF NOT EXISTS member_invitation_confirmation_email ON public.member_invitation_confirmations(email,created_at DESC);
CREATE INDEX IF NOT EXISTS member_invitation_confirmation_expiry ON public.member_invitation_confirmations(workspace_id,expires_at,id);
CREATE INDEX IF NOT EXISTS member_invitations_actor ON public.member_invitations(created_by,created_at DESC);
ALTER TABLE public.member_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_invitation_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_invitations,public.member_invitation_confirmations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.member_invitations,public.member_invitation_confirmations TO service_role;

-- The existing management/import endpoints already refuse a reused real email.
-- Serialize that invariant at INSERT too, including a simultaneous invite join.
-- Existing duplicate rows and name-only import placeholders are left untouched.
CREATE OR REPLACE FUNCTION public.livo_member_email_insert_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE normalized text:=lower(trim(NEW.email));
BEGIN
  IF normalized='' OR normalized LIKE '%.invalid' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.email IS NOT DISTINCT FROM OLD.email THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('livo-member-email:'||normalized,0));
  IF EXISTS(SELECT 1 FROM public.members WHERE lower(trim(email))=normalized AND id<>NEW.id)
    THEN RAISE EXCEPTION 'email_taken' USING ERRCODE='PT409'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.livo_member_email_insert_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_member_email_insert_guard ON public.members;
CREATE TRIGGER livo_member_email_insert_guard BEFORE INSERT OR UPDATE OF email ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.livo_member_email_insert_guard();

CREATE OR REPLACE FUNCTION public.livo_invitation_grant_allowed(actor_role text,invite_role text,p_position text,qa boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$
  SELECT actor_role='super_admin' OR (actor_role='admin' AND invite_role='member' AND p_position='' AND NOT qa);
$$;

CREATE OR REPLACE FUNCTION public.livo_invitation_actor(actor_auth uuid)
RETURNS public.members LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor public.members%ROWTYPE;
BEGIN
  SELECT m.* INTO actor FROM public.members m JOIN auth.users u ON u.id=m.auth_id
    WHERE m.auth_id=actor_auth AND m.is_active AND (u.banned_until IS NULL OR u.banned_until<=now())
    FOR SHARE OF m,u;
  IF NOT FOUND OR actor.role::text NOT IN ('admin','super_admin')
    OR (SELECT count(*) FROM public.members WHERE auth_id=actor_auth)<>1
    THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='PT403'; END IF;
  RETURN actor;
END $$;

CREATE OR REPLACE FUNCTION public.livo_invitation_issuer(invite public.member_invitations)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor public.members%ROWTYPE;
BEGIN
  SELECT m.* INTO actor FROM public.members m JOIN auth.users u ON u.id=m.auth_id
    WHERE m.id=invite.created_by AND m.is_active AND (u.banned_until IS NULL OR u.banned_until<=now())
    FOR SHARE OF m,u;
  RETURN FOUND AND (SELECT count(*) FROM public.members WHERE auth_id=actor.auth_id)=1
    AND public.livo_invitation_grant_allowed(actor.role::text,invite.role::text,invite.job_title,invite.is_qa_admin);
END $$;

CREATE OR REPLACE FUNCTION public.livo_member_invitation_create(
  p_actor_auth_id uuid,p_id text,p_token_hash text,p_role text DEFAULT 'member',p_job_title text DEFAULT '',p_is_qa_admin boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor public.members%ROWTYPE; invitation public.member_invitations%ROWTYPE;
BEGIN
  actor:=public.livo_invitation_actor(p_actor_auth_id);
  IF p_role IS NULL OR p_role NOT IN ('member','admin','super_admin') OR p_job_title IS NULL OR length(p_job_title)>200
    OR p_is_qa_admin IS NULL OR (p_is_qa_admin AND p_role<>'member')
    THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE='PT400'; END IF;
  IF NOT public.livo_invitation_grant_allowed(actor.role::text,p_role,trim(p_job_title),p_is_qa_admin)
    THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='PT403'; END IF;
  -- Serializes creation by the same issuer without locking their member row for update.
  PERFORM pg_advisory_xact_lock(hashtextextended('livo-invite-create:'||actor.id,0));
  IF (SELECT count(*) FROM public.member_invitations WHERE created_by=actor.id AND created_at>now()-interval '24 hours')>=20
    THEN RAISE EXCEPTION 'rate_limited' USING ERRCODE='PT429'; END IF;
  INSERT INTO public.member_invitations(id,token_hash,role,job_title,is_qa_admin,created_by)
    VALUES(p_id,p_token_hash,p_role::public.app_member_role,trim(p_job_title),p_is_qa_admin,actor.id)
    RETURNING * INTO invitation;
  RETURN to_jsonb(invitation)-'token_hash';
END $$;

CREATE OR REPLACE FUNCTION public.livo_member_invitation_revoke(p_actor_auth_id uuid,p_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor public.members%ROWTYPE; invitation public.member_invitations%ROWTYPE;
BEGIN
  actor:=public.livo_invitation_actor(p_actor_auth_id);
  SELECT * INTO invitation FROM public.member_invitations WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR (actor.role::text<>'super_admin' AND invitation.created_by<>actor.id)
    THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='PT403'; END IF;
  IF invitation.used_at IS NOT NULL THEN RAISE EXCEPTION 'invalid_token' USING ERRCODE='PT409'; END IF;
  UPDATE public.member_invitations SET revoked_at=coalesce(revoked_at,now()) WHERE id=p_id;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.livo_member_invitation_list(p_actor_auth_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE actor public.members%ROWTYPE; invitation public.member_invitations%ROWTYPE;
  invitations jsonb:='[]'::jsonb; status text;
BEGIN
  actor:=public.livo_invitation_actor(p_actor_auth_id);
  FOR invitation IN SELECT * FROM public.member_invitations
    WHERE actor.role::text='super_admin' OR created_by=actor.id
    ORDER BY created_at DESC,id DESC LIMIT 100
  LOOP
    status:=CASE WHEN invitation.used_at IS NOT NULL THEN 'used'
      WHEN invitation.revoked_at IS NOT NULL THEN 'revoked'
      WHEN invitation.expires_at<=now() THEN 'expired'
      WHEN NOT public.livo_invitation_issuer(invitation) THEN 'unavailable'
      ELSE 'pending' END;
    invitations:=invitations||jsonb_build_array((to_jsonb(invitation)-'token_hash')||jsonb_build_object('status',status));
  END LOOP;
  RETURN invitations;
END $$;

-- Access-triggered retention: confirmations also form the resend/day ledger.
-- Keep every recent attempt and a 24-hour grace after expiry for auth proof,
-- then remove at most 200 rows without waiting on an in-flight transaction.
-- Invitation history, linked members and auth accounts are never pruned here.
CREATE OR REPLACE FUNCTION public.livo_member_invitation_prune()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE removed integer;
BEGIN
  WITH expired AS (
    SELECT id FROM public.member_invitation_confirmations
    WHERE workspace_id='default' AND expires_at<=now()-interval '24 hours'
      AND created_at<=now()-interval '24 hours'
    ORDER BY expires_at,id LIMIT 200 FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.member_invitation_confirmations c USING expired e WHERE c.id=e.id;
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END $$;

CREATE OR REPLACE FUNCTION public.livo_member_invitation_preview(p_id text,p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE invitation public.member_invitations%ROWTYPE;
BEGIN
  SELECT * INTO invitation FROM public.member_invitations WHERE id=p_id AND token_hash=p_token_hash;
  IF NOT FOUND OR invitation.used_at IS NOT NULL OR invitation.revoked_at IS NOT NULL OR invitation.expires_at<=now()
    OR NOT public.livo_invitation_issuer(invitation)
    THEN RAISE EXCEPTION 'invalid_token' USING ERRCODE='PT409'; END IF;
  RETURN to_jsonb(invitation)-ARRAY['token_hash','created_by','used_member_id'];
END $$;

CREATE OR REPLACE FUNCTION public.livo_member_invitation_request_confirmation(
  p_invitation_id text,p_invite_hash text,p_id text,p_token_hash text,p_name text,p_email text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE invitation public.member_invitations%ROWTYPE; confirmation public.member_invitation_confirmations%ROWTYPE;
BEGIN
  SELECT * INTO invitation FROM public.member_invitations WHERE id=p_invitation_id AND token_hash=p_invite_hash FOR UPDATE;
  IF NOT FOUND OR invitation.used_at IS NOT NULL OR invitation.revoked_at IS NOT NULL OR invitation.expires_at<=now()
    OR NOT public.livo_invitation_issuer(invitation)
    THEN RAISE EXCEPTION 'invalid_token' USING ERRCODE='PT409'; END IF;
  IF p_name IS NULL OR length(trim(p_name)) NOT BETWEEN 1 AND 80 OR p_email IS NULL OR length(p_email)>254
    OR p_email<>lower(trim(p_email)) OR p_email !~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
    OR p_email LIKE '%.invalid' THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE='PT400'; END IF;
  IF EXISTS(SELECT 1 FROM public.members WHERE lower(email)=p_email)
    OR EXISTS(SELECT 1 FROM auth.users WHERE lower(email)=p_email)
    THEN RAISE EXCEPTION 'email_taken' USING ERRCODE='PT409'; END IF;
  -- Reservations count even when transport fails, bounding resend abuse.
  PERFORM pg_advisory_xact_lock(hashtextextended('livo-invite-email:'||p_email,0));
  IF (SELECT count(*) FROM public.member_invitation_confirmations WHERE invitation_id=invitation.id AND created_at>now()-interval '24 hours')>=10
    OR EXISTS(SELECT 1 FROM public.member_invitation_confirmations WHERE email=p_email AND created_at>now()-interval '10 minutes')
    THEN RAISE EXCEPTION 'rate_limited' USING ERRCODE='PT429'; END IF;
  INSERT INTO public.member_invitation_confirmations(id,invitation_id,token_hash,name,email,expires_at)
    VALUES(p_id,invitation.id,p_token_hash,trim(p_name),p_email,least(invitation.expires_at,now()+interval '1 hour'))
    RETURNING * INTO confirmation;
  RETURN (to_jsonb(confirmation)-'token_hash')||jsonb_build_object('role',invitation.role,'job_title',invitation.job_title,'is_qa_admin',invitation.is_qa_admin);
END $$;

CREATE OR REPLACE FUNCTION public.livo_member_invitation_finish_send(p_id text,p_token_hash text,p_sent boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE public.member_invitation_confirmations SET send_state=CASE WHEN p_sent THEN 'sent' ELSE 'failed' END,
    sent_at=CASE WHEN p_sent THEN now() ELSE NULL END
    WHERE id=p_id AND token_hash=p_token_hash AND send_state='pending';
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.livo_member_invitation_confirmation_preview(p_id text,p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE confirmation public.member_invitation_confirmations%ROWTYPE; invitation public.member_invitations%ROWTYPE;
BEGIN
  SELECT * INTO confirmation FROM public.member_invitation_confirmations WHERE id=p_id AND token_hash=p_token_hash;
  IF NOT FOUND OR confirmation.send_state<>'sent' OR confirmation.used_at IS NOT NULL OR confirmation.expires_at<=now()
    THEN RAISE EXCEPTION 'invalid_token' USING ERRCODE='PT409'; END IF;
  SELECT * INTO invitation FROM public.member_invitations WHERE id=confirmation.invitation_id;
  IF NOT FOUND OR invitation.used_at IS NOT NULL OR invitation.revoked_at IS NOT NULL OR invitation.expires_at<=now()
    OR NOT public.livo_invitation_issuer(invitation)
    THEN RAISE EXCEPTION 'invalid_token' USING ERRCODE='PT409'; END IF;
  RETURN (to_jsonb(confirmation)-'token_hash')||jsonb_build_object('role',invitation.role,'job_title',invitation.job_title,'is_qa_admin',invitation.is_qa_admin);
END $$;

CREATE OR REPLACE FUNCTION public.livo_member_invitation_accept(p_confirmation_id text,p_token_hash text,p_auth_id uuid,p_member_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE confirmation public.member_invitation_confirmations%ROWTYPE; invitation public.member_invitations%ROWTYPE;
BEGIN
  SELECT * INTO confirmation FROM public.member_invitation_confirmations WHERE id=p_confirmation_id AND token_hash=p_token_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_token' USING ERRCODE='PT409'; END IF;
  -- Every path locks invitation before confirmation to avoid lock-order inversion.
  SELECT * INTO invitation FROM public.member_invitations WHERE id=confirmation.invitation_id FOR UPDATE;
  SELECT * INTO confirmation FROM public.member_invitation_confirmations WHERE id=p_confirmation_id AND token_hash=p_token_hash FOR UPDATE;
  IF confirmation.send_state<>'sent' OR confirmation.used_at IS NOT NULL OR confirmation.expires_at<=now()
    OR invitation.used_at IS NOT NULL OR invitation.revoked_at IS NOT NULL OR invitation.expires_at<=now()
    OR NOT public.livo_invitation_issuer(invitation)
    THEN RAISE EXCEPTION 'invalid_token' USING ERRCODE='PT409'; END IF;
  PERFORM 1 FROM auth.users WHERE id=p_auth_id AND lower(email)=confirmation.email AND email_confirmed_at IS NOT NULL
    AND created_at>=confirmation.created_at AND (banned_until IS NULL OR banned_until<=now()) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='PT403'; END IF;
  IF EXISTS(SELECT 1 FROM public.members WHERE lower(email)=confirmation.email OR auth_id=p_auth_id)
    THEN RAISE EXCEPTION 'email_taken' USING ERRCODE='PT409'; END IF;
  INSERT INTO public.members(id,name,email,avatar,color,role,job_title,is_qa_admin,is_active,auth_id)
    VALUES(p_member_id,confirmation.name,confirmation.email,upper(left(confirmation.name,1)),'#6B778C',invitation.role,invitation.job_title,invitation.is_qa_admin,true,p_auth_id);
  UPDATE public.member_invitations SET used_at=now(),used_member_id=p_member_id WHERE id=invitation.id;
  UPDATE public.member_invitation_confirmations SET used_at=now() WHERE id=confirmation.id;
  RETURN jsonb_build_object('success',true,'memberId',p_member_id);
END $$;

-- Compensates only an uncommitted fresh GoTrue login carrying service-written
-- proof. Locking its auth row makes concurrent FK adoption wait for the delete.
CREATE OR REPLACE FUNCTION public.livo_member_invitation_discard_auth(p_confirmation_id text,p_token_hash text,p_auth_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE confirmation public.member_invitation_confirmations%ROWTYPE; invitation public.member_invitations%ROWTYPE;
  owns_storage boolean:=false;
BEGIN
  SELECT * INTO confirmation FROM public.member_invitation_confirmations WHERE id=p_confirmation_id AND token_hash=p_token_hash;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO invitation FROM public.member_invitations WHERE id=confirmation.invitation_id FOR UPDATE;
  SELECT * INTO confirmation FROM public.member_invitation_confirmations WHERE id=p_confirmation_id AND token_hash=p_token_hash FOR UPDATE;
  IF invitation.used_at IS NOT NULL OR confirmation.used_at IS NOT NULL THEN RETURN false; END IF;
  PERFORM 1 FROM auth.users WHERE id=p_auth_id AND lower(email)=confirmation.email AND created_at>=confirmation.created_at
    AND raw_app_meta_data->'livo_member_invitation'->>'confirmation_id'=p_confirmation_id
    AND raw_app_meta_data->'livo_member_invitation'->>'token_hash'=p_token_hash FOR UPDATE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM public.members WHERE auth_id=p_auth_id) THEN RETURN false; END IF;
  -- Preserve users owning storage objects independently of provider behavior,
  -- for both current owner_id and older owner schema variants.
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='storage' AND table_name='objects' AND column_name='owner_id') THEN
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM storage.objects WHERE owner_id=$1)' INTO owns_storage USING p_auth_id::text;
    IF owns_storage THEN RETURN false; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='storage' AND table_name='objects' AND column_name='owner') THEN
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM storage.objects WHERE owner=$1)' INTO owns_storage USING p_auth_id;
    IF owns_storage THEN RETURN false; END IF;
  END IF;
  DELETE FROM auth.users WHERE id=p_auth_id;
  RETURN FOUND;
END $$;

-- Includes helper functions: no direct use by anon or a signed-in member.
DO $livo_invitation_permissions$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.proname LIKE 'livo_member_invitation_%' OR p.proname IN ('livo_invitation_actor','livo_invitation_issuer','livo_invitation_grant_allowed'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END LOOP;
END $livo_invitation_permissions$;
SELECT public.livo_apply_active_member_gate();
