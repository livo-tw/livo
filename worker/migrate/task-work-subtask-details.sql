-- Atomic child-owned form details; reapply without rewriting stored rows or receipts.
DROP TRIGGER IF EXISTS work_command_validate;
CREATE TRIGGER work_command_validate BEFORE INSERT ON task_work_contexts BEGIN
 SELECT RAISE(ABORT,'work_invalid_input') WHERE NEW.operation NOT IN('acknowledge','create_subtask','add_item','update_item','delete_item','add_dependency','remove_dependency')
  OR NEW.id IS NOT json_extract(NEW.payload,'$.commandId') OR NEW.operation IS NOT json_extract(NEW.payload,'$.operation') OR NEW.task_id IS NOT json_extract(NEW.payload,'$.taskId');
 SELECT RAISE(ABORT,'work_forbidden') WHERE NOT EXISTS(SELECT 1 FROM members m JOIN auth_users u ON u.id=m.auth_id WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.actor_id
  AND m.auth_id=NEW.auth_id AND m.is_active=1 AND COALESCE(u.banned,0)=0 AND (SELECT count(*) FROM members WHERE workspace_id=m.workspace_id AND auth_id=m.auth_id AND is_active=1)=1);
 SELECT RAISE(ABORT,'work_unavailable') WHERE NOT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND p.is_archived=0);
 SELECT RAISE(ABORT,'work_command_reused') WHERE EXISTS(SELECT 1 FROM task_work_receipts WHERE workspace_id=NEW.workspace_id AND id=NEW.id);
 SELECT RAISE(ABORT,'work_forbidden') WHERE NEW.operation='acknowledge' AND NOT EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.task_id
  AND CASE json_extract(NEW.payload,'$.role') WHEN 'assignee' THEN assignee_id WHEN 'reviewer' THEN reviewer_id END=NEW.actor_id);
 SELECT RAISE(ABORT,'work_conflict') WHERE NEW.operation='acknowledge' AND NOT EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.task_id
  AND CASE json_extract(NEW.payload,'$.role') WHEN 'assignee' THEN assignee_revision WHEN 'reviewer' THEN reviewer_revision END=json_extract(NEW.payload,'$.expectedRevision'));
 SELECT RAISE(ABORT,'work_invalid_parent') WHERE NEW.operation='create_subtask' AND EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.task_id AND parent_task_id IS NOT NULL);
 SELECT RAISE(ABORT,'work_invalid_input') WHERE NEW.operation='create_subtask' AND (NOT EXISTS(SELECT 1 FROM statuses WHERE workspace_id=NEW.workspace_id AND id=json_extract(NEW.payload,'$.statusId'))
  OR length(trim(json_extract(NEW.payload,'$.title'))) NOT BETWEEN 1 AND 500 OR json_extract(NEW.payload,'$.priority') NOT IN('highest','high','medium','low','lowest'));
 SELECT RAISE(ABORT,'work_member_unavailable') WHERE NEW.operation='create_subtask' AND EXISTS(SELECT 1 FROM json_each(NEW.payload) x WHERE x.key IN('assigneeId','reviewerId') AND x.value IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=x.value AND is_active=1));
 SELECT RAISE(ABORT,'work_invalid_input') WHERE NEW.operation='create_subtask' AND (
  (json_type(NEW.payload,'$.details') IS NOT NULL AND json_type(NEW.payload,'$.details')<>'object')
  OR EXISTS(SELECT 1 FROM json_each(NEW.payload,'$.details') e WHERE e.key NOT IN('background','requirement','notes','startDate','gitlabUrl','checks','todos','tagIds','deployments','customFields'))
  OR EXISTS(SELECT 1 FROM json_each(NEW.payload,'$.details') e WHERE e.key IN('background','requirement','notes') AND (e.type<>'text' OR length(e.value)>50000))
  OR EXISTS(SELECT 1 FROM json_each(NEW.payload,'$.details') e WHERE e.key IN('checks','todos','tagIds','deployments','customFields') AND (e.type<>'array' OR json_array_length(e.value)>100))
  OR (json_type(NEW.payload,'$.details.gitlabUrl') IS NOT NULL AND json_type(NEW.payload,'$.details.gitlabUrl') NOT IN('text','null'))
  OR length(COALESCE(json_extract(NEW.payload,'$.details.gitlabUrl'),''))>2000
  OR (json_type(NEW.payload,'$.details.startDate') IS NOT NULL AND json_type(NEW.payload,'$.details.startDate') NOT IN('text','null'))
  OR (json_extract(NEW.payload,'$.details.startDate') IS NOT NULL AND (length(json_extract(NEW.payload,'$.details.startDate'))<>10 OR substr(json_extract(NEW.payload,'$.details.startDate'),1,4)='0000' OR date(json_extract(NEW.payload,'$.details.startDate'),'+0 days') IS NOT json_extract(NEW.payload,'$.details.startDate'))));
 SELECT RAISE(ABORT,'work_invalid_input') WHERE NEW.operation='create_subtask' AND (
  EXISTS(SELECT 1 FROM json_each(NEW.payload,'$.details.checks') e WHERE e.type<>'text' OR length(trim(e.value)) NOT BETWEEN 1 AND 2000)
  OR EXISTS(SELECT 1 FROM json_each(NEW.payload,'$.details.todos') e WHERE e.type<>'text' OR length(trim(e.value)) NOT BETWEEN 1 AND 2000)
  OR EXISTS(SELECT 1 FROM json_each(NEW.payload,'$.details.tagIds') e WHERE e.type<>'text' OR length(e.value) NOT BETWEEN 1 AND 200 OR e.value GLOB '*[^a-zA-Z0-9_-]*' OR NOT EXISTS(SELECT 1 FROM tags WHERE workspace_id=NEW.workspace_id AND id=e.value))
  OR (SELECT count(*)<>count(DISTINCT value) FROM json_each(NEW.payload,'$.details.tagIds')));
 SELECT RAISE(ABORT,'work_invalid_input') WHERE NEW.operation='create_subtask' AND EXISTS(
  SELECT 1 FROM json_each(NEW.payload,'$.details.deployments') e WHERE e.type<>'object'
   OR EXISTS(SELECT 1 FROM json_each(e.value) k WHERE k.key NOT IN('environment','status','deployDate'))
   OR json_type(e.value,'$.environment') IS NOT 'text' OR length(json_extract(e.value,'$.environment')) NOT BETWEEN 1 AND 100
   OR json_type(e.value,'$.status') IS NOT 'text' OR json_extract(e.value,'$.status') NOT IN('scheduled','deployed')
   OR (json_type(e.value,'$.deployDate') IS NOT NULL AND json_type(e.value,'$.deployDate') NOT IN('text','null'))
   OR (json_extract(e.value,'$.deployDate') IS NOT NULL AND (length(json_extract(e.value,'$.deployDate'))<>10 OR substr(json_extract(e.value,'$.deployDate'),1,4)='0000' OR date(json_extract(e.value,'$.deployDate'),'+0 days') IS NOT json_extract(e.value,'$.deployDate')))
   OR NOT (CASE WHEN EXISTS(SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id AND key='deployment_environments')
    THEN EXISTS(SELECT 1 FROM livo_deployment_environment_settings_valid s JOIN json_each(s.value,'$.values') v WHERE s.workspace_id=NEW.workspace_id AND v.value=json_extract(e.value,'$.environment'))
    ELSE json_extract(e.value,'$.environment') IN('Dev','QA','Stage','Live Staging','Prod') END));
 SELECT RAISE(ABORT,'work_invalid_input') WHERE NEW.operation='create_subtask' AND (
  EXISTS(SELECT 1 FROM json_each(NEW.payload,'$.details.customFields') e WHERE e.type<>'object' OR json_type(e.value,'$.fieldId') IS NOT 'text'
   OR length(json_extract(e.value,'$.fieldId')) NOT BETWEEN 1 AND 200 OR json_extract(e.value,'$.fieldId') GLOB '*[^a-zA-Z0-9_-]*'
   OR EXISTS(SELECT 1 FROM json_each(e.value) k WHERE k.key NOT IN('fieldId','valueText','valueNumber','valueDate','valueBoolean','valueUserId'))
   OR NOT EXISTS(SELECT 1 FROM custom_fields f JOIN tasks t ON t.workspace_id=f.workspace_id AND t.project_id=f.project_id WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND f.id=json_extract(e.value,'$.fieldId')))
  OR (SELECT count(*)<>count(DISTINCT json_extract(value,'$.fieldId')) FROM json_each(NEW.payload,'$.details.customFields')));
 SELECT RAISE(ABORT,'work_invalid_input') WHERE NEW.operation='create_subtask' AND EXISTS(
  SELECT 1 FROM json_each(NEW.payload,'$.details.customFields') e JOIN custom_fields f ON f.workspace_id=NEW.workspace_id AND f.id=json_extract(e.value,'$.fieldId') WHERE
   EXISTS(SELECT 1 FROM json_each(e.value) k WHERE k.key<>'fieldId' AND k.type<>'null' AND k.key<>CASE f.field_type WHEN 'text' THEN 'valueText' WHEN 'textarea' THEN 'valueText' WHEN 'select' THEN 'valueText' WHEN 'number' THEN 'valueNumber' WHEN 'date' THEN 'valueDate' WHEN 'boolean' THEN 'valueBoolean' WHEN 'user' THEN 'valueUserId' END)
   OR (json_type(e.value,'$.valueText') IS NOT NULL AND json_type(e.value,'$.valueText') NOT IN('text','null')) OR length(COALESCE(json_extract(e.value,'$.valueText'),''))>10000
   OR (json_type(e.value,'$.valueNumber') IS NOT NULL AND json_type(e.value,'$.valueNumber') NOT IN('integer','real','null')) OR abs(json_extract(e.value,'$.valueNumber'))>1.7976931348623157e308
   OR (json_type(e.value,'$.valueBoolean') IS NOT NULL AND json_type(e.value,'$.valueBoolean') NOT IN('true','false','null'))
   OR (json_type(e.value,'$.valueDate') IS NOT NULL AND json_type(e.value,'$.valueDate') NOT IN('text','null'))
   OR (json_extract(e.value,'$.valueDate') IS NOT NULL AND (length(json_extract(e.value,'$.valueDate'))<>10 OR substr(json_extract(e.value,'$.valueDate'),1,4)='0000' OR date(json_extract(e.value,'$.valueDate'),'+0 days') IS NOT json_extract(e.value,'$.valueDate')))
   OR (json_type(e.value,'$.valueUserId') IS NOT NULL AND json_type(e.value,'$.valueUserId') NOT IN('text','null'))
   OR (json_extract(e.value,'$.valueUserId') IS NOT NULL AND (length(json_extract(e.value,'$.valueUserId')) NOT BETWEEN 1 AND 200 OR json_extract(e.value,'$.valueUserId') GLOB '*[^a-zA-Z0-9_-]*'))
   OR (f.field_type='select' AND length(trim(COALESCE(json_extract(e.value,'$.valueText'),''),char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))>0 AND NOT(CASE WHEN json_valid(f.options) THEN CASE WHEN json_type(f.options)='array' THEN EXISTS(SELECT 1 FROM json_each(f.options) v WHERE v.type='text' AND v.value=json_extract(e.value,'$.valueText')) ELSE 0 END ELSE 0 END)));
 SELECT RAISE(ABORT,'work_member_unavailable') WHERE NEW.operation='create_subtask' AND EXISTS(
  SELECT 1 FROM json_each(NEW.payload,'$.details.customFields') e WHERE json_extract(e.value,'$.valueUserId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=json_extract(e.value,'$.valueUserId') AND is_active=1));
 SELECT RAISE(ABORT,'work_required_fields') WHERE NEW.operation='create_subtask' AND EXISTS(SELECT 1 FROM system_settings s WHERE s.workspace_id=NEW.workspace_id AND s.key='required_fields' AND NOT(CASE WHEN json_valid(s.value) THEN json_type(s.value)='object' ELSE 0 END));
 SELECT RAISE(ABORT,'work_required_fields') WHERE NEW.operation='create_subtask' AND (
  EXISTS(SELECT 1 FROM system_settings s JOIN json_each(s.value) x WHERE s.workspace_id=NEW.workspace_id AND s.key='required_fields' AND x.value=1 AND (
   x.key NOT IN('title','project','status','priority','dueDate','assignee','reviewer','background','requirement','notes','startDate','gitlabUrl','tags','checks','todos','deployments')
   OR (x.key='dueDate' AND json_extract(NEW.payload,'$.dueDate') IS NULL) OR (x.key='assignee' AND json_extract(NEW.payload,'$.assigneeId') IS NULL) OR (x.key='reviewer' AND json_extract(NEW.payload,'$.reviewerId') IS NULL)
   OR (x.key='startDate' AND json_extract(NEW.payload,'$.details.startDate') IS NULL) OR (x.key='gitlabUrl' AND length(trim(COALESCE(json_extract(NEW.payload,'$.details.gitlabUrl'),''),char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))=0)
   OR (x.key IN('checks','todos','deployments') AND COALESCE(json_array_length(NEW.payload,'$.details.'||x.key),0)=0) OR (x.key='tags' AND COALESCE(json_array_length(NEW.payload,'$.details.tagIds'),0)=0)))
  OR EXISTS(SELECT 1 FROM custom_fields f JOIN tasks t ON t.workspace_id=f.workspace_id AND t.project_id=f.project_id WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND f.is_required=1 AND NOT EXISTS(
   SELECT 1 FROM json_each(NEW.payload,'$.details.customFields') e WHERE json_extract(e.value,'$.fieldId')=f.id AND CASE f.field_type WHEN 'number' THEN COALESCE(json_type(e.value,'$.valueNumber') IN('integer','real'),0) WHEN 'boolean' THEN COALESCE(json_type(e.value,'$.valueBoolean') IN('true','false'),0) WHEN 'date' THEN length(trim(COALESCE(json_extract(e.value,'$.valueDate'),''),char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))>0 WHEN 'user' THEN length(trim(COALESCE(json_extract(e.value,'$.valueUserId'),''),char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))>0 ELSE length(trim(COALESCE(json_extract(e.value,'$.valueText'),''),char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))>0 END)));
 -- Strip only complete tags, with the same media/nbsp/trim contract as richTextContent.ts.
 SELECT RAISE(ABORT,'work_required_fields') WHERE NEW.operation='create_subtask' AND EXISTS(
  WITH RECURSIVE inputs(key,raw) AS (
   SELECT x.key,COALESCE(json_extract(NEW.payload,'$.details.'||x.key),'') FROM system_settings s JOIN json_each(s.value) x WHERE s.workspace_id=NEW.workspace_id AND s.key='required_fields' AND x.value=1 AND x.key IN('background','requirement','notes')
  ), cleaned(key,raw,value) AS (
   SELECT key,raw,raw FROM inputs UNION ALL
   SELECT key,raw,substr(value,1,instr(value,'<')-1)||substr(value,instr(value,'<')+instr(substr(value,instr(value,'<')),'>')) FROM cleaned
    WHERE instr(value,'<')>0 AND instr(substr(value,instr(value,'<')),'>')>0
  ) SELECT 1 FROM cleaned WHERE (instr(value,'<')=0 OR instr(substr(value,instr(value,'<')),'>')=0)
   AND length(trim(replace(replace(value,'&nbsp;',' '),char(160),' '),char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)))=0
   AND NOT(lower(raw) GLOB '*<img[^a-z0-9_]*' OR lower(raw) GLOB '*<img' OR lower(raw) GLOB '*<video[^a-z0-9_]*' OR lower(raw) GLOB '*<video' OR lower(raw) GLOB '*<iframe[^a-z0-9_]*' OR lower(raw) GLOB '*<iframe' OR lower(raw) GLOB '*<hr[^a-z0-9_]*' OR lower(raw) GLOB '*<hr'));
 SELECT RAISE(ABORT,'work_conflict') WHERE NEW.operation IN('update_item','delete_item') AND NOT EXISTS(
  SELECT 1 FROM (SELECT workspace_id,id,task_id,version,'checks' list FROM task_checks UNION ALL SELECT workspace_id,id,task_id,version,'todos' list FROM task_todos) i
  WHERE i.workspace_id=NEW.workspace_id AND i.task_id=NEW.task_id AND i.id=json_extract(NEW.payload,'$.itemId') AND i.list=json_extract(NEW.payload,'$.list') AND i.version=json_extract(NEW.payload,'$.expectedVersion'));
 SELECT RAISE(ABORT,'work_unavailable') WHERE NEW.operation='add_dependency' AND NOT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id
  WHERE t.workspace_id=NEW.workspace_id AND t.id=json_extract(NEW.payload,'$.dependsOnTaskId') AND p.is_archived=0);
 SELECT RAISE(ABORT,'work_conflict') WHERE NEW.operation='add_dependency' AND EXISTS(SELECT 1 FROM task_dependencies WHERE workspace_id=NEW.workspace_id AND task_id=NEW.task_id AND depends_on_task_id=json_extract(NEW.payload,'$.dependsOnTaskId'));
 SELECT RAISE(ABORT,'work_conflict') WHERE NEW.operation='remove_dependency' AND NOT EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks t ON t.workspace_id=d.workspace_id AND t.id=d.depends_on_task_id
  JOIN projects p ON p.workspace_id=t.workspace_id AND p.id=t.project_id WHERE d.workspace_id=NEW.workspace_id AND d.task_id=NEW.task_id AND d.id=json_extract(NEW.payload,'$.dependencyId') AND p.is_archived=0);
END;
DROP TRIGGER IF EXISTS work_command_apply;
CREATE TRIGGER work_command_apply AFTER INSERT ON task_work_contexts BEGIN
 INSERT INTO task_work_events(workspace_id,id,command_id,actor_id,task_id,operation,before_value,created_at)
  VALUES(NEW.workspace_id,NEW.event_id,NEW.id,NEW.actor_id,NEW.task_id,NEW.operation,NULL,NEW.created_at);
 UPDATE tasks SET assignee_acknowledged_at=CASE WHEN json_extract(NEW.payload,'$.role')='assignee' THEN COALESCE(assignee_acknowledged_at,NEW.created_at) ELSE assignee_acknowledged_at END,
  reviewer_acknowledged_at=CASE WHEN json_extract(NEW.payload,'$.role')='reviewer' THEN COALESCE(reviewer_acknowledged_at,NEW.created_at) ELSE reviewer_acknowledged_at END
  WHERE NEW.operation='acknowledge' AND workspace_id=NEW.workspace_id AND id=NEW.task_id;
 INSERT INTO tasks(workspace_id,id,task_key,project_id,parent_task_id,title,status_id,priority,creator_id,assignee_id,reviewer_id,due_date,sprint_id,started_at,completed_at,gitlab_url)
  SELECT NEW.workspace_id,NEW.record_id,p.key||'-'||(SELECT COALESCE(max(CAST(substr(x.task_key,length(p.key)+2) AS INTEGER)),0)+1 FROM tasks x WHERE x.workspace_id=NEW.workspace_id AND substr(x.task_key,1,length(p.key)+1)=p.key||'-'),
   p.id,t.id,json_extract(NEW.payload,'$.title'),s.id,json_extract(NEW.payload,'$.priority'),NEW.actor_id,json_extract(NEW.payload,'$.assigneeId'),json_extract(NEW.payload,'$.reviewerId'),json_extract(NEW.payload,'$.dueDate'),t.sprint_id,
   COALESCE(json_extract(NEW.payload,'$.details.startDate'),CASE WHEN s.auto_start=1 THEN NEW.created_at END),CASE WHEN s.auto_done=1 THEN NEW.created_at END,NULLIF(trim(json_extract(NEW.payload,'$.details.gitlabUrl')),'')
  FROM tasks t JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id JOIN statuses s ON s.workspace_id=NEW.workspace_id AND s.id=json_extract(NEW.payload,'$.statusId')
  WHERE NEW.operation='create_subtask' AND t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id;
 INSERT INTO task_specs(workspace_id,id,task_id,background,requirement,notes) SELECT NEW.workspace_id,NEW.record_id,NEW.record_id,COALESCE(json_extract(NEW.payload,'$.details.background'),''),COALESCE(json_extract(NEW.payload,'$.details.requirement'),''),COALESCE(json_extract(NEW.payload,'$.details.notes'),'') WHERE NEW.operation='create_subtask';
 INSERT INTO task_checks(workspace_id,id,task_id,text,is_done,sort_order) SELECT NEW.workspace_id,NEW.record_id||'-check-'||v.key,NEW.record_id,trim(v.value),0,CAST(v.key AS INTEGER)+1 FROM json_each(NEW.payload,'$.details.checks') v WHERE NEW.operation='create_subtask';
 INSERT INTO task_todos(workspace_id,id,task_id,text,is_done,sort_order) SELECT NEW.workspace_id,NEW.record_id||'-todo-'||v.key,NEW.record_id,trim(v.value),0,CAST(v.key AS INTEGER)+1 FROM json_each(NEW.payload,'$.details.todos') v WHERE NEW.operation='create_subtask';
 INSERT INTO task_tags(workspace_id,id,task_id,tag_id) SELECT NEW.workspace_id,NEW.record_id||'-tag-'||v.key,NEW.record_id,v.value FROM json_each(NEW.payload,'$.details.tagIds') v WHERE NEW.operation='create_subtask';
 INSERT INTO task_deployments(workspace_id,id,task_id,environment,status,deploy_date) SELECT NEW.workspace_id,NEW.record_id||'-deployment-'||v.key,NEW.record_id,json_extract(v.value,'$.environment'),json_extract(v.value,'$.status'),json_extract(v.value,'$.deployDate') FROM json_each(NEW.payload,'$.details.deployments') v WHERE NEW.operation='create_subtask';
 INSERT INTO task_custom_field_values(workspace_id,id,task_id,field_id,value_text,value_number,value_date,value_boolean,value_user_id) SELECT NEW.workspace_id,NEW.record_id||'-custom-'||v.key,NEW.record_id,json_extract(v.value,'$.fieldId'),json_extract(v.value,'$.valueText'),json_extract(v.value,'$.valueNumber'),json_extract(v.value,'$.valueDate'),json_extract(v.value,'$.valueBoolean'),json_extract(v.value,'$.valueUserId') FROM json_each(NEW.payload,'$.details.customFields') v WHERE NEW.operation='create_subtask';

 INSERT INTO status_logs(workspace_id,id,task_id,from_status_id,to_status_id,changed_by,changed_at) SELECT NEW.workspace_id,NEW.event_id,NEW.record_id,NULL,json_extract(NEW.payload,'$.statusId'),NEW.actor_id,NEW.created_at WHERE NEW.operation='create_subtask';
 INSERT INTO task_checks(workspace_id,id,task_id,text,is_done,sort_order) SELECT NEW.workspace_id,NEW.record_id,NEW.task_id,json_extract(NEW.payload,'$.text'),json_extract(NEW.payload,'$.isDone'),
  (SELECT COALESCE(max(sort_order),-1)+1 FROM task_checks WHERE workspace_id=NEW.workspace_id AND task_id=NEW.task_id) WHERE NEW.operation='add_item' AND json_extract(NEW.payload,'$.list')='checks';
 UPDATE task_checks SET text=CASE WHEN json_type(NEW.payload,'$.text') IS NOT NULL THEN json_extract(NEW.payload,'$.text') ELSE text END,
  is_done=CASE WHEN json_type(NEW.payload,'$.isDone') IS NOT NULL THEN json_extract(NEW.payload,'$.isDone') ELSE is_done END
  WHERE NEW.operation='update_item' AND json_extract(NEW.payload,'$.list')='checks' AND workspace_id=NEW.workspace_id AND task_id=NEW.task_id AND id=json_extract(NEW.payload,'$.itemId');
 DELETE FROM task_checks WHERE NEW.operation='delete_item' AND json_extract(NEW.payload,'$.list')='checks' AND workspace_id=NEW.workspace_id AND task_id=NEW.task_id AND id=json_extract(NEW.payload,'$.itemId');
 INSERT INTO task_todos(workspace_id,id,task_id,text,is_done,sort_order) SELECT NEW.workspace_id,NEW.record_id,NEW.task_id,json_extract(NEW.payload,'$.text'),json_extract(NEW.payload,'$.isDone'),
  (SELECT COALESCE(max(sort_order),-1)+1 FROM task_todos WHERE workspace_id=NEW.workspace_id AND task_id=NEW.task_id) WHERE NEW.operation='add_item' AND json_extract(NEW.payload,'$.list')='todos';
 UPDATE task_todos SET text=CASE WHEN json_type(NEW.payload,'$.text') IS NOT NULL THEN json_extract(NEW.payload,'$.text') ELSE text END,
  is_done=CASE WHEN json_type(NEW.payload,'$.isDone') IS NOT NULL THEN json_extract(NEW.payload,'$.isDone') ELSE is_done END
  WHERE NEW.operation='update_item' AND json_extract(NEW.payload,'$.list')='todos' AND workspace_id=NEW.workspace_id AND task_id=NEW.task_id AND id=json_extract(NEW.payload,'$.itemId');
 DELETE FROM task_todos WHERE NEW.operation='delete_item' AND json_extract(NEW.payload,'$.list')='todos' AND workspace_id=NEW.workspace_id AND task_id=NEW.task_id AND id=json_extract(NEW.payload,'$.itemId');
 INSERT INTO task_dependencies(workspace_id,id,task_id,depends_on_task_id) SELECT NEW.workspace_id,NEW.record_id,NEW.task_id,json_extract(NEW.payload,'$.dependsOnTaskId') WHERE NEW.operation='add_dependency';
 DELETE FROM task_dependencies WHERE NEW.operation='remove_dependency' AND workspace_id=NEW.workspace_id AND task_id=NEW.task_id AND id=json_extract(NEW.payload,'$.dependencyId');
 INSERT INTO task_work_receipts(workspace_id,id,actor_id,task_id,payload_hash,command,result_json,created_at)
 SELECT NEW.workspace_id,NEW.id,NEW.actor_id,NEW.task_id,NEW.payload_hash,NEW.payload,json_object(
  'commandId',NEW.id,'replayed',json('false'),'eventId',NEW.event_id,'task',json_object(
   'id',t.id,'task_key',t.task_key,'project_id',t.project_id,'parent_task_id',t.parent_task_id,'title',t.title,'status_id',t.status_id,'priority',t.priority,
   'assignee_id',t.assignee_id,'reviewer_id',t.reviewer_id,'assignee_revision',t.assignee_revision,'reviewer_revision',t.reviewer_revision,
   'assignee_acknowledged_at',t.assignee_acknowledged_at,'reviewer_acknowledged_at',t.reviewer_acknowledged_at),
  'record',CASE WHEN NEW.operation='create_subtask' THEN (SELECT json_object('id',id,'task_key',task_key,'project_id',project_id,'parent_task_id',parent_task_id,'title',title,'status_id',status_id,'priority',priority,'assignee_id',assignee_id,'reviewer_id',reviewer_id,'due_date',due_date) FROM tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.record_id)
   WHEN NEW.operation='add_dependency' THEN (SELECT json_object('id',id,'task_id',task_id,'depends_on_task_id',depends_on_task_id,'dependency_type',dependency_type) FROM task_dependencies WHERE workspace_id=NEW.workspace_id AND id=NEW.record_id)
   WHEN NEW.operation IN('add_item','update_item') THEN (SELECT json_object('id',id,'task_id',task_id,'text',text,'is_done',json(CASE WHEN is_done=1 THEN 'true' ELSE 'false' END),'sort_order',sort_order,'version',version)
    FROM (SELECT workspace_id,id,task_id,text,is_done,sort_order,version,'checks' list FROM task_checks UNION ALL SELECT workspace_id,id,task_id,text,is_done,sort_order,version,'todos' list FROM task_todos)
    WHERE workspace_id=NEW.workspace_id AND task_id=NEW.task_id AND list=json_extract(NEW.payload,'$.list') AND id=CASE WHEN NEW.operation='add_item' THEN NEW.record_id ELSE json_extract(NEW.payload,'$.itemId') END)
   ELSE NULL END,
  'removedId',CASE WHEN NEW.operation='delete_item' THEN json_extract(NEW.payload,'$.itemId') WHEN NEW.operation='remove_dependency' THEN json_extract(NEW.payload,'$.dependencyId') END),NEW.created_at
 FROM tasks t WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id;
 UPDATE task_work_events SET after_value=(SELECT result_json FROM task_work_receipts WHERE workspace_id=NEW.workspace_id AND id=NEW.id)
  WHERE workspace_id=NEW.workspace_id AND id=NEW.event_id;
 INSERT INTO activity_logs(workspace_id,id,user_id,action,task_id,task_key,detail,created_at)
  SELECT NEW.workspace_id,NEW.event_id,NEW.actor_id,'task_work',NEW.task_id,task_key,NEW.operation,NEW.created_at FROM tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.task_id;
 DELETE FROM task_work_contexts WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
END;
