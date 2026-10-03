-- One context INSERT validates, mutates, audits, receipts and deletes itself.
-- Contexts are not persistent authorization; generic query access is disabled.
CREATE TABLE IF NOT EXISTS task_work_contexts (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, auth_id TEXT NOT NULL, actor_id TEXT NOT NULL, task_id TEXT NOT NULL,
 operation TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), payload_hash TEXT NOT NULL,
 event_id TEXT NOT NULL, record_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS task_work_receipts (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, actor_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 payload_hash TEXT NOT NULL, command TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS task_work_events (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, command_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, operation TEXT NOT NULL,
 before_value TEXT, after_value TEXT, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,command_id)
);
CREATE TABLE IF NOT EXISTS task_work_internal_versions (
 workspace_id TEXT NOT NULL, table_name TEXT NOT NULL, row_id TEXT NOT NULL, expected TEXT NOT NULL CHECK(json_valid(expected)),
 PRIMARY KEY(workspace_id,table_name,row_id)
);
CREATE TRIGGER IF NOT EXISTS work_task_insert_guard BEFORE INSERT ON tasks BEGIN
 SELECT RAISE(ABORT,'work_forbidden') WHERE NEW.assignee_revision<>0 OR NEW.reviewer_revision<>0
  OR NEW.assignee_acknowledged_at IS NOT NULL OR NEW.reviewer_acknowledged_at IS NOT NULL;
 SELECT RAISE(ABORT,'work_conflict') WHERE EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND task_key=NEW.task_key AND id<>NEW.id);
 SELECT RAISE(ABORT,'work_invalid_parent') WHERE NEW.parent_task_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM tasks p WHERE p.workspace_id=NEW.workspace_id AND p.id=NEW.parent_task_id AND p.id<>NEW.id AND p.project_id=NEW.project_id AND p.parent_task_id IS NULL);
END;
CREATE TRIGGER IF NOT EXISTS work_task_update_guard BEFORE UPDATE ON tasks BEGIN
 SELECT RAISE(ABORT,'work_forbidden') WHERE (
  NEW.assignee_revision<>OLD.assignee_revision OR NEW.reviewer_revision<>OLD.reviewer_revision
  OR NEW.assignee_acknowledged_at IS NOT OLD.assignee_acknowledged_at OR NEW.reviewer_acknowledged_at IS NOT OLD.reviewer_acknowledged_at)
  AND NOT EXISTS(SELECT 1 FROM task_work_internal_versions v WHERE v.workspace_id=OLD.workspace_id AND v.table_name='tasks' AND v.row_id=OLD.id
    AND NEW.assignee_revision=json_extract(v.expected,'$.assignee_revision') AND NEW.reviewer_revision=json_extract(v.expected,'$.reviewer_revision')
    AND NEW.assignee_acknowledged_at IS json_extract(v.expected,'$.assignee_acknowledged_at') AND NEW.reviewer_acknowledged_at IS json_extract(v.expected,'$.reviewer_acknowledged_at'))
  AND NOT EXISTS(SELECT 1 FROM task_work_contexts c WHERE c.workspace_id=OLD.workspace_id AND c.task_id=OLD.id AND c.operation='acknowledge'
    AND NEW.assignee_revision=OLD.assignee_revision AND NEW.reviewer_revision=OLD.reviewer_revision
    AND ((json_extract(c.payload,'$.role')='assignee' AND c.actor_id=OLD.assignee_id AND NEW.reviewer_acknowledged_at IS OLD.reviewer_acknowledged_at)
      OR (json_extract(c.payload,'$.role')='reviewer' AND c.actor_id=OLD.reviewer_id AND NEW.assignee_acknowledged_at IS OLD.assignee_acknowledged_at)));
 SELECT RAISE(ABORT,'work_invalid_parent') WHERE (NEW.parent_task_id IS NOT OLD.parent_task_id OR NEW.project_id<>OLD.project_id) AND (
  (NEW.parent_task_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM tasks p WHERE p.workspace_id=NEW.workspace_id AND p.id=NEW.parent_task_id
    AND p.id<>NEW.id AND p.project_id=NEW.project_id AND p.parent_task_id IS NULL) OR EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND parent_task_id=NEW.id)))
  OR EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND parent_task_id=NEW.id AND project_id<>NEW.project_id));
 SELECT RAISE(ABORT,'work_conflict') WHERE (NEW.task_key<>OLD.task_key OR NEW.project_id<>OLD.project_id) AND EXISTS(
  SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND task_key=NEW.task_key AND id<>NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS work_task_assignment_revision AFTER UPDATE ON tasks
WHEN NEW.assignee_id IS NOT OLD.assignee_id OR NEW.reviewer_id IS NOT OLD.reviewer_id BEGIN
 INSERT INTO task_work_internal_versions(workspace_id,table_name,row_id,expected) VALUES(NEW.workspace_id,'tasks',NEW.id,json_object(
  'assignee_revision',OLD.assignee_revision+CASE WHEN NEW.assignee_id IS NOT OLD.assignee_id THEN 1 ELSE 0 END,
  'reviewer_revision',OLD.reviewer_revision+CASE WHEN NEW.reviewer_id IS NOT OLD.reviewer_id THEN 1 ELSE 0 END,
  'assignee_acknowledged_at',CASE WHEN NEW.assignee_id IS NOT OLD.assignee_id THEN NULL ELSE NEW.assignee_acknowledged_at END,
  'reviewer_acknowledged_at',CASE WHEN NEW.reviewer_id IS NOT OLD.reviewer_id THEN NULL ELSE NEW.reviewer_acknowledged_at END));
 UPDATE tasks SET
  assignee_revision=OLD.assignee_revision+CASE WHEN NEW.assignee_id IS NOT OLD.assignee_id THEN 1 ELSE 0 END,
  reviewer_revision=OLD.reviewer_revision+CASE WHEN NEW.reviewer_id IS NOT OLD.reviewer_id THEN 1 ELSE 0 END,
  assignee_acknowledged_at=CASE WHEN NEW.assignee_id IS NOT OLD.assignee_id THEN NULL ELSE NEW.assignee_acknowledged_at END,
  reviewer_acknowledged_at=CASE WHEN NEW.reviewer_id IS NOT OLD.reviewer_id THEN NULL ELSE NEW.reviewer_acknowledged_at END
 WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
 DELETE FROM task_work_internal_versions WHERE workspace_id=NEW.workspace_id AND table_name='tasks' AND row_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS work_task_checks_insert BEFORE INSERT ON task_checks BEGIN
 SELECT RAISE(ABORT,'work_conflict') WHERE NEW.version<>0;
 SELECT RAISE(ABORT,'work_unavailable') WHERE NOT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.workspace_id=t.workspace_id AND p.id=t.project_id WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND p.is_archived=0);
END;
CREATE TRIGGER IF NOT EXISTS work_task_checks_update BEFORE UPDATE ON task_checks BEGIN
 SELECT RAISE(ABORT,'work_conflict') WHERE NEW.workspace_id<>OLD.workspace_id OR NEW.id<>OLD.id OR NEW.task_id<>OLD.task_id OR (NEW.version<>OLD.version
  AND NOT EXISTS(SELECT 1 FROM task_work_internal_versions WHERE workspace_id=OLD.workspace_id AND table_name='task_checks' AND row_id=OLD.id AND json_extract(expected,'$.version')=NEW.version));
 SELECT RAISE(ABORT,'work_unavailable') WHERE NOT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.workspace_id=t.workspace_id AND p.id=t.project_id WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND p.is_archived=0);
END;
CREATE TRIGGER IF NOT EXISTS work_task_checks_version AFTER UPDATE ON task_checks WHEN NEW.version=OLD.version BEGIN
 INSERT INTO task_work_internal_versions(workspace_id,table_name,row_id,expected) VALUES(NEW.workspace_id,'task_checks',NEW.id,json_object('version',OLD.version+1));
 UPDATE task_checks SET version=OLD.version+1 WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
 DELETE FROM task_work_internal_versions WHERE workspace_id=NEW.workspace_id AND table_name='task_checks' AND row_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS work_task_todos_insert BEFORE INSERT ON task_todos BEGIN
 SELECT RAISE(ABORT,'work_conflict') WHERE NEW.version<>0;
 SELECT RAISE(ABORT,'work_unavailable') WHERE NOT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.workspace_id=t.workspace_id AND p.id=t.project_id WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND p.is_archived=0);
END;
CREATE TRIGGER IF NOT EXISTS work_task_todos_update BEFORE UPDATE ON task_todos BEGIN
 SELECT RAISE(ABORT,'work_conflict') WHERE NEW.workspace_id<>OLD.workspace_id OR NEW.id<>OLD.id OR NEW.task_id<>OLD.task_id OR (NEW.version<>OLD.version
  AND NOT EXISTS(SELECT 1 FROM task_work_internal_versions WHERE workspace_id=OLD.workspace_id AND table_name='task_todos' AND row_id=OLD.id AND json_extract(expected,'$.version')=NEW.version));
 SELECT RAISE(ABORT,'work_unavailable') WHERE NOT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.workspace_id=t.workspace_id AND p.id=t.project_id WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND p.is_archived=0);
END;
CREATE TRIGGER IF NOT EXISTS work_task_todos_version AFTER UPDATE ON task_todos WHEN NEW.version=OLD.version BEGIN
 INSERT INTO task_work_internal_versions(workspace_id,table_name,row_id,expected) VALUES(NEW.workspace_id,'task_todos',NEW.id,json_object('version',OLD.version+1));
 UPDATE task_todos SET version=OLD.version+1 WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
 DELETE FROM task_work_internal_versions WHERE workspace_id=NEW.workspace_id AND table_name='task_todos' AND row_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS work_dependency_guard BEFORE INSERT ON task_dependencies BEGIN
 SELECT RAISE(ABORT,'work_unavailable') WHERE NOT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND p.is_archived=0)
  OR NOT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.depends_on_task_id AND p.is_archived=0);
 SELECT RAISE(ABORT,'work_cycle') WHERE NEW.task_id=NEW.depends_on_task_id OR EXISTS(WITH RECURSIVE reachable(id) AS (
  SELECT NEW.depends_on_task_id UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN reachable r ON d.task_id=r.id WHERE d.workspace_id=NEW.workspace_id)
  SELECT 1 FROM reachable WHERE id=NEW.task_id);
END;
CREATE TRIGGER IF NOT EXISTS work_command_validate BEFORE INSERT ON task_work_contexts BEGIN
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
 SELECT RAISE(ABORT,'work_required_fields') WHERE NEW.operation='create_subtask' AND (
  EXISTS(SELECT 1 FROM system_settings s JOIN json_each(s.value) x WHERE s.workspace_id=NEW.workspace_id AND s.key='required_fields' AND x.value=1 AND (
    x.key NOT IN('dueDate','assignee','reviewer') OR (x.key='dueDate' AND json_extract(NEW.payload,'$.dueDate') IS NULL)
    OR (x.key='assignee' AND json_extract(NEW.payload,'$.assigneeId') IS NULL) OR (x.key='reviewer' AND json_extract(NEW.payload,'$.reviewerId') IS NULL)))
  OR EXISTS(SELECT 1 FROM custom_fields f JOIN tasks t ON t.project_id=f.project_id AND t.workspace_id=f.workspace_id WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND f.is_required=1));
 SELECT RAISE(ABORT,'work_conflict') WHERE NEW.operation IN('update_item','delete_item') AND NOT EXISTS(
  SELECT 1 FROM (SELECT workspace_id,id,task_id,version,'checks' list FROM task_checks UNION ALL SELECT workspace_id,id,task_id,version,'todos' list FROM task_todos) i
  WHERE i.workspace_id=NEW.workspace_id AND i.task_id=NEW.task_id AND i.id=json_extract(NEW.payload,'$.itemId') AND i.list=json_extract(NEW.payload,'$.list') AND i.version=json_extract(NEW.payload,'$.expectedVersion'));
 SELECT RAISE(ABORT,'work_unavailable') WHERE NEW.operation='add_dependency' AND NOT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id
  WHERE t.workspace_id=NEW.workspace_id AND t.id=json_extract(NEW.payload,'$.dependsOnTaskId') AND p.is_archived=0);
 SELECT RAISE(ABORT,'work_conflict') WHERE NEW.operation='add_dependency' AND EXISTS(SELECT 1 FROM task_dependencies WHERE workspace_id=NEW.workspace_id AND task_id=NEW.task_id AND depends_on_task_id=json_extract(NEW.payload,'$.dependsOnTaskId'));
 SELECT RAISE(ABORT,'work_conflict') WHERE NEW.operation='remove_dependency' AND NOT EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks t ON t.workspace_id=d.workspace_id AND t.id=d.depends_on_task_id
  JOIN projects p ON p.workspace_id=t.workspace_id AND p.id=t.project_id WHERE d.workspace_id=NEW.workspace_id AND d.task_id=NEW.task_id AND d.id=json_extract(NEW.payload,'$.dependencyId') AND p.is_archived=0);
END;
CREATE TRIGGER IF NOT EXISTS work_command_apply AFTER INSERT ON task_work_contexts BEGIN
 INSERT INTO task_work_events(workspace_id,id,command_id,actor_id,task_id,operation,before_value,created_at)
  VALUES(NEW.workspace_id,NEW.event_id,NEW.id,NEW.actor_id,NEW.task_id,NEW.operation,NULL,NEW.created_at);
 UPDATE tasks SET assignee_acknowledged_at=CASE WHEN json_extract(NEW.payload,'$.role')='assignee' THEN COALESCE(assignee_acknowledged_at,NEW.created_at) ELSE assignee_acknowledged_at END,
  reviewer_acknowledged_at=CASE WHEN json_extract(NEW.payload,'$.role')='reviewer' THEN COALESCE(reviewer_acknowledged_at,NEW.created_at) ELSE reviewer_acknowledged_at END
  WHERE NEW.operation='acknowledge' AND workspace_id=NEW.workspace_id AND id=NEW.task_id;
 INSERT INTO tasks(workspace_id,id,task_key,project_id,parent_task_id,title,status_id,priority,creator_id,assignee_id,reviewer_id,due_date,sprint_id,started_at,completed_at)
  SELECT NEW.workspace_id,NEW.record_id,p.key||'-'||(SELECT COALESCE(max(CAST(substr(x.task_key,length(p.key)+2) AS INTEGER)),0)+1 FROM tasks x WHERE x.workspace_id=NEW.workspace_id AND x.project_id=p.id),
   p.id,t.id,json_extract(NEW.payload,'$.title'),s.id,json_extract(NEW.payload,'$.priority'),NEW.actor_id,json_extract(NEW.payload,'$.assigneeId'),json_extract(NEW.payload,'$.reviewerId'),json_extract(NEW.payload,'$.dueDate'),t.sprint_id,
   CASE WHEN s.auto_start=1 THEN NEW.created_at END,CASE WHEN s.auto_done=1 THEN NEW.created_at END
  FROM tasks t JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id JOIN statuses s ON s.workspace_id=NEW.workspace_id AND s.id=json_extract(NEW.payload,'$.statusId')
  WHERE NEW.operation='create_subtask' AND t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id;
 INSERT INTO task_specs(workspace_id,id,task_id,background,requirement,notes) SELECT NEW.workspace_id,NEW.record_id,NEW.record_id,'','','' WHERE NEW.operation='create_subtask';
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
CREATE TRIGGER IF NOT EXISTS work_import_guard BEFORE INSERT ON task_planning_import_guard
WHEN EXISTS(SELECT 1 FROM task_work_events WHERE workspace_id=NEW.workspace_id)
 OR EXISTS(SELECT 1 FROM task_work_receipts WHERE workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'work_history_requires_restore'); END;
