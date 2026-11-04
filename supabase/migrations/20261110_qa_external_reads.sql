-- QA event details can contain references recorded before a project move.
CREATE OR REPLACE FUNCTION public.livo_qa_external_event_detail(
  p_type text, p_detail text, p_project_id text, p_current_duplicate text
)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE
  fields jsonb;
  previous_project text;
  next_project text;
  event_duplicate text;
BEGIN
  IF p_type = 'link_tasks' THEN RETURN ''; END IF;

  IF p_type = 'update_fields' THEN
    BEGIN
      fields := p_detail::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN RETURN '';
    END;
    IF jsonb_typeof(fields) IS DISTINCT FROM 'object' THEN RETURN ''; END IF;
    previous_project := fields#>>'{before,projectId}';
    next_project := fields#>>'{after,projectId}';
    IF (previous_project IS NOT NULL AND previous_project <> p_project_id)
      OR (next_project IS NOT NULL AND next_project <> p_project_id)
    THEN RETURN ''; END IF;
  END IF;

  IF p_type = 'close' THEN
    -- The QA domain appends the duplicate ID on the last line for this resolution.
    IF split_part(p_detail,E'\n',1) = 'duplicate' THEN
      event_duplicate := reverse(split_part(reverse(p_detail),E'\n',1));
    END IF;
    IF EXISTS (
      SELECT 1 FROM unnest(ARRAY[event_duplicate,p_current_duplicate]) AS linked(id)
      WHERE linked.id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.qa_issues q
        WHERE q.workspace_id = 'default' AND q.id = linked.id AND q.project_id = p_project_id
      )
    ) THEN RETURN ''; END IF;
  END IF;

  RETURN p_detail;
END;
$$;

REVOKE ALL ON FUNCTION public.livo_qa_external_event_detail(text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_external_event_detail(text,text,text,text) TO service_role;
-- The QA Edge Function supplies the auth UUID after validating the GoTrue session.
-- Keep the project grant and every selected QA row in one database snapshot.
CREATE OR REPLACE FUNCTION public.livo_qa_external_read(
  p_auth_id uuid, p_action text, p_input jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE
  actor public.external_qa_accounts%ROWTYPE;
  issue public.qa_issues%ROWTYPE;
  qa_enabled boolean := public.livo_qa_enabled();
  selected_project_id text := p_input->>'projectId';
  result jsonb;
  page_offset integer;
  page_limit integer;
  search_term text;
  search_id boolean;
  sort_field text;
  sort_direction text;
BEGIN
  SELECT a.* INTO actor
  FROM public.external_qa_accounts a
  WHERE a.auth_id = p_auth_id AND a.is_active
    AND NOT EXISTS (SELECT 1 FROM public.members m WHERE m.auth_id = a.auth_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;

  IF p_action = 'profile' THEN
    IF NOT qa_enabled THEN
      RETURN jsonb_build_object('external',true,'id',actor.id,'name',actor.name,'qaEnabled',false,
        'environments','[]'::jsonb,'projects','[]'::jsonb,'members','[]'::jsonb);
    END IF;
    WITH granted AS (
      SELECT p.id, p.name, p.line_id, p.color, p.is_archived
      FROM public.external_qa_project_grants g
      JOIN public.projects p ON p.id = g.project_id
      WHERE g.account_id = actor.id
    ), roster AS (
      SELECT DISTINCT ON (r.id) r.*
      FROM granted g
      CROSS JOIN LATERAL public.livo_qa_external_roster(g.id) r
      ORDER BY r.id
    )
    SELECT jsonb_build_object(
      'external',true,'id',actor.id,'name',actor.name,'qaEnabled',true,
      'environments',to_jsonb(public.livo_deployment_environment_values()),
      'projects',COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'lineId',g.line_id,
          'color',g.color,'isArchived',g.is_archived) ORDER BY g.name,g.id)
        FROM granted g
      ),'[]'::jsonb),
      'members',COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'avatar',r.avatar,
          'color',r.color,'jobTitle',r.job_title,'isActive',r.is_active) ORDER BY r.name,r.id)
        FROM roster r
      ),'[]'::jsonb)
    ) INTO result;
    RETURN result;
  END IF;

  IF NOT qa_enabled THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;

  IF p_action IN ('versions','coordination','members','people','task_references')
    AND NOT EXISTS (
      SELECT 1 FROM public.external_qa_project_grants g
      WHERE g.account_id = actor.id AND g.project_id = selected_project_id
    )
  THEN RAISE EXCEPTION 'qa_project_unavailable' USING ERRCODE='P0002'; END IF;

  CASE p_action
  WHEN 'list' THEN
    page_offset := COALESCE((p_input->>'offset')::integer,0);
    page_limit := COALESCE((p_input->>'limit')::integer,50);
    IF page_offset NOT BETWEEN 0 AND 100000 OR page_limit NOT BETWEEN 1 AND 100 THEN
      RAISE EXCEPTION 'qa_invalid_page' USING ERRCODE='22023';
    END IF;

    search_term := NULLIF(btrim(p_input->>'search'),'');
    search_id := search_term ~* '^(#[a-z0-9_-]{1,64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$';
    IF search_id AND left(search_term,1) = '#' THEN search_term := substr(search_term,2); END IF;
    sort_field := COALESCE(p_input->>'sort','updated');
    sort_direction := COALESCE(p_input->>'direction',CASE WHEN sort_field = 'dueDate' THEN 'asc' ELSE 'desc' END);
    IF sort_field NOT IN ('updated','priority','createdAt','dueDate') OR sort_direction NOT IN ('asc','desc')
      OR COALESCE(p_input->>'mine','') NOT IN ('','assigned','testing','reported','involved','handoff')
    THEN RAISE EXCEPTION 'qa_invalid_filter' USING ERRCODE='22023'; END IF;

    WITH matched AS MATERIALIZED (
      SELECT q.id, q.project_id, q.updated_at, q.data
      FROM public.external_qa_project_grants g
      JOIN public.qa_issues q ON q.project_id = g.project_id AND q.workspace_id = 'default'
      WHERE g.account_id = actor.id
        AND (selected_project_id IS NULL OR q.project_id = selected_project_id)
        AND (NOT (p_input ? 'projectIds') OR p_input->'projectIds' ? q.project_id)
        AND (p_input->>'state' IS NULL OR q.state = p_input->>'state')
        AND (NOT (p_input ? 'states') OR p_input->'states' ? q.state)
        AND (NOT (p_input ? 'assigneeIds') OR p_input->'assigneeIds' ? q.assignee_id)
        AND (NOT (p_input ? 'qaOwnerIds') OR p_input->'qaOwnerIds' ? q.qa_owner_id)
        AND (NOT (p_input ? 'reporterIds') OR p_input->'reporterIds' ? q.reporter_id)
        AND (NOT (p_input ? 'priorities') OR p_input->'priorities' @> jsonb_build_array(q.data->'priority'))
        AND (NOT (p_input ? 'severities') OR p_input->'severities' ? (q.data->>'severity'))
        AND (search_term IS NULL OR strpos(lower(CASE WHEN search_id THEN q.id ELSE q.title END),lower(search_term)) > 0)
        AND CASE p_input->>'mine'
          WHEN 'assigned' THEN q.assignee_id = actor.id
          WHEN 'testing' THEN q.qa_owner_id = actor.id
          WHEN 'reported' THEN q.reporter_id = actor.id
          WHEN 'involved' THEN actor.id IN (q.assignee_id,q.qa_owner_id,q.reporter_id)
          WHEN 'handoff' THEN q.data->'handoff'->>'nextOwnerId' = actor.id AND q.data->'handoff'->>'resolvedAt' IS NULL
          ELSE true END
    ), ordered AS (
      SELECT project_id, data, row_number() OVER (ORDER BY
        CASE WHEN sort_field = 'updated' AND sort_direction = 'asc' THEN updated_at END ASC,
        CASE WHEN sort_field = 'priority' AND sort_direction = 'asc' THEN data->'priority' END DESC,
        CASE WHEN sort_field = 'priority' AND sort_direction = 'desc' THEN data->'priority' END ASC,
        CASE WHEN sort_field = 'createdAt' AND sort_direction = 'asc' THEN data->>'createdAt' END ASC,
        CASE WHEN sort_field = 'createdAt' AND sort_direction = 'desc' THEN data->>'createdAt' END DESC,
        CASE WHEN sort_field = 'dueDate' AND sort_direction = 'asc' THEN data->>'dueDate' END ASC NULLS LAST,
        CASE WHEN sort_field = 'dueDate' AND sort_direction = 'desc' THEN data->>'dueDate' END DESC NULLS LAST,
        updated_at DESC, id
      ) AS ordinal
      FROM matched
    ), page AS (
      SELECT project_id, data, ordinal FROM ordered ORDER BY ordinal LIMIT page_limit OFFSET page_offset
    )
    SELECT jsonb_build_object('issues',COALESCE((SELECT jsonb_agg(public.livo_qa_external_issue_data(data, project_id) ORDER BY ordinal) FROM page),'[]'::jsonb),
      'total',count(*),'hasMore',page_offset + page_limit < count(*))
    INTO result FROM matched;

  WHEN 'get','issue' THEN
    SELECT q.* INTO issue
    FROM public.qa_issues q
    JOIN public.external_qa_project_grants g ON g.project_id = q.project_id
    WHERE q.workspace_id = 'default' AND q.id = p_input->>'id' AND g.account_id = actor.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'qa_issue_not_found' USING ERRCODE='P0002'; END IF;
    IF p_action = 'issue' THEN RETURN issue.data; END IF;

    SELECT jsonb_build_object('issue',public.livo_qa_external_issue_data(issue.data, issue.project_id),
      'memberNames',COALESCE((
        SELECT jsonb_object_agg(r.id,r.name)
        FROM public.livo_qa_external_roster(issue.project_id) r
        WHERE r.id IN (issue.assignee_id,issue.qa_owner_id,issue.reporter_id,
          issue.data->'handoff'->>'nextOwnerId',issue.data->'handoff'->>'requestedBy',
          issue.data->'handoff'->>'acceptedBy',issue.data->'handoff'->>'resolvedBy')
      ),'{}'::jsonb),
      'coordination',jsonb_build_object('projectId',issue.project_id,'coordinatorId',c.coordinator_id,'version',COALESCE(c.version,0)),
      'comments',COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id',q.id,'issueId',q.issue_id,'actorId',q.actor_id,
          'body',q.body,'createdAt',q.created_at) ORDER BY q.created_at,q.id)
        FROM public.qa_comments q WHERE q.workspace_id = issue.workspace_id AND q.issue_id = issue.id
      ),'[]'::jsonb),
      'events',COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id',q.id,'issueId',q.issue_id,'actorId',q.actor_id,
          'type',q.type,'detail',public.livo_qa_external_event_detail(q.type,q.detail,issue.project_id,issue.data->>'duplicateOfId'),
          'version',q.version,'createdAt',q.created_at) ORDER BY q.created_at,q.id)
        FROM public.qa_events q WHERE q.workspace_id = issue.workspace_id AND q.issue_id = issue.id
      ),'[]'::jsonb),
      'attachments',COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id',a.id,'issueId',a.issue_id,'fileName',a.file_name,
          'mimeType',a.mime_type,'size',a.size,'uploadedBy',a.uploaded_by,'createdAt',a.created_at)
          ORDER BY a.created_at,a.id)
        FROM public.qa_attachments a WHERE a.workspace_id = issue.workspace_id AND a.issue_id = issue.id
      ),'[]'::jsonb)
    ) INTO result
    FROM (SELECT 1) seed
    LEFT JOIN public.qa_project_coordination c ON c.id = issue.project_id AND c.workspace_id = issue.workspace_id;

  WHEN 'receipt' THEN
    SELECT CASE WHEN r.response ? 'projectId'
      THEN jsonb_set(to_jsonb(r),'{response}',public.livo_qa_external_issue_data(r.response,r.response->>'projectId'))
      ELSE to_jsonb(r) END INTO result
    FROM public.qa_commands r
    JOIN public.qa_issues q ON q.id = r.issue_id AND q.workspace_id = r.workspace_id
    JOIN public.external_qa_project_grants g ON g.project_id = q.project_id
    WHERE r.workspace_id = 'default' AND r.id = p_input->>'commandId' AND r.issue_id = p_input->>'id'
      AND r.actor_id = actor.id AND g.account_id = actor.id
      AND (NOT (r.response ? 'projectId') OR EXISTS (
        SELECT 1 FROM public.external_qa_project_grants original
        WHERE original.account_id = actor.id AND original.project_id = r.response->>'projectId'
      ));

  WHEN 'attachment' THEN
    SELECT to_jsonb(a) INTO result
    FROM public.qa_attachments a
    JOIN public.qa_issues q ON q.id = a.issue_id AND q.workspace_id = a.workspace_id
    JOIN public.external_qa_project_grants g ON g.project_id = q.project_id
    WHERE a.workspace_id = 'default' AND a.id = p_input->>'attachmentId' AND g.account_id = actor.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'qa_attachment_not_found' USING ERRCODE='P0002'; END IF;

  WHEN 'versions' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('workspaceId',q.workspace_id,'projectId',q.project_id,
      'observedVersion',q.data->>'observedVersion','targets',q.data->'targets','runs',q.data->'runs')),'[]'::jsonb)
    INTO result FROM public.qa_issues q
    WHERE q.workspace_id = 'default' AND q.project_id = selected_project_id;

  WHEN 'coordination' THEN
    SELECT jsonb_build_object('projectId',selected_project_id,'coordinatorId',c.coordinator_id,'version',COALESCE(c.version,0))
    INTO result FROM (SELECT 1) seed
    LEFT JOIN public.qa_project_coordination c ON c.id = selected_project_id AND c.workspace_id = 'default';

  WHEN 'people' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id) ORDER BY r.id),'[]'::jsonb)
    INTO result
    FROM public.livo_qa_external_roster(selected_project_id) r
    WHERE r.is_active AND p_input->'ids' ? r.id;

  WHEN 'members','task_references' THEN
    page_offset := COALESCE((p_input->>'offset')::integer,0);
    search_term := NULLIF(btrim(p_input->>'search'),'');
    IF page_offset NOT BETWEEN 0 AND 100000 OR length(search_term) > 100 THEN
      RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023';
    END IF;
    IF p_action = 'members' THEN
      WITH page AS (
        SELECT r.*
        FROM public.livo_qa_external_roster(selected_project_id) r
        WHERE r.is_active AND (search_term IS NULL OR strpos(lower(r.name),lower(search_term)) > 0)
        ORDER BY r.name,r.id LIMIT 101 OFFSET page_offset
      ), visible AS (SELECT * FROM page ORDER BY name,id LIMIT 100)
      SELECT jsonb_build_object('members',COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'avatar',r.avatar,'color',r.color,
          'jobTitle',r.job_title,'isActive',r.is_active) ORDER BY r.name,r.id) FROM visible r
      ),'[]'::jsonb),'hasMore',(SELECT count(*) > 100 FROM page))
      INTO result;
    ELSE
      WITH page AS (
        SELECT t.id,t.task_key,t.title FROM public.tasks t
        WHERE t.project_id = selected_project_id
          AND (NOT (p_input ? 'taskIds') OR p_input->'taskIds' ? t.id)
          AND (search_term IS NULL OR strpos(lower(t.task_key || ' ' || t.title),lower(search_term)) > 0)
        ORDER BY t.task_key,t.id LIMIT 101 OFFSET page_offset
      ), visible AS (SELECT * FROM page ORDER BY task_key,id LIMIT 100)
      SELECT jsonb_build_object('tasks',COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id',t.id,'taskKey',t.task_key,'title',t.title) ORDER BY t.task_key,t.id)
        FROM visible t
      ),'[]'::jsonb),'hasMore',(SELECT count(*) > 100 FROM page))
      INTO result;
    END IF;

  ELSE RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501';
  END CASE;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.livo_qa_external_read(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_external_read(uuid,text,jsonb) TO service_role;

-- Ordinary QA adds only the external candidates granted to this project.
-- The existing internal directory remains supplied by the ordinary app.
CREATE OR REPLACE FUNCTION public.livo_qa_internal_external_people(p_auth_id uuid,p_project_id text,p_search text,p_offset integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  IF NOT public.livo_qa_enabled() OR NOT EXISTS (
    SELECT 1 FROM public.members m WHERE m.auth_id=p_auth_id AND m.is_active
  ) THEN RAISE EXCEPTION 'qa_forbidden' USING ERRCODE='42501'; END IF;
  IF p_offset IS NULL OR p_offset<0 OR p_offset>100000 OR length(COALESCE(p_search,''))>100 THEN
    RAISE EXCEPTION 'qa_invalid_request' USING ERRCODE='22023'; END IF;
  WITH page AS (
    SELECT a.id,a.name FROM public.external_qa_accounts a
    JOIN public.external_qa_project_grants g ON g.account_id=a.id
    JOIN public.projects p ON p.id=g.project_id
    WHERE a.is_active AND p.id=p_project_id
      AND strpos(lower(a.name),lower(COALESCE(p_search,'')))>0
    ORDER BY lower(a.name),a.id LIMIT 101 OFFSET p_offset
  ), visible AS (SELECT * FROM page ORDER BY lower(name),id LIMIT 100)
  SELECT jsonb_build_object('members',COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'isActive',true) ORDER BY lower(a.name),a.id)
    FROM visible a
  ),'[]'::jsonb),'hasMore',(SELECT count(*)>100 FROM page)) INTO result;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_internal_external_people(uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_internal_external_people(uuid,text,text,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
