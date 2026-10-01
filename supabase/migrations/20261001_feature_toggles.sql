-- Team feature switches reuse system_settings and its existing admin role floor.
INSERT INTO public.system_settings (key, value)
VALUES ('feature_toggles', jsonb_build_object('approvals',
  EXISTS (SELECT 1 FROM public.approval_rules) OR EXISTS (SELECT 1 FROM public.approval_requests)))
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.livo_approvals_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT CASE WHEN jsonb_typeof(value->'approvals') = 'boolean'
      THEN (value->>'approvals')::boolean END
     FROM public.system_settings WHERE key = 'feature_toggles'),
    EXISTS (SELECT 1 FROM public.approval_rules) OR EXISTS (SELECT 1 FROM public.approval_requests));
$$;

CREATE OR REPLACE FUNCTION public.livo_guard_feature_toggles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.key = 'feature_toggles' THEN
    PERFORM pg_advisory_xact_lock(hashtext('livo-approval-feature'));
    IF NEW.value->'approvals' = 'false'::jsonb AND (
      EXISTS (SELECT 1 FROM public.approval_requests WHERE status = 'pending') OR
      EXISTS (SELECT 1 FROM public.tasks WHERE approval_status = 'pending_approval' OR current_approval_id IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'Withdraw pending approvals before disabling' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS livo_guard_feature_toggles ON public.system_settings;
CREATE TRIGGER livo_guard_feature_toggles BEFORE INSERT OR UPDATE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.livo_guard_feature_toggles();

CREATE OR REPLACE FUNCTION public.livo_guard_approval_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-approval-feature'));
  IF TG_TABLE_NAME = 'approval_requests' THEN
    IF NEW.status = 'pending' AND NOT public.livo_approvals_enabled() THEN
      RAISE EXCEPTION 'Approval workflow is disabled' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'tasks' THEN
    IF NEW.approval_status = 'pending_approval' AND (
      NOT public.livo_approvals_enabled() OR NOT EXISTS (
        SELECT 1 FROM public.approval_requests WHERE id = NEW.current_approval_id
        AND task_id = NEW.id AND status = 'pending'
      )
    ) THEN
      RAISE EXCEPTION 'Approval request is no longer pending' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'notifications' THEN
    IF NEW.type LIKE 'approval\_%' ESCAPE '\' AND NOT public.livo_approvals_enabled() THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS livo_guard_approval_request ON public.approval_requests;
CREATE TRIGGER livo_guard_approval_request BEFORE INSERT OR UPDATE ON public.approval_requests
FOR EACH ROW EXECUTE FUNCTION public.livo_guard_approval_write();
DROP TRIGGER IF EXISTS livo_guard_approval_task ON public.tasks;
CREATE TRIGGER livo_guard_approval_task BEFORE INSERT OR UPDATE OF approval_status, current_approval_id ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.livo_guard_approval_write();
DROP TRIGGER IF EXISTS livo_guard_approval_notification ON public.notifications;
CREATE TRIGGER livo_guard_approval_notification BEFORE INSERT ON public.notifications
FOR EACH ROW EXECUTE FUNCTION public.livo_guard_approval_write();

-- Cancellation and clearing the task commit together, including admin withdrawal.
CREATE OR REPLACE FUNCTION public.livo_clear_withdrawn_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status = 'pending' THEN
    UPDATE public.tasks SET approval_status = NULL, current_approval_id = NULL
    WHERE id = NEW.task_id AND current_approval_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS livo_clear_withdrawn_approval ON public.approval_requests;
CREATE TRIGGER livo_clear_withdrawn_approval AFTER UPDATE OF status ON public.approval_requests
FOR EACH ROW EXECUTE FUNCTION public.livo_clear_withdrawn_approval();
