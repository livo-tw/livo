-- Login email is not proof of ownership. Direct invitation joins store false.
-- Keep existing opt-out, active-member, issuer and caller checks; no business
-- row is removed and legitimate owner-issued manual mappings remain usable.
-- SECURITY INVOKER preserves the caller's existing table/RLS visibility.
CREATE OR REPLACE FUNCTION public.livo_slack_binding_identity_trusted(p_binding_id text,p_member_id text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.external_account_bindings b
    JOIN public.members m ON m.id=b.member_id
    WHERE b.id::text=p_binding_id AND b.member_id=p_member_id AND b.platform='slack'
      AND b.is_verified IS TRUE AND b.reconfirm_required IS NOT TRUE
      AND m.is_active IS TRUE AND m.auth_id IS NOT NULL
      AND (b.verified_by='email' AND m.email_identity_verified IS TRUE
        OR b.verified_by='admin' AND EXISTS(SELECT 1 FROM public.members issuer
          WHERE issuer.id=b.verified_by_member_id AND issuer.role='super_admin' AND issuer.is_active IS TRUE))
      AND NOT EXISTS(SELECT 1 FROM public.slack_link_preferences pref
        WHERE pref.member_id=m.id AND pref.linking_disabled IS TRUE));
$$;
REVOKE ALL ON FUNCTION public.livo_slack_binding_identity_trusted(text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.livo_slack_binding_identity_trusted(text,text) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.livo_slack_email_identity_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.platform='slack' AND NEW.is_verified IS TRUE AND NEW.verified_by='email'
    AND NOT EXISTS(SELECT 1 FROM public.members m WHERE m.id=NEW.member_id AND m.email_identity_verified IS TRUE) THEN
    RAISE EXCEPTION 'slack_email_identity_unverified' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_slack_email_identity_guard() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_slack_email_identity_guard ON public.external_account_bindings;
CREATE TRIGGER livo_slack_email_identity_guard BEFORE INSERT OR UPDATE ON public.external_account_bindings
  FOR EACH ROW EXECUTE FUNCTION public.livo_slack_email_identity_guard();

CREATE OR REPLACE FUNCTION public.livo_slack_suspend_unverified_email_bindings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.email_identity_verified IS NOT TRUE THEN
    UPDATE public.external_account_bindings SET is_verified=false,reconfirm_required=true
      WHERE member_id=NEW.id AND platform='slack' AND verified_by='email' AND is_verified IS TRUE;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_slack_suspend_unverified_email_bindings() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_slack_suspend_unverified_email_bindings ON public.members;
CREATE TRIGGER livo_slack_suspend_unverified_email_bindings AFTER UPDATE OF email,email_identity_verified ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.livo_slack_suspend_unverified_email_bindings();
UPDATE public.external_account_bindings b SET is_verified=false,reconfirm_required=true
  WHERE b.platform='slack' AND b.verified_by='email' AND b.is_verified IS TRUE
    AND EXISTS(SELECT 1 FROM public.members m WHERE m.id=b.member_id AND m.email_identity_verified IS NOT TRUE);

-- Preserve each installed function's full current definition, owner, grants,
-- security mode and search_path, including prior PT409 conflict rewrites.
-- Only the exact existing identity predicate is extended. Unknown definitions
-- fail closed instead of silently leaving one authorization path unguarded.
DO $livo_email_identity_consumers$
DECLARE spec record; fn record; definition text; fixed text;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('livo_slack_session','AND m.id=public.current_member_id()','AND public.livo_slack_binding_identity_trusted(b.id::text,m.id) AND m.id=public.current_member_id()'),
    ('livo_slack_commit','AND member_id=actor AND is_verified;','AND member_id=actor AND is_verified AND public.livo_slack_binding_identity_trusted(id::text,actor);'),
    ('livo_slack_queue_weekly','AND b.is_verified AND b.verified_by IN (''email'',''admin'')','AND b.is_verified AND public.livo_slack_binding_identity_trusted(b.id::text,m.id) AND b.verified_by IN (''email'',''admin'')'),
    ('livo_slack_update','AND b.platform=''slack'' AND b.is_verified AND m.is_active','AND b.platform=''slack'' AND b.is_verified AND public.livo_slack_binding_identity_trusted(b.id::text,m.id) AND m.is_active'),
    ('livo_approval_command','OR slack_binding.is_verified IS DISTINCT FROM true','OR slack_binding.is_verified IS DISTINCT FROM true OR NOT public.livo_slack_binding_identity_trusted(slack_binding.id::text,actor.id)'),
    ('livo_task_planning_actor','OR binding.is_verified IS DISTINCT FROM true','OR binding.is_verified IS DISTINCT FROM true OR NOT public.livo_slack_binding_identity_trusted(binding.id::text,actor)'),
    ('livo_task_work_command','OR binding.is_verified IS DISTINCT FROM true','OR binding.is_verified IS DISTINCT FROM true OR NOT public.livo_slack_binding_identity_trusted(binding.id::text,actor.id)'),
    ('kb_slack_search','AND b.member_id=public.current_member_id()','AND public.livo_slack_binding_identity_trusted(b.id::text,b.member_id) AND b.member_id=public.current_member_id()'),
    ('kb_work_identity','OR b.is_verified IS DISTINCT FROM true','OR b.is_verified IS DISTINCT FROM true OR NOT public.livo_slack_binding_identity_trusted(b.id::text,a.id)'),
    ('livo_qa_live_actor','OR binding.is_verified IS DISTINCT FROM true','OR binding.is_verified IS DISTINCT FROM true OR NOT public.livo_slack_binding_identity_trusted(binding.id::text,actor.id)'),
    ('livo_release_commit','OR binding.is_verified IS DISTINCT FROM true','OR binding.is_verified IS DISTINCT FROM true OR NOT public.livo_slack_binding_identity_trusted(binding.id::text,actor.id)'),
    ('livo_release_can_deliver','OR binding.is_verified IS DISTINCT FROM true','OR binding.is_verified IS DISTINCT FROM true OR NOT public.livo_slack_binding_identity_trusted(binding.id::text,publication.published_by)'),
    ('livo_slack_link_status','AND b.platform = ''slack'' AND b.is_verified','AND b.platform = ''slack'' AND b.is_verified AND public.livo_slack_binding_identity_trusted(b.id::text,me)')
  ) AS rules(name,old_predicate,new_predicate)
  LOOP
    FOR fn IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prokind='f' AND p.proname=spec.name
    LOOP
      definition:=pg_get_functiondef(fn.oid);
      IF position(spec.new_predicate IN definition)>0 THEN CONTINUE; END IF;
      IF (length(definition)-length(replace(definition,spec.old_predicate,'')))/length(spec.old_predicate)<>1 THEN
        RAISE EXCEPTION 'email_identity_guard_unknown_function: %',spec.name;
      END IF;
      fixed:=replace(definition,spec.old_predicate,spec.new_predicate);
      EXECUTE fixed;
    END LOOP;
  END LOOP;
END;
$livo_email_identity_consumers$;
SELECT public.livo_apply_active_member_gate();
