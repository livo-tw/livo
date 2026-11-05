-- Realtime DELETE delivery does not evaluate row policies. Admit PostgreSQL
-- change subscriptions only for a live internal member, using the JWT claims
-- verified and stored by Realtime rather than an HTTP upgrade header.
CREATE OR REPLACE FUNCTION public.livo_realtime_internal_claims(p_claims jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
  SELECT COALESCE(p_claims->>'role'='authenticated',false)
    AND p_claims#>>'{app_metadata,livo_external_qa}' IS DISTINCT FROM 'true'
    AND EXISTS (
      SELECT 1 FROM public.members m
      WHERE m.auth_id::text=p_claims->>'sub' AND m.is_active
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.external_qa_accounts a
      WHERE a.auth_id::text=p_claims->>'sub'
    );
$$;
REVOKE ALL ON FUNCTION public.livo_realtime_internal_claims(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.livo_guard_realtime_subscription()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,realtime AS $$
BEGIN
  IF NOT public.livo_realtime_internal_claims(NEW.claims) THEN
    RAISE EXCEPTION 'realtime_internal_member_required' USING ERRCODE='42501';
  END IF;
  -- A concurrent disable/rebind waits until admission commits, then removes the
  -- subscription. It cannot finish cleanup before this new row is visible.
  PERFORM 1 FROM public.members m
    WHERE m.auth_id::text=NEW.claims->>'sub' AND m.is_active FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realtime_internal_member_required' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_guard_realtime_subscription() FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS livo_internal_realtime_subscription ON realtime.subscription;
CREATE TRIGGER livo_internal_realtime_subscription
  BEFORE INSERT OR UPDATE ON realtime.subscription
  FOR EACH ROW EXECUTE FUNCTION public.livo_guard_realtime_subscription();

CREATE OR REPLACE FUNCTION public.livo_remove_inactive_realtime_subscriptions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,realtime AS $$
BEGIN
  IF OLD.auth_id IS NOT NULL AND (TG_OP='DELETE'
    OR NEW.auth_id IS DISTINCT FROM OLD.auth_id OR NEW.is_active IS DISTINCT FROM true) THEN
    DELETE FROM realtime.subscription s
    WHERE s.claims->>'sub'=OLD.auth_id::text
      AND NOT public.livo_realtime_internal_claims(s.claims);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_remove_inactive_realtime_subscriptions() FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS livo_remove_inactive_realtime_subscriptions ON public.members;
CREATE TRIGGER livo_remove_inactive_realtime_subscriptions
  AFTER UPDATE OF auth_id,is_active OR DELETE ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.livo_remove_inactive_realtime_subscriptions();

-- Existing channels must also stop receiving internal deletion identifiers.
-- Only Realtime's transient subscription metadata is reconciled here.
-- This owner-only operation never modifies a LIVO business row or auth record.
CREATE OR REPLACE FUNCTION public.livo_reconcile_realtime_subscriptions()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,realtime AS $$
DECLARE removed integer;
BEGIN
  DELETE FROM realtime.subscription s WHERE NOT public.livo_realtime_internal_claims(s.claims);
  GET DIAGNOSTICS removed=ROW_COUNT;
  RETURN removed;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_reconcile_realtime_subscriptions() FROM PUBLIC,anon,authenticated,service_role;

SELECT public.livo_reconcile_realtime_subscriptions();
