-- A project grant authorizes a minimal assignment directory, not member records.
-- Keep the existing service-only signature so every scoped read/commit path uses
-- the same candidates. No member Email, login, Slack or private-project data.
CREATE OR REPLACE FUNCTION public.livo_qa_external_roster(p_project_id text)
RETURNS TABLE(id text,name text,avatar text,color text,job_title text,is_active boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
  WITH participants(id) AS (
    SELECT unnest(ARRAY[q.assignee_id,q.qa_owner_id,q.reporter_id,q.data->'handoff'->>'nextOwnerId',
      q.data->'handoff'->>'requestedBy',q.data->'handoff'->>'acceptedBy',q.data->'handoff'->>'resolvedBy'])
    FROM public.qa_issues q WHERE q.workspace_id='default' AND q.project_id=p_project_id
    UNION SELECT c.coordinator_id FROM public.qa_project_coordination c
      WHERE c.workspace_id='default' AND c.id=p_project_id
  )
  SELECT m.id,m.name,m.avatar,m.color,''::text,m.is_active
  FROM public.members m
  WHERE EXISTS(SELECT 1 FROM public.projects p WHERE p.id=p_project_id)
    AND (m.is_active OR EXISTS(SELECT 1 FROM participants p WHERE p.id=m.id))
    AND NOT EXISTS(SELECT 1 FROM public.external_qa_accounts a WHERE a.id=m.id)
  UNION ALL
  SELECT a.id,a.name,''::text,''::text,''::text,
    a.is_active AND EXISTS(SELECT 1 FROM public.external_qa_project_grants g WHERE g.account_id=a.id AND g.project_id=p_project_id)
  FROM public.external_qa_accounts a
  WHERE (a.is_active AND EXISTS(SELECT 1 FROM public.external_qa_project_grants g WHERE g.account_id=a.id AND g.project_id=p_project_id))
    OR EXISTS(SELECT 1 FROM participants p WHERE p.id=a.id);
$$;
REVOKE ALL ON FUNCTION public.livo_qa_external_roster(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_external_roster(text) TO service_role;

-- Scope the new assignment guard to ordinary commands. Keep the full released
-- RPC implementation and its receipt/authorization order. Privileged historical
-- import/restore uses its separate entry point and may retain inactive owners.
DO $migration$
DECLARE original regprocedure:='public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb)'::regprocedure;
  definition text; original_owner name;
BEGIN
  IF to_regprocedure('public.livo_qa_commit_assignment_base(uuid,text,text,text,integer,text,jsonb,jsonb)') IS NULL THEN
    SELECT pg_get_functiondef(original),pg_get_userbyid(p.proowner) INTO definition,original_owner
      FROM pg_proc p WHERE p.oid=original;
    IF definition NOT LIKE 'CREATE OR REPLACE FUNCTION public.livo_qa_commit(%'
      OR position('livo_qa_commit_assignment_base' in definition)>0 THEN
      RAISE EXCEPTION 'qa_assignment_unrecognized_commit' USING ERRCODE='55000';
    END IF;
    -- Copy the complete implementation to a new, service-only OID. Replace the
    -- original in place below, retaining every existing normal-entry dependency.
    EXECUTE regexp_replace(definition,'^CREATE OR REPLACE FUNCTION public\.livo_qa_commit\(',
      'CREATE OR REPLACE FUNCTION public.livo_qa_commit_assignment_base(');
    EXECUTE format('ALTER FUNCTION public.livo_qa_commit_assignment_base(uuid,text,text,text,integer,text,jsonb,jsonb) OWNER TO %I',original_owner);
  END IF;
END $migration$;
REVOKE ALL ON FUNCTION public.livo_qa_commit_assignment_base(uuid,text,text,text,integer,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_commit_assignment_base(uuid,text,text,text,integer,text,jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_commit(p_auth_id uuid,p_issue_id text,p_command_id text,
  p_payload_hash text,p_expected_version integer,p_kind text,p_data jsonb,p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE previous_guard text:=current_setting('livo.qa_assignment_enforce',true); result jsonb;
BEGIN
  PERFORM set_config('livo.qa_assignment_enforce','true',true);
  result:=public.livo_qa_commit_assignment_base(p_auth_id,p_issue_id,p_command_id,
    p_payload_hash,p_expected_version,p_kind,p_data,p_event);
  PERFORM set_config('livo.qa_assignment_enforce',COALESCE(previous_guard,'false'),true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('livo.qa_assignment_enforce',COALESCE(previous_guard,'false'),true);
  RAISE;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) TO service_role;

-- Only a new repair assignment needs a live internal member. Preserve historical
-- inactive/legacy assignments on unrelated edits. FOR SHARE prevents deactivation
-- racing the actual commit; the existing RPC still checks actor/project grants.
CREATE OR REPLACE FUNCTION public.livo_qa_check_internal_assignee()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  IF current_setting('livo.qa_assignment_enforce',true)='true' AND NEW.assignee_id IS NOT NULL AND
    (TG_OP='INSERT' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id) THEN
    PERFORM 1 FROM public.members m
    WHERE m.id=NEW.assignee_id AND m.is_active
      AND NOT EXISTS(SELECT 1 FROM public.external_qa_accounts a WHERE a.id=m.id)
    FOR SHARE OF m;
    IF NOT FOUND THEN RAISE EXCEPTION 'qa_member_unavailable' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_check_internal_assignee() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_qa_internal_assignee ON public.qa_issues;
CREATE TRIGGER livo_qa_internal_assignee BEFORE INSERT OR UPDATE OF assignee_id ON public.qa_issues
FOR EACH ROW EXECUTE FUNCTION public.livo_qa_check_internal_assignee();
NOTIFY pgrst, 'reload schema';
