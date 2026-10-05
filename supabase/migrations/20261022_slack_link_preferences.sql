-- A member can unlink their own Slack account in My settings.
--
-- Before this, "unbind" only cleared is_verified, and the next time the person used
-- LIVO from Slack the email match bound the same account again. Now the choice is
-- stored per member: while linking is disabled LIVO does not act for that Slack
-- account and does not send it direct messages, and nothing (email match, an owner's
-- manual mapping, an old client) can mark a Slack binding of theirs verified. The
-- person turns it back on in the same place; the next Slack action then proves the
-- account by email again.
--
-- Only the member changes their own setting, through livo_slack_link_set. Turning
-- linking back on creates no binding by itself. Repeatable: CREATE ... IF NOT
-- EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS before CREATE; no row is removed.
CREATE TABLE IF NOT EXISTS public.slack_link_preferences (
  member_id text PRIMARY KEY REFERENCES public.members(id) ON DELETE CASCADE,
  linking_disabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.slack_link_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.slack_link_preferences FROM anon, authenticated;
GRANT SELECT ON public.slack_link_preferences TO authenticated;
DROP POLICY IF EXISTS slack_link_preferences_own ON public.slack_link_preferences;
CREATE POLICY slack_link_preferences_own ON public.slack_link_preferences
  FOR SELECT TO authenticated USING (member_id = public.current_member_id());

CREATE OR REPLACE FUNCTION public.livo_slack_link_disabled(p_member_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.slack_link_preferences p WHERE p.member_id = p_member_id AND p.linking_disabled);
$$;
REVOKE ALL ON FUNCTION public.livo_slack_link_disabled(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.livo_slack_link_disabled(text) TO service_role;

-- No path may verify a Slack binding of a member who unlinked: the Slack email match
-- in the Edge Functions, an owner's manual mapping, or a direct write by an old client.
CREATE OR REPLACE FUNCTION public.livo_slack_link_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.platform = 'slack' AND NEW.is_verified AND public.livo_slack_link_disabled(NEW.member_id) THEN
    RAISE EXCEPTION 'slack_link_disabled' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_slack_link_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS livo_slack_link_guard ON public.external_account_bindings;
CREATE TRIGGER livo_slack_link_guard BEFORE INSERT OR UPDATE ON public.external_account_bindings
  FOR EACH ROW EXECUTE FUNCTION public.livo_slack_link_guard();

-- The caller's own state: whether linking is off, and the Slack account LIVO uses now.
CREATE OR REPLACE FUNCTION public.livo_slack_link_status()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  me text := public.current_member_id();
BEGIN
  IF me IS NULL OR NOT public.livo_is_active_member() THEN
    RAISE EXCEPTION 'slack_link_forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'disabled', public.livo_slack_link_disabled(me),
    'mode', 'binding',
    'linked', (SELECT jsonb_build_object('display_name', b.display_name, 'verified_by', b.verified_by, 'bound_at', b.bound_at)
                 FROM public.external_account_bindings b
                WHERE b.member_id = me AND b.platform = 'slack' AND b.is_verified
                ORDER BY b.bound_at DESC NULLS LAST LIMIT 1));
END;
$$;
REVOKE ALL ON FUNCTION public.livo_slack_link_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.livo_slack_link_status() TO authenticated;

-- Turns linking off (suspending every Slack binding of the caller) or back on.
CREATE OR REPLACE FUNCTION public.livo_slack_link_set(p_enabled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  me text := public.current_member_id();
BEGIN
  IF me IS NULL OR NOT public.livo_is_active_member() OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'slack_link_forbidden' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.slack_link_preferences (member_id, linking_disabled, updated_at)
  VALUES (me, NOT p_enabled, now())
  ON CONFLICT (member_id) DO UPDATE SET linking_disabled = EXCLUDED.linking_disabled, updated_at = EXCLUDED.updated_at;
  IF NOT p_enabled THEN
    UPDATE public.external_account_bindings
       SET is_verified = false, reconfirm_required = false
     WHERE member_id = me AND platform = 'slack' AND (is_verified OR reconfirm_required);
  END IF;
  RETURN public.livo_slack_link_status();
END;
$$;
REVOKE ALL ON FUNCTION public.livo_slack_link_set(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.livo_slack_link_set(boolean) TO authenticated;

SELECT public.livo_apply_active_member_gate();
