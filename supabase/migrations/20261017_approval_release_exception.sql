-- Release exception decision policy (product decision, 2026-10): whoever requested
-- a release exception never approves or rejects it, whatever their role. The shared
-- release core enforces this before livo_release_commit; this guard refuses the same
-- change at the database if a faulty adapter ever sends such an aggregate. Only a
-- pending exception becoming decided is checked, so existing history and restores
-- are untouched. Idempotent; no data is changed.
CREATE OR REPLACE FUNCTION public.livo_release_exception_decision_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF EXISTS(
    SELECT 1
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.data->'exceptions')='array' THEN NEW.data->'exceptions' ELSE '[]'::jsonb END) n(value)
    JOIN jsonb_array_elements(CASE WHEN jsonb_typeof(OLD.data->'exceptions')='array' THEN OLD.data->'exceptions' ELSE '[]'::jsonb END) o(value)
      ON o.value->>'id'=n.value->>'id'
    WHERE o.value->>'decision'='pending' AND n.value->>'decision' IS DISTINCT FROM 'pending'
      AND n.value->>'decidedBy' IS NOT DISTINCT FROM o.value->>'requestedBy') THEN
    RAISE EXCEPTION 'release_self_decision_forbidden' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS livo_release_exception_decision_guard ON public.release_batches;
CREATE TRIGGER livo_release_exception_decision_guard BEFORE UPDATE ON public.release_batches
  FOR EACH ROW EXECUTE FUNCTION public.livo_release_exception_decision_guard();
