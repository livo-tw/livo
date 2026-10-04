-- ============================================================================
-- Migration: 20261017_slack_admin_binding_issuer.sql
-- One trust rule for manual (admin) Slack mappings, the one kb_slack_search
-- introduced: a mapping with verified_by='admin' is trusted only while the
-- member who made it (verified_by_member_id) is an active super_admin.
--
-- Older mappings made by a plain admin, legacy rows without an issuer, and
-- mappings whose owner was later demoted, deactivated or removed are suspended
-- (is_verified=false, reconfirm_required=true). Every SQL identity check already
-- requires is_verified (livo_slack_session, kb_work_identity, the approval,
-- task-work, QA, planning and release command RPCs, delivery queueing), so they
-- all treat such a Slack user as unbound until a super_admin maps it again.
-- The Slack settings list keeps showing suspended rows with a reconfirm hint.
--
-- Non-destructive and idempotent: no row is deleted; the binding, its issuer
-- and audit links stay. Re-running only suspends rows that are still untrusted.
-- ============================================================================

ALTER TABLE public.external_account_bindings ADD COLUMN IF NOT EXISTS verified_by_member_id text;
ALTER TABLE public.external_account_bindings ADD COLUMN IF NOT EXISTS reconfirm_required boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.livo_slack_issuer_trusted(p_issuer text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
  SELECT p_issuer IS NOT NULL AND EXISTS (SELECT 1 FROM public.members issuer
    WHERE issuer.id::text=p_issuer AND issuer.role='super_admin' AND issuer.is_active);
$$;
REVOKE ALL ON FUNCTION public.livo_slack_issuer_trusted(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.livo_slack_issuer_trusted(text) TO authenticated, service_role;

-- Every write path (the owner-only bind action, email re-verification, unbind,
-- a direct service-role write) passes here. An untrusted manual mapping can
-- never be stored as verified.
CREATE OR REPLACE FUNCTION public.livo_slack_binding_issuer_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF NEW.platform IS DISTINCT FROM 'slack' OR NEW.is_verified IS NOT TRUE THEN RETURN NEW; END IF;
  IF NEW.verified_by IS DISTINCT FROM 'admin' THEN
    NEW.reconfirm_required := false;
  ELSIF public.livo_slack_issuer_trusted(NEW.verified_by_member_id) THEN
    NEW.reconfirm_required := false;
  ELSE
    NEW.is_verified := false;
    NEW.reconfirm_required := true;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS livo_slack_binding_issuer ON public.external_account_bindings;
CREATE TRIGGER livo_slack_binding_issuer BEFORE INSERT OR UPDATE ON public.external_account_bindings
FOR EACH ROW EXECUTE FUNCTION public.livo_slack_binding_issuer_guard();

-- Owner changes revoke the mappings that owner made, in the same transaction.
-- SECURITY DEFINER: a super_admin demoting someone through the API runs as
-- authenticated, which livo_guard_slack_binding refuses for Slack rows.
CREATE OR REPLACE FUNCTION public.livo_slack_suspend_untrusted_bindings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE public.external_account_bindings SET is_verified=false, reconfirm_required=true
    WHERE platform='slack' AND is_verified AND verified_by='admin'
      AND NOT public.livo_slack_issuer_trusted(verified_by_member_id);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_slack_suspend_untrusted_bindings() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS livo_slack_issuer_change ON public.members;
CREATE TRIGGER livo_slack_issuer_change AFTER UPDATE OF role, is_active OR DELETE ON public.members
FOR EACH STATEMENT EXECUTE FUNCTION public.livo_slack_suspend_untrusted_bindings();

-- Existing installations: suspend mappings that are untrusted today.
UPDATE public.external_account_bindings SET is_verified=false, reconfirm_required=true
  WHERE platform='slack' AND is_verified AND verified_by='admin'
    AND NOT public.livo_slack_issuer_trusted(verified_by_member_id);

NOTIFY pgrst, 'reload schema';
