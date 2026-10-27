-- Atomic own-content subtask creation. Released migrations remain immutable.
-- Patch the current RPC body rather than reverting later auth/Slack/PT409 fixes.
CREATE OR REPLACE FUNCTION public.livo_task_work_details_present(v text, rich boolean DEFAULT false)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=public AS $$
 SELECT CASE WHEN rich AND COALESCE(v,'') ~* '<(img|video|iframe|hr)([^a-z0-9_]|$)' THEN true ELSE
 length(btrim(CASE WHEN rich THEN regexp_replace(replace(COALESCE(v,''),'&nbsp;',' '),'<[^>]*>','','g') ELSE COALESCE(v,'') END,
 U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0 END
$$;
CREATE OR REPLACE FUNCTION public.livo_task_work_details_date_valid(v text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=public AS $$
BEGIN
 IF v IS NULL THEN RETURN true; END IF;
 IF v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR left(v,4)='0000' THEN RETURN false; END IF;
 BEGIN RETURN to_char(v::date,'YYYY-MM-DD')=v; EXCEPTION WHEN OTHERS THEN RETURN false; END;
END; $$;
CREATE OR REPLACE FUNCTION public.livo_task_work_subtask_details_validate(p_project text,p_command jsonb,p_required jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE d jsonb:=COALESCE(p_command->'details','{}'::jsonb); entry jsonb; field public.custom_fields%ROWTYPE;
 k text; wanted text; label text; required jsonb:=COALESCE(p_required,'{}'::jsonb); seen text[]:=ARRAY[]::text[];
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'work_forbidden' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(d) x WHERE x NOT IN('background','requirement','notes','startDate','gitlabUrl','checks','todos','tagIds','deployments','customFields')) THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT unnest(ARRAY['background','requirement','notes']) LOOP
  IF d ? k AND (jsonb_typeof(d->k) IS DISTINCT FROM 'string' OR length(d->>k)>50000) THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
 END LOOP;
 FOR k IN SELECT unnest(ARRAY['startDate','gitlabUrl']) LOOP
  IF d ? k AND jsonb_typeof(d->k) NOT IN('string','null') THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF length(COALESCE(d->>'gitlabUrl',''))>2000 OR NOT public.livo_task_work_details_date_valid(d->>'startDate') THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT unnest(ARRAY['checks','todos','tagIds','deployments','customFields']) LOOP
  IF d ? k AND (jsonb_typeof(d->k) IS DISTINCT FROM 'array' OR jsonb_array_length(d->k)>100) THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
 END LOOP;
 FOR k IN SELECT unnest(ARRAY['checks','todos','tagIds']) LOOP
  FOR entry IN SELECT value FROM jsonb_array_elements(COALESCE(d->k,'[]'::jsonb)) LOOP
   IF jsonb_typeof(entry) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
   label:=entry#>>'{}';
   IF k='tagIds' THEN
    IF label !~ '^[a-zA-Z0-9_-]{1,200}$' THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
   ELSIF NOT public.livo_task_work_details_present(label) OR length(label)>2000 THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
  END LOOP;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(COALESCE(d->'tagIds','[]'::jsonb)))<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(COALESCE(d->'tagIds','[]'::jsonb))) THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.tags WHERE id IN(SELECT jsonb_array_elements_text(COALESCE(d->'tagIds','[]'::jsonb))) ORDER BY id FOR SHARE;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(d->'tagIds','[]'::jsonb)) v WHERE NOT EXISTS(SELECT 1 FROM public.tags WHERE id=v)) THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
 -- Retain the existing exact environment list; creating a record does not deploy software.
 PERFORM 1 FROM public.system_settings WHERE key='deployment_environments' FOR SHARE;
 FOR entry IN SELECT value FROM jsonb_array_elements(COALESCE(d->'deployments','[]'::jsonb)) LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(entry) x WHERE x NOT IN('environment','status','deployDate'))
   OR jsonb_typeof(entry->'environment') IS DISTINCT FROM 'string' OR length(entry->>'environment') NOT BETWEEN 1 AND 100
   OR jsonb_typeof(entry->'status') IS DISTINCT FROM 'string' OR entry->>'status' NOT IN('scheduled','deployed')
   OR (entry ? 'deployDate' AND jsonb_typeof(entry->'deployDate') NOT IN('string','null')) OR NOT public.livo_task_work_details_date_valid(entry->>'deployDate')
   OR NOT ((entry->>'environment')=ANY(public.livo_deployment_environment_values())) THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
 END LOOP;
 -- Lock all current definitions while validating values so metadata cannot change mid-command.
 PERFORM 1 FROM public.custom_fields WHERE project_id=p_project ORDER BY id FOR SHARE;
 FOR entry IN SELECT value FROM jsonb_array_elements(COALESCE(d->'customFields','[]'::jsonb)) LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR jsonb_typeof(entry->'fieldId') IS DISTINCT FROM 'string' OR (entry->>'fieldId') !~ '^[a-zA-Z0-9_-]{1,200}$'
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(entry) x WHERE x NOT IN('fieldId','valueText','valueNumber','valueDate','valueBoolean','valueUserId'))
   OR (entry->>'fieldId')=ANY(seen) THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
  seen:=array_append(seen,entry->>'fieldId'); SELECT * INTO field FROM public.custom_fields WHERE id=entry->>'fieldId' AND project_id=p_project FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
  wanted:=CASE field.field_type WHEN 'text' THEN 'valueText' WHEN 'textarea' THEN 'valueText' WHEN 'select' THEN 'valueText' WHEN 'number' THEN 'valueNumber' WHEN 'date' THEN 'valueDate' WHEN 'boolean' THEN 'valueBoolean' WHEN 'user' THEN 'valueUserId' END;
  IF wanted IS NULL OR EXISTS(SELECT 1 FROM jsonb_each(entry) x WHERE x.key<>'fieldId' AND x.key<>wanted AND x.value<>'null'::jsonb) THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
  IF entry ? wanted AND entry->wanted<>'null'::jsonb THEN
   IF (wanted IN('valueText','valueDate','valueUserId') AND jsonb_typeof(entry->wanted)<>'string')
    OR (wanted='valueNumber' AND jsonb_typeof(entry->wanted)<>'number') OR (wanted='valueBoolean' AND jsonb_typeof(entry->wanted)<>'boolean') THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
   IF wanted='valueText' AND length(entry->>wanted)>10000 THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
   IF wanted='valueNumber' AND abs((entry->>wanted)::numeric)>1.7976931348623157e308::numeric THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
   IF wanted='valueDate' AND NOT public.livo_task_work_details_date_valid(entry->>wanted) THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
   IF field.field_type='select' AND public.livo_task_work_details_present(entry->>wanted) AND
    (jsonb_typeof(field.options) IS DISTINCT FROM 'array' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(field.options)='array' THEN field.options ELSE '[]'::jsonb END) v WHERE jsonb_typeof(v)='string' AND v#>>'{}'=entry->>wanted)) THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
   IF wanted='valueUserId' THEN
    IF (entry->>wanted) !~ '^[a-zA-Z0-9_-]{1,200}$' THEN RAISE EXCEPTION 'work_invalid_input' USING ERRCODE='22023'; END IF;
    PERFORM 1 FROM public.members WHERE id=entry->>wanted AND is_active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'work_member_unavailable' USING ERRCODE='23514'; END IF;
   END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.custom_fields f WHERE f.project_id=p_project AND f.is_required AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(COALESCE(d->'customFields','[]'::jsonb)) v WHERE v->>'fieldId'=f.id AND
   CASE f.field_type WHEN 'number' THEN jsonb_typeof(v->'valueNumber')='number' WHEN 'boolean' THEN jsonb_typeof(v->'valueBoolean')='boolean'
    WHEN 'date' THEN public.livo_task_work_details_present(v->>'valueDate') WHEN 'user' THEN public.livo_task_work_details_present(v->>'valueUserId') ELSE public.livo_task_work_details_present(v->>'valueText') END
 )) THEN RAISE EXCEPTION 'work_required_fields' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(required) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'work_required_fields' USING ERRCODE='23514'; END IF;
 FOR k IN SELECT key FROM jsonb_each(required) WHERE value='true'::jsonb LOOP
  IF k IN('title','project','status','priority') THEN CONTINUE;
  ELSIF k='dueDate' THEN IF NOT public.livo_task_work_details_present(p_command->>'dueDate') THEN RAISE EXCEPTION 'work_required_fields' USING ERRCODE='23514'; END IF;
  ELSIF k IN('assignee','reviewer') THEN IF p_command->>(k||'Id') IS NULL THEN RAISE EXCEPTION 'work_required_fields' USING ERRCODE='23514'; END IF;
  ELSIF k IN('background','requirement','notes') THEN IF NOT public.livo_task_work_details_present(d->>k,true) THEN RAISE EXCEPTION 'work_required_fields' USING ERRCODE='23514'; END IF;
  ELSIF k IN('startDate','gitlabUrl') THEN IF NOT public.livo_task_work_details_present(d->>k) THEN RAISE EXCEPTION 'work_required_fields' USING ERRCODE='23514'; END IF;
  ELSIF k IN('tags','checks','todos','deployments') THEN IF COALESCE(jsonb_array_length(d->CASE WHEN k='tags' THEN 'tagIds' ELSE k END),0)=0 THEN RAISE EXCEPTION 'work_required_fields' USING ERRCODE='23514'; END IF;
  ELSE RAISE EXCEPTION 'work_required_fields' USING ERRCODE='23514'; END IF;
 END LOOP;
END; $$;
CREATE OR REPLACE FUNCTION public.livo_task_work_subtask_details_apply(p_task text,p_details jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE d jsonb:=COALESCE(p_details,'{}'::jsonb); entry jsonb;
BEGIN
 IF current_user<>'service_role' THEN RAISE EXCEPTION 'work_forbidden' USING ERRCODE='42501'; END IF;
 INSERT INTO public.task_checks(id,task_id,text,is_done,sort_order) SELECT 'tc_'||gen_random_uuid()::text,p_task,btrim(value),false,ordinality FROM jsonb_array_elements_text(COALESCE(d->'checks','[]'::jsonb)) WITH ORDINALITY;
 INSERT INTO public.task_todos(id,task_id,text,is_done,sort_order) SELECT 'td_'||gen_random_uuid()::text,p_task,btrim(value),false,ordinality FROM jsonb_array_elements_text(COALESCE(d->'todos','[]'::jsonb)) WITH ORDINALITY;
 INSERT INTO public.task_tags(id,task_id,tag_id) SELECT 'tt_'||gen_random_uuid()::text,p_task,value FROM jsonb_array_elements_text(COALESCE(d->'tagIds','[]'::jsonb));
 FOR entry IN SELECT value FROM jsonb_array_elements(COALESCE(d->'deployments','[]'::jsonb)) LOOP
  INSERT INTO public.task_deployments(id,task_id,environment,status,deploy_date) VALUES(gen_random_uuid(),p_task,entry->>'environment',(entry->>'status')::public.deploy_status,entry->>'deployDate');
 END LOOP;
 FOR entry IN SELECT value FROM jsonb_array_elements(COALESCE(d->'customFields','[]'::jsonb)) LOOP
  INSERT INTO public.task_custom_field_values(id,task_id,field_id,value_text,value_number,value_date,value_boolean,value_user_id)
   VALUES('cfv_'||gen_random_uuid()::text,p_task,entry->>'fieldId',entry->>'valueText',(entry->>'valueNumber')::numeric,(entry->>'valueDate')::date,(entry->>'valueBoolean')::boolean,entry->>'valueUserId');
 END LOOP;
END; $$;
REVOKE ALL ON FUNCTION public.livo_task_work_details_present(text,boolean),public.livo_task_work_details_date_valid(text),public.livo_task_work_subtask_details_validate(text,jsonb,jsonb),public.livo_task_work_subtask_details_apply(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_task_work_details_present(text,boolean),public.livo_task_work_details_date_valid(text),public.livo_task_work_subtask_details_validate(text,jsonb,jsonb),public.livo_task_work_subtask_details_apply(text,jsonb) TO service_role;
DO $migration$
DECLARE definition text; old text; replacement text;
BEGIN
 definition:=pg_get_functiondef('public.livo_task_work_command(uuid,jsonb,text,jsonb)'::regprocedure);
 IF position('livo_task_work_subtask_details_validate' in definition)>0 THEN RETURN; END IF;
 old:=$old$    IF (COALESCE((required->>'dueDate')::boolean,false) AND NULLIF(p_command->>'dueDate','') IS NULL)
      OR (COALESCE((required->>'assignee')::boolean,false) AND p_command->>'assigneeId' IS NULL)
      OR (COALESCE((required->>'reviewer')::boolean,false) AND p_command->>'reviewerId' IS NULL)
      OR EXISTS(SELECT 1 FROM jsonb_each(COALESCE(required,'{}'::jsonb)) x WHERE x.value='true'::jsonb
        AND x.key NOT IN('title','project','status','priority','dueDate','assignee','reviewer'))
      OR EXISTS(SELECT 1 FROM public.custom_fields WHERE project_id=project.id AND is_required) THEN RAISE EXCEPTION 'work_required_fields' USING ERRCODE='23514'; END IF;$old$;
 old:=replace(old,E'\r\n',E'\n');
 IF position(E'\r\n' in definition)>0 THEN old:=replace(old,E'\n',E'\r\n'); END IF;
 IF position(old in definition)=0 THEN RAISE EXCEPTION 'task_work_subtask_details_unrecognized_required_guard'; END IF;
 definition:=replace(definition,old,'    PERFORM public.livo_task_work_subtask_details_validate(project.id,p_command,required);');
 -- A missing required_fields row cannot be row-locked. Freeze settings before its first read
 -- so later environment reads cannot mix an old default with a new configuration.
 old:=$anchor$SELECT s.value INTO required FROM public.system_settings s WHERE s.key='required_fields';$anchor$;
 IF position(old in definition)=0 THEN RAISE EXCEPTION 'task_work_subtask_details_unrecognized_required_read'; END IF;
 definition:=replace(definition,old,$change$LOCK TABLE public.system_settings IN SHARE MODE;
    SELECT s.value INTO required FROM public.system_settings s WHERE s.key='required_fields' FOR SHARE;$change$);
 old:=$old$    INSERT INTO public.task_specs(id,task_id,background,requirement,notes) VALUES('spec_'||gen_random_uuid()::text,target.id,'','','');$old$;
 IF position(old in definition)=0 THEN RAISE EXCEPTION 'task_work_subtask_details_unrecognized_spec_insert'; END IF;
 replacement:=$new$    INSERT INTO public.task_specs(id,task_id,background,requirement,notes) VALUES('spec_'||gen_random_uuid()::text,target.id,COALESCE(p_command#>>'{details,background}',''),COALESCE(p_command#>>'{details,requirement}',''),COALESCE(p_command#>>'{details,notes}',''));
    PERFORM public.livo_task_work_subtask_details_apply(target.id,p_command->'details');$new$;
 definition:=replace(definition,old,replacement);
 old:='due_date,sprint_id,sort_order,started_at,completed_at)';
 IF position(old in definition)=0 THEN RAISE EXCEPTION 'task_work_subtask_details_unrecognized_task_insert'; END IF;
 definition:=replace(definition,old,'due_date,sprint_id,sort_order,started_at,completed_at,gitlab_url)');
 old:=$old$(SELECT CASE WHEN s.auto_start THEN stamp::text ELSE NULL END FROM public.statuses s WHERE s.id=p_command->>'statusId'),$old$;
 definition:=replace(definition,old,$new$COALESCE(p_command#>>'{details,startDate}',(SELECT CASE WHEN s.auto_start THEN stamp::text ELSE NULL END FROM public.statuses s WHERE s.id=p_command->>'statusId')),$new$);
 old:=$old$(SELECT CASE WHEN s.auto_done THEN stamp::text ELSE NULL END FROM public.statuses s WHERE s.id=p_command->>'statusId')) RETURNING * INTO target;$old$;
 IF position(old in definition)=0 THEN RAISE EXCEPTION 'task_work_subtask_details_unrecognized_auto_dates'; END IF;
 definition:=replace(definition,old,$new$(SELECT CASE WHEN s.auto_done THEN stamp::text ELSE NULL END FROM public.statuses s WHERE s.id=p_command->>'statusId'),NULLIF(btrim(p_command#>>'{details,gitlabUrl}'),'')) RETURNING * INTO target;$new$);
 EXECUTE definition;
END; $migration$;
REVOKE ALL ON FUNCTION public.livo_task_work_command(uuid,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.livo_task_work_command(uuid,jsonb,text,jsonb) TO service_role;
