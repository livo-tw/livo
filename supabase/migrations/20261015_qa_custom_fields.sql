-- QA field catalogs are managed through the QA API only. Existing field ids
-- and types survive configuration updates so stored answers remain readable.
CREATE OR REPLACE FUNCTION public.livo_qa_utf16_length(value text)
RETURNS integer LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=public AS $$
  SELECT length(value)+(SELECT count(*)::integer FROM regexp_split_to_table(value,'') char_part WHERE ascii(char_part)>65535);
$$;
REVOKE ALL ON FUNCTION public.livo_qa_utf16_length(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_utf16_length(text) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_field_configuration_valid(configured jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE item jsonb; option_value jsonb; seen text[]:=ARRAY[]::text[]; choices text[];
  trim_chars text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF jsonb_typeof(configured) IS DISTINCT FROM 'object'
    OR configured->'version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(configured->'fields') IS DISTINCT FROM 'array'
    OR (configured-ARRAY['version','fields'])<>'{}'::jsonb THEN RETURN false; END IF;
  IF jsonb_array_length(configured->'fields')>50 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(configured->'fields') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR (item-ARRAY['id','fieldName','fieldType','options','isRequired','isEnabled','sortOrder'])<>'{}'::jsonb
      OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string'
      OR COALESCE(item->>'id','') !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'
      OR item->>'id'=ANY(seen)
      OR jsonb_typeof(item->'fieldName') IS DISTINCT FROM 'string'
      OR COALESCE(public.livo_qa_utf16_length(item->>'fieldName'),0) NOT BETWEEN 1 AND 120
      OR btrim(item->>'fieldName',trim_chars)=''
      OR jsonb_typeof(item->'fieldType') IS DISTINCT FROM 'string'
      OR COALESCE(item->>'fieldType','') NOT IN ('text','textarea','number','select','date','boolean')
      OR jsonb_typeof(item->'isRequired') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(item->'isEnabled') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(item->'sortOrder') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    IF (item->>'sortOrder')::numeric NOT BETWEEN 0 AND 100000
      OR (item->>'sortOrder')::numeric<>trunc((item->>'sortOrder')::numeric) THEN RETURN false; END IF;
    seen:=array_append(seen,item->>'id');
    choices:=ARRAY[]::text[];
    IF item ? 'options' THEN
      IF jsonb_typeof(item->'options') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'options')>100 THEN RETURN false; END IF;
      FOR option_value IN SELECT value FROM jsonb_array_elements(item->'options') LOOP
        IF jsonb_typeof(option_value) IS DISTINCT FROM 'string'
          OR public.livo_qa_utf16_length(option_value#>>'{}') NOT BETWEEN 1 AND 120
          OR btrim(option_value#>>'{}',trim_chars)='' OR (option_value#>>'{}')=ANY(choices) THEN RETURN false; END IF;
        choices:=array_append(choices,option_value#>>'{}');
      END LOOP;
    END IF;
    IF (item->>'fieldType'='select' AND cardinality(choices)=0)
      OR (item->>'fieldType'<>'select' AND cardinality(choices)<>0) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_field_configuration_valid(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_field_configuration_valid(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_guard_qa_field_configuration()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF NOT COALESCE((TG_OP<>'DELETE' AND NEW.key='qa_custom_fields')
    OR (TG_OP<>'INSERT' AND OLD.key='qa_custom_fields'),false) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-catalog:qa_custom_fields'));
  IF current_user<>'service_role'
    AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
    RAISE EXCEPTION 'qa_fields_server_only' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND NEW.key IS DISTINCT FROM OLD.key) THEN
    RAISE EXCEPTION 'qa_field_identity_immutable' USING ERRCODE='22023'; END IF;
  IF NOT public.livo_qa_field_configuration_valid(NEW.value) THEN
    RAISE EXCEPTION 'qa_invalid_field_configuration' USING ERRCODE='22023'; END IF;
  IF TG_OP='UPDATE' AND OLD.key='qa_custom_fields' THEN
    IF NOT public.livo_qa_field_configuration_valid(OLD.value) THEN
      RAISE EXCEPTION 'qa_invalid_field_configuration' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.value->'fields') old_field WHERE NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(NEW.value->'fields') new_field
      WHERE new_field->>'id'=old_field->>'id' AND new_field->>'fieldType'=old_field->>'fieldType')) THEN
      RAISE EXCEPTION 'qa_field_identity_immutable' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_guard_qa_field_configuration() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS livo_guard_qa_field_configuration ON public.system_settings;
CREATE TRIGGER livo_guard_qa_field_configuration BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.livo_guard_qa_field_configuration();

CREATE OR REPLACE FUNCTION public.livo_qa_save_field_configuration(p_auth_id uuid,p_configuration jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-catalog:qa_custom_fields'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.members WHERE auth_id=p_auth_id AND is_active
    AND (role::text IN ('admin','super_admin') OR is_qa_admin)) THEN
    RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
  IF NOT public.livo_qa_field_configuration_valid(p_configuration) THEN
    RAISE EXCEPTION 'qa_invalid_field_configuration' USING ERRCODE='22023'; END IF;
  INSERT INTO public.system_settings(key,value,updated_at) VALUES('qa_custom_fields',p_configuration,now())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at;
  RETURN p_configuration;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_save_field_configuration(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_save_field_configuration(uuid,jsonb) TO service_role;

-- Preserve the v2 display contract; only extend its scoped management capability.
CREATE OR REPLACE FUNCTION public.livo_qa_save_workflow(p_auth_id uuid,p_workflow jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE states text[]:=ARRAY['new','triaged','in_progress','verification','verified','failed','closed','dismissed'];
  item jsonb; grouped text[]:=ARRAY[]::text[]; member_state text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.members WHERE auth_id=p_auth_id AND is_active=true AND (role::text IN ('admin','super_admin') OR is_qa_admin)) THEN
    RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_workflow) IS DISTINCT FROM 'object' OR p_workflow->'version' IS DISTINCT FROM '2'::jsonb
    OR jsonb_typeof(p_workflow->'order') IS DISTINCT FROM 'array' OR jsonb_typeof(p_workflow->'labels') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_workflow->'groups') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'qa_invalid_workflow' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_workflow))<>4 OR jsonb_array_length(p_workflow->'order')<>8
    OR (SELECT array_agg(s ORDER BY s) FROM jsonb_array_elements_text(p_workflow->'order') s)
      IS DISTINCT FROM ARRAY['closed','dismissed','failed','in_progress','new','triaged','verification','verified']::text[]
    OR (SELECT count(*) FROM jsonb_object_keys(p_workflow->'labels'))<>8
    OR EXISTS(SELECT 1 FROM jsonb_each(p_workflow->'labels') e WHERE NOT e.key=ANY(states)
      OR jsonb_typeof(e.value)<>'string' OR length(e.value#>>'{}')>40 OR (e.value#>>'{}')~'[[:cntrl:]]')
    OR EXISTS(SELECT 1 FROM jsonb_each_text(p_workflow->'labels') e WHERE btrim(e.value)<>''
      GROUP BY lower(btrim(e.value)) HAVING count(*)>1)
    OR jsonb_array_length(p_workflow->'groups')>8 THEN
    RAISE EXCEPTION 'qa_invalid_workflow' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_workflow->'groups') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'qa_invalid_workflow' USING ERRCODE='22023'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(item))<>3 OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'label') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'states') IS DISTINCT FROM 'array'
      OR length(btrim(item->>'label')) NOT BETWEEN 1 AND 40 OR (item->>'label')~'[[:cntrl:]]' THEN
      RAISE EXCEPTION 'qa_invalid_workflow' USING ERRCODE='22023'; END IF;
    IF jsonb_array_length(item->'states') NOT BETWEEN 2 AND 4 OR NOT (item->'states') ? (item->>'id') THEN
      RAISE EXCEPTION 'qa_invalid_workflow' USING ERRCODE='22023'; END IF;
    FOR member_state IN SELECT jsonb_array_elements_text(item->'states') LOOP
      IF member_state NOT IN ('new','triaged','in_progress','verification') OR member_state=ANY(grouped) THEN
        RAISE EXCEPTION 'qa_invalid_workflow' USING ERRCODE='22023'; END IF;
      grouped:=array_append(grouped,member_state);
    END LOOP;
  END LOOP;
  INSERT INTO public.system_settings(key,value,updated_at) VALUES('qa_workflow',p_workflow,now())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at;
  RETURN p_workflow;
END;
$$;

REVOKE ALL ON FUNCTION public.livo_qa_save_workflow(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_save_workflow(uuid,jsonb) TO service_role;

-- Called only for create/edit aggregates, under the existing feature lock.
CREATE OR REPLACE FUNCTION public.livo_qa_validate_custom_fields(p_values jsonb,p_previous jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE configured jsonb; item record; field jsonb; required_field jsonb; unchanged boolean;
  scalar_type text; text_value text; kind text; year_value integer; month_value integer; day_value integer; days integer;
  trim_chars text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  SELECT value INTO configured FROM public.system_settings WHERE key='qa_custom_fields';
  IF NOT FOUND THEN configured:='{"version":1,"fields":[]}'::jsonb; END IF;
  IF NOT public.livo_qa_field_configuration_valid(configured) THEN
    RAISE EXCEPTION 'qa_invalid_field_configuration' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR jsonb_typeof(p_previous) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'qa_invalid_custom_fields' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_values))>100
    OR (SELECT octet_length('{'||COALESCE(string_agg(to_jsonb(key)::text||':'||value::text,','),'')||'}') FROM jsonb_each(p_values))>100000
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_previous) old_key WHERE NOT p_values ? old_key) THEN
    RAISE EXCEPTION 'qa_invalid_custom_fields' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT key,value FROM jsonb_each(p_values) LOOP
    SELECT value INTO field FROM jsonb_array_elements(configured->'fields') WHERE value->>'id'=item.key;
    unchanged:=p_previous ? item.key AND p_previous->item.key=item.value;
    scalar_type:=jsonb_typeof(item.value); text_value:=item.value#>>'{}';
    IF scalar_type NOT IN ('null','string','number','boolean') THEN
      RAISE EXCEPTION 'qa_invalid_custom_field_value' USING ERRCODE='22023'; END IF;
    IF field IS NULL OR field->'isEnabled'<>'true'::jsonb THEN
      IF NOT unchanged THEN RAISE EXCEPTION 'qa_custom_field_unavailable' USING ERRCODE='22023'; END IF;
    ELSIF NOT unchanged AND scalar_type<>'null' THEN
      kind:=field->>'fieldType';
      IF kind IN ('text','textarea') THEN
        IF scalar_type<>'string' OR public.livo_qa_utf16_length(text_value)>(CASE WHEN kind='text' THEN 4000 ELSE 20000 END) THEN
          RAISE EXCEPTION 'qa_invalid_custom_field_value' USING ERRCODE='22023'; END IF;
      ELSIF kind='number' THEN
        IF scalar_type<>'number' THEN RAISE EXCEPTION 'qa_invalid_custom_field_value' USING ERRCODE='22023'; END IF;
        IF abs(text_value::numeric)>1.7976931348623157e308::numeric THEN
          RAISE EXCEPTION 'qa_invalid_custom_field_value' USING ERRCODE='22023'; END IF;
      ELSIF kind='boolean' THEN
        IF scalar_type<>'boolean' THEN RAISE EXCEPTION 'qa_invalid_custom_field_value' USING ERRCODE='22023'; END IF;
      ELSIF kind='select' THEN
        IF scalar_type<>'string' OR (text_value<>'' AND NOT (field->'options') ? text_value) THEN
          RAISE EXCEPTION 'qa_invalid_custom_field_value' USING ERRCODE='22023'; END IF;
      ELSIF kind='date' THEN
        IF scalar_type<>'string' THEN RAISE EXCEPTION 'qa_invalid_custom_field_value' USING ERRCODE='22023'; END IF;
        IF text_value<>'' THEN
          IF text_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
            RAISE EXCEPTION 'qa_invalid_custom_field_value' USING ERRCODE='22023'; END IF;
          year_value:=substring(text_value FROM 1 FOR 4)::integer;
          month_value:=substring(text_value FROM 6 FOR 2)::integer;
          day_value:=substring(text_value FROM 9 FOR 2)::integer;
          days:=CASE WHEN month_value=2 THEN CASE WHEN year_value%400=0 OR (year_value%4=0 AND year_value%100<>0) THEN 29 ELSE 28 END
            WHEN month_value IN (4,6,9,11) THEN 30 ELSE 31 END;
          IF month_value NOT BETWEEN 1 AND 12 OR day_value NOT BETWEEN 1 AND days THEN
            RAISE EXCEPTION 'qa_invalid_custom_field_value' USING ERRCODE='22023'; END IF;
        END IF;
      END IF;
    END IF;
  END LOOP;
  FOR required_field IN SELECT value FROM jsonb_array_elements(configured->'fields')
    WHERE value->'isEnabled'='true'::jsonb AND value->'isRequired'='true'::jsonb LOOP
    IF NOT p_values ? (required_field->>'id') OR p_values->(required_field->>'id')='null'::jsonb
      OR (jsonb_typeof(p_values->(required_field->>'id'))='string' AND btrim(p_values->>(required_field->>'id'),trim_chars)='') THEN
      RAISE EXCEPTION 'qa_custom_field_required' USING ERRCODE='22023'; END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_validate_custom_fields(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_validate_custom_fields(jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.livo_qa_commit(p_auth_id uuid,p_issue_id text,p_command_id text,
  p_payload_hash text,p_expected_version integer,p_kind text,p_data jsonb,p_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE actor text; actor_role text; existing public.qa_issues%ROWTYPE; receipt public.qa_commands%ROWTYPE; result jsonb; allowed boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-feature'));
  IF NOT public.livo_qa_enabled() THEN RAISE EXCEPTION 'qa_disabled' USING ERRCODE='42501'; END IF;
  SELECT id,role::text INTO actor,actor_role FROM public.members WHERE auth_id=p_auth_id AND is_active=true LIMIT 1;
  IF actor IS NULL THEN RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
  IF length(p_command_id) NOT BETWEEN 8 AND 200 OR length(p_payload_hash)<>64 THEN
    RAISE EXCEPTION 'invalid_command' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('livo-qa-command:'||p_command_id));
  SELECT * INTO receipt FROM public.qa_commands WHERE id=p_command_id AND workspace_id='default';
  IF FOUND THEN
    IF receipt.actor_id<>actor OR receipt.issue_id<>p_issue_id OR receipt.payload_hash<>p_payload_hash THEN
      RAISE EXCEPTION 'command_id_reused' USING ERRCODE='23505'; END IF;
    RETURN receipt.response;
  END IF;
  SELECT * INTO existing FROM public.qa_issues WHERE id=p_issue_id AND workspace_id='default' FOR UPDATE;
  IF p_kind IN ('create','command') THEN
    IF NOT EXISTS(SELECT 1 FROM public.projects WHERE id=p_data->>'projectId' AND NOT is_archived) THEN
      RAISE EXCEPTION 'invalid_issue: project unavailable' USING ERRCODE='22023'; END IF;
    IF p_event->>'type' IN ('triage','submit_fix') AND
      (NOT EXISTS(SELECT 1 FROM public.members WHERE id=p_data->>'assigneeId' AND is_active=true)
       OR NOT EXISTS(SELECT 1 FROM public.members WHERE id=p_data->>'qaOwnerId' AND is_active=true)) THEN
      RAISE EXCEPTION 'invalid_issue: member unavailable' USING ERRCODE='22023'; END IF;
    IF p_event->>'type'='link_tasks' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_data->'taskIds') t
      WHERE NOT EXISTS(SELECT 1 FROM public.tasks WHERE id=t AND project_id=p_data->>'projectId')) THEN
      RAISE EXCEPTION 'invalid_issue: task unavailable' USING ERRCODE='22023'; END IF;
    IF p_data->>'resolution'='duplicate' AND NOT EXISTS(SELECT 1 FROM public.qa_issues
      WHERE id=p_data->>'duplicateOfId' AND id<>p_issue_id AND workspace_id='default') THEN
      RAISE EXCEPTION 'invalid_issue: duplicate unavailable' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_kind='create' THEN
    IF FOUND THEN RAISE EXCEPTION 'issue_exists' USING ERRCODE='23505'; END IF;
    IF NOT COALESCE((p_data->>'observedEnvironment')=ANY(public.livo_deployment_environment_values()),false) THEN
      RAISE EXCEPTION 'qa_invalid_environment' USING ERRCODE='22023'; END IF;
    IF p_data->>'id' IS DISTINCT FROM p_issue_id OR p_data->>'workspaceId'<>'default'
      OR p_data->>'reporterId' IS DISTINCT FROM actor OR (p_data->>'version')::integer<>1 THEN
      RAISE EXCEPTION 'invalid_issue' USING ERRCODE='22023'; END IF;
    PERFORM public.livo_qa_validate_custom_fields(COALESCE(p_data->'customFields','{}'::jsonb),'{}'::jsonb);
    INSERT INTO public.qa_issues(id,project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data)
      VALUES(p_issue_id,p_data->>'projectId',p_data->>'state',p_data->>'assigneeId',p_data->>'qaOwnerId',actor,
        p_data->>'title',1,(p_data->>'updatedAt')::timestamptz,p_data);
    result:=p_data;
  ELSE
    IF NOT FOUND THEN RAISE EXCEPTION 'issue_not_found' USING ERRCODE='P0002'; END IF;
    IF p_kind='command' THEN
      IF existing.version<>p_expected_version THEN RAISE EXCEPTION 'version_conflict' USING ERRCODE='40001'; END IF;
      allowed:=actor_role IN ('admin','super_admin') OR CASE p_event->>'type'
        WHEN 'triage' THEN actor=existing.qa_owner_id
        WHEN 'record_verification' THEN actor=existing.qa_owner_id
        WHEN 'close' THEN actor=existing.qa_owner_id
        WHEN 'start_fix' THEN actor=existing.assignee_id
        WHEN 'submit_fix' THEN actor=existing.assignee_id
        WHEN 'record_deployment' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id
        WHEN 'link_tasks' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id
        WHEN 'set_state' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id
        WHEN 'edit' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id
        WHEN 'hold' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id
        WHEN 'reopen' THEN actor=existing.qa_owner_id OR actor=existing.assignee_id OR actor=existing.reporter_id
        ELSE false END;
      IF NOT COALESCE(allowed,false) THEN RAISE EXCEPTION 'member_inactive' USING ERRCODE='42501'; END IF;
      IF p_data->>'id' IS DISTINCT FROM p_issue_id OR p_data->>'workspaceId'<>'default'
        OR p_data->>'reporterId' IS DISTINCT FROM existing.reporter_id
        OR (p_data->>'version')::integer<>existing.version+1 THEN
        RAISE EXCEPTION 'invalid_issue' USING ERRCODE='22023'; END IF;
      -- The command receipt is checked first, so an already committed request
      -- remains replayable after a choice is retired. Unchanged legacy values
      -- and non-environment commands keep the issue's exact historical text.
      IF p_event->>'type'='edit'
        AND p_data->>'observedEnvironment' IS DISTINCT FROM existing.data->>'observedEnvironment'
        AND NOT COALESCE((p_data->>'observedEnvironment')=ANY(public.livo_deployment_environment_values()),false) THEN
        RAISE EXCEPTION 'qa_invalid_environment' USING ERRCODE='22023';
      END IF;
      IF p_event->>'type'='submit_fix' THEN
        IF jsonb_typeof(p_data->'targets') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'qa_invalid_environment' USING ERRCODE='22023'; END IF;
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'targets') target
          WHERE NOT COALESCE((target->>'environment')=ANY(public.livo_deployment_environment_values()),false)) THEN
          RAISE EXCEPTION 'qa_invalid_environment' USING ERRCODE='22023'; END IF;
      END IF;
      IF p_event->>'type'='edit' THEN
        PERFORM public.livo_qa_validate_custom_fields(COALESCE(p_data->'customFields','{}'::jsonb),
          COALESCE(existing.data->'customFields','{}'::jsonb));
      END IF;
      UPDATE public.qa_issues SET state=p_data->>'state',assignee_id=p_data->>'assigneeId',
        qa_owner_id=p_data->>'qaOwnerId',title=p_data->>'title',version=(p_data->>'version')::integer,
        updated_at=(p_data->>'updatedAt')::timestamptz,data=p_data WHERE id=p_issue_id AND workspace_id='default';
      result:=p_data;
    ELSIF p_kind='comment' THEN
      INSERT INTO public.qa_comments(id,issue_id,actor_id,body,created_at)
        VALUES(p_data->>'id',p_issue_id,actor,p_data->>'body',(p_data->>'createdAt')::timestamptz);
      result:=p_data;
    ELSE RAISE EXCEPTION 'invalid_command' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_kind<>'comment' THEN
    INSERT INTO public.qa_events(id,issue_id,actor_id,type,detail,version,created_at)
      VALUES(p_event->>'id',p_issue_id,actor,p_event->>'type',COALESCE(p_event->>'detail',''),
        (p_data->>'version')::integer,(p_data->>'updatedAt')::timestamptz);
  END IF;
  INSERT INTO public.qa_commands(id,issue_id,actor_id,payload_hash,response)
    VALUES(p_command_id,p_issue_id,actor,p_payload_hash,result);
  INSERT INTO public.notifications(recipient_id,sender_id,type,task_id,content)
    SELECT m.id,actor,'qa_update',null,jsonb_build_object('kind','qa','issueId',p_issue_id,
      'title',CASE WHEN p_kind='comment' THEN existing.title ELSE p_data->>'title' END,'event',p_event->>'type')::text
    FROM public.members m WHERE m.is_active=true AND m.id<>actor
      AND m.id IN (SELECT jsonb_array_elements_text(COALESCE(p_event->'recipients','[]'::jsonb)));
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
