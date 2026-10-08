-- Direct bearer invitations create new password logins without sending mail.
-- Login availability is separate from mailbox ownership and automatic identity.
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS email_identity_verified boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.livo_member_email_identity_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE trusted_service boolean:=coalesce(auth.role(),'')='service_role'
  OR (coalesce(auth.role(),'')='' AND session_user IN ('postgres','supabase_admin'));
BEGIN
  IF NOT trusted_service THEN
    IF TG_OP='INSERT' THEN
      -- Do not let a generic client insertion inherit the legacy trusted default.
      NEW.email_identity_verified:=false;
    ELSIF NEW.email_identity_verified IS DISTINCT FROM OLD.email_identity_verified THEN
      RAISE EXCEPTION 'email_identity_server_only' USING ERRCODE='PT403';
    END IF;
  END IF;
  -- Changing a mailbox invalidates old ownership, including service updates.
  IF TG_OP='UPDATE' AND NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.email_identity_verified:=false;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.livo_member_email_identity_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_member_email_identity_guard ON public.members;
CREATE TRIGGER livo_member_email_identity_guard BEFORE INSERT OR UPDATE OF email,email_identity_verified ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.livo_member_email_identity_guard();

CREATE OR REPLACE FUNCTION public.livo_member_invitation_accept_direct(
  p_invitation_id text,p_token_hash text,p_auth_id uuid,p_member_id text,p_name text,p_email text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE invitation public.member_invitations%ROWTYPE;
  joined_name text:=trim(coalesce(p_name,'')); joined_email text:=lower(trim(coalesce(p_email,'')));
BEGIN
  IF length(joined_name)<1 OR length(joined_name)>80 OR joined_name ~ '[[:cntrl:]]'
    OR length(joined_email)>254 OR joined_email LIKE '%.invalid'
    OR joined_email !~ '^[^[:space:]@,;<>''"()]+@[^[:space:]@,;<>''"()]+\.[a-z0-9-]{2,}$'
    OR p_member_id IS NULL OR length(p_member_id)<1 OR length(p_member_id)>200
    THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE='PT400'; END IF;
  SELECT * INTO invitation FROM public.member_invitations
    WHERE id=p_invitation_id AND token_hash=p_token_hash FOR UPDATE;
  IF NOT FOUND OR invitation.used_at IS NOT NULL OR invitation.revoked_at IS NOT NULL
    OR invitation.expires_at<=now() OR NOT public.livo_invitation_issuer(invitation)
    THEN RAISE EXCEPTION 'invalid_token' USING ERRCODE='PT409'; END IF;
  -- The Edge Function may only attach its newly created GoTrue login. An
  -- already confirmed login from another flow cannot be adopted or reset here.
  PERFORM 1 FROM auth.users WHERE id=p_auth_id AND lower(trim(email))=joined_email
    AND email_confirmed_at IS NOT NULL AND created_at>=invitation.created_at
    AND (banned_until IS NULL OR banned_until<=now())
    AND raw_app_meta_data->'email_identity_verified'='false'::jsonb
    AND raw_app_meta_data->'livo_member_invitation_direct'->>'invitation_id'=p_invitation_id
    AND raw_app_meta_data->'livo_member_invitation_direct'->>'token_hash'=p_token_hash FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='PT403'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('livo-member-email:'||joined_email,0));
  IF EXISTS(SELECT 1 FROM public.members WHERE lower(trim(email))=joined_email OR auth_id=p_auth_id)
    THEN RAISE EXCEPTION 'email_taken' USING ERRCODE='PT409'; END IF;
  -- Existing members constraints/triggers remain active; failure rolls back the claim.
  INSERT INTO public.members(id,name,email,avatar,color,role,job_title,is_qa_admin,is_active,auth_id,email_identity_verified)
    VALUES(p_member_id,joined_name,joined_email,upper(left(joined_name,1)),'#6B778C',
      invitation.role,invitation.job_title,invitation.is_qa_admin,true,p_auth_id,false);
  UPDATE public.member_invitations SET used_at=now(),used_member_id=p_member_id
    WHERE id=invitation.id AND token_hash=p_token_hash AND used_at IS NULL AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_token' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('success',true,'memberId',p_member_id);
END $$;

REVOKE ALL ON FUNCTION public.livo_member_invitation_accept_direct(text,text,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_member_invitation_accept_direct(text,text,uuid,text,text,text) TO service_role;
