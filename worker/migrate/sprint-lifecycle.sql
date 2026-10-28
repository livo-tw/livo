-- Atomic sprint lifecycle; this file is refreshed on every schema upgrade.
CREATE TABLE IF NOT EXISTS sprint_command_contexts (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, auth_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 operation TEXT NOT NULL, sprint_id TEXT NOT NULL, command TEXT NOT NULL CHECK(json_valid(command)),
 created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS sprint_command_receipts (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, actor_id TEXT NOT NULL, sprint_id TEXT NOT NULL,
 command TEXT NOT NULL CHECK(json_valid(command)), result_json TEXT NOT NULL CHECK(json_valid(result_json)),
 created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS sprint_task_history (
 workspace_id TEXT NOT NULL, id TEXT PRIMARY KEY, sprint_id TEXT NOT NULL REFERENCES sprints(id),
 task_id TEXT NOT NULL, task_key TEXT NOT NULL, title TEXT NOT NULL, project_id TEXT NOT NULL,
 status_id TEXT NOT NULL, status_name TEXT NOT NULL, assignee_id TEXT, parent_task_id TEXT,
 outcome TEXT NOT NULL CHECK(outcome IN('completed','cancelled','pending','removed','unknown')),
 source TEXT NOT NULL CHECK(source IN('snapshot','observed','legacy')), recorded_at TEXT NOT NULL,
 UNIQUE(workspace_id,sprint_id,task_id)
);
CREATE INDEX IF NOT EXISTS sprint_history_scope ON sprint_task_history(workspace_id,sprint_id);

DROP TRIGGER IF EXISTS sprint_history_immutable_update;
CREATE TRIGGER sprint_history_immutable_update BEFORE UPDATE ON sprint_task_history
WHEN OLD.source='snapshot' OR NOT EXISTS(SELECT 1 FROM sprints s WHERE s.workspace_id=OLD.workspace_id AND s.id=OLD.sprint_id AND s.is_active=1)
BEGIN SELECT RAISE(ABORT,'sprint_forbidden'); END;
DROP TRIGGER IF EXISTS sprint_history_immutable_delete;
CREATE TRIGGER sprint_history_immutable_delete BEFORE DELETE ON sprint_task_history
BEGIN SELECT RAISE(ABORT,'sprint_forbidden'); END;

-- Existing associations are observable; their past closure outcome is unknown.
INSERT OR IGNORE INTO sprint_task_history(workspace_id,id,sprint_id,task_id,task_key,title,project_id,status_id,status_name,assignee_id,parent_task_id,outcome,source,recorded_at)
SELECT t.workspace_id,lower(hex(randomblob(16))),s.id,t.id,t.task_key,t.title,t.project_id,t.status_id,COALESCE(st.name,''),t.assignee_id,t.parent_task_id,'unknown','legacy',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM tasks t JOIN sprints s ON s.workspace_id=t.workspace_id AND s.id=t.sprint_id
LEFT JOIN statuses st ON st.workspace_id=t.workspace_id AND st.id=t.status_id;

DROP TRIGGER IF EXISTS sprint_single_active_insert;
CREATE TRIGGER sprint_single_active_insert BEFORE INSERT ON sprints WHEN NEW.is_active=1 BEGIN
 SELECT RAISE(ABORT,'sprint_conflict') WHERE EXISTS(SELECT 1 FROM sprints s WHERE s.workspace_id=NEW.workspace_id AND s.is_active=1);
END;
DROP TRIGGER IF EXISTS sprint_single_active_update;
CREATE TRIGGER sprint_single_active_update BEFORE UPDATE OF is_active,workspace_id ON sprints WHEN NEW.is_active=1 AND (OLD.is_active<>1 OR OLD.workspace_id<>NEW.workspace_id) BEGIN
 SELECT RAISE(ABORT,'sprint_conflict') WHERE EXISTS(SELECT 1 FROM sprints s WHERE s.workspace_id=NEW.workspace_id AND s.id<>NEW.id AND s.is_active=1);
END;

DROP TRIGGER IF EXISTS sprint_rename_guard;
CREATE TRIGGER sprint_rename_guard BEFORE UPDATE OF name ON sprints WHEN NEW.name IS NOT OLD.name BEGIN
 SELECT RAISE(ABORT,'sprint_invalid_input') WHERE length(trim(NEW.name)) NOT BETWEEN 1 AND 120 OR NEW.name<>trim(NEW.name);
 SELECT RAISE(ABORT,'sprint_conflict') WHERE EXISTS(SELECT 1 FROM sprints s WHERE s.workspace_id=NEW.workspace_id AND s.id<>NEW.id AND s.name=NEW.name);
END;
DROP TRIGGER IF EXISTS sprint_rename_version;
CREATE TRIGGER sprint_rename_version AFTER UPDATE OF name ON sprints WHEN NEW.name IS NOT OLD.name BEGIN
 UPDATE sprints SET version=OLD.version+1 WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
END;

DROP TRIGGER IF EXISTS sprint_assignment_insert;
CREATE TRIGGER sprint_assignment_insert BEFORE INSERT ON tasks WHEN NEW.sprint_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'sprint_conflict') WHERE NEW.parent_task_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tasks p WHERE p.workspace_id=NEW.workspace_id AND p.id=NEW.parent_task_id AND p.project_id=NEW.project_id AND p.sprint_id=NEW.sprint_id);
 SELECT RAISE(ABORT,'sprint_conflict') WHERE NOT EXISTS(SELECT 1 FROM sprints s WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.sprint_id AND s.is_active=1)
  AND NOT EXISTS(SELECT 1 FROM tasks p WHERE p.workspace_id=NEW.workspace_id AND p.id=NEW.parent_task_id AND p.project_id=NEW.project_id AND p.sprint_id=NEW.sprint_id);
END;
DROP TRIGGER IF EXISTS sprint_assignment_update;
CREATE TRIGGER sprint_assignment_update BEFORE UPDATE OF sprint_id,workspace_id ON tasks WHEN NEW.sprint_id IS NOT NULL AND (NEW.sprint_id IS NOT OLD.sprint_id OR NEW.workspace_id IS NOT OLD.workspace_id) BEGIN
 SELECT RAISE(ABORT,'sprint_conflict') WHERE NOT EXISTS(SELECT 1 FROM sprints s WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.sprint_id AND s.is_active=1);
END;
DROP TRIGGER IF EXISTS sprint_child_active_inheritance;
CREATE TRIGGER sprint_child_active_inheritance AFTER INSERT ON tasks WHEN NEW.parent_task_id IS NOT NULL BEGIN
 UPDATE tasks SET sprint_id=(SELECT p.sprint_id FROM tasks p JOIN sprints s ON s.workspace_id=p.workspace_id AND s.id=p.sprint_id AND s.is_active=1
  WHERE p.workspace_id=NEW.workspace_id AND p.id=NEW.parent_task_id AND p.project_id=NEW.project_id)
 WHERE workspace_id=NEW.workspace_id AND id=NEW.id AND sprint_id IS NOT (SELECT p.sprint_id FROM tasks p JOIN sprints s ON s.workspace_id=p.workspace_id AND s.id=p.sprint_id AND s.is_active=1
  WHERE p.workspace_id=NEW.workspace_id AND p.id=NEW.parent_task_id AND p.project_id=NEW.project_id);
END;
DROP TRIGGER IF EXISTS sprint_membership_insert;
CREATE TRIGGER sprint_membership_insert AFTER INSERT ON tasks BEGIN
 INSERT INTO sprint_task_history(workspace_id,id,sprint_id,task_id,task_key,title,project_id,status_id,status_name,assignee_id,parent_task_id,outcome,source,recorded_at)
 SELECT t.workspace_id,lower(hex(randomblob(16))),t.sprint_id,t.id,t.task_key,t.title,t.project_id,t.status_id,st.name,t.assignee_id,t.parent_task_id,'unknown','observed',strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM tasks t JOIN sprints s ON s.workspace_id=t.workspace_id AND s.id=t.sprint_id AND s.is_active=1 JOIN statuses st ON st.workspace_id=t.workspace_id AND st.id=t.status_id
 WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.id
 ON CONFLICT(workspace_id,sprint_id,task_id) DO UPDATE SET task_key=excluded.task_key,title=excluded.title,project_id=excluded.project_id,status_id=excluded.status_id,status_name=excluded.status_name,
 assignee_id=excluded.assignee_id,parent_task_id=excluded.parent_task_id,outcome='unknown',source='observed',recorded_at=excluded.recorded_at;
END;
DROP TRIGGER IF EXISTS sprint_membership_update;
CREATE TRIGGER sprint_membership_update AFTER UPDATE OF sprint_id ON tasks WHEN OLD.sprint_id IS NOT NEW.sprint_id BEGIN
 INSERT INTO sprint_task_history(workspace_id,id,sprint_id,task_id,task_key,title,project_id,status_id,status_name,assignee_id,parent_task_id,outcome,source,recorded_at)
 SELECT OLD.workspace_id,lower(hex(randomblob(16))),OLD.sprint_id,OLD.id,OLD.task_key,OLD.title,OLD.project_id,OLD.status_id,COALESCE(st.name,''),OLD.assignee_id,OLD.parent_task_id,'removed','observed',strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM sprints s LEFT JOIN statuses st ON st.workspace_id=OLD.workspace_id AND st.id=OLD.status_id WHERE s.workspace_id=OLD.workspace_id AND s.id=OLD.sprint_id AND s.is_active=1
 ON CONFLICT(workspace_id,sprint_id,task_id) DO UPDATE SET task_key=excluded.task_key,title=excluded.title,project_id=excluded.project_id,status_id=excluded.status_id,status_name=excluded.status_name,
 assignee_id=excluded.assignee_id,parent_task_id=excluded.parent_task_id,outcome='removed',source='observed',recorded_at=excluded.recorded_at;
 INSERT INTO sprint_task_history(workspace_id,id,sprint_id,task_id,task_key,title,project_id,status_id,status_name,assignee_id,parent_task_id,outcome,source,recorded_at)
 SELECT NEW.workspace_id,lower(hex(randomblob(16))),NEW.sprint_id,NEW.id,NEW.task_key,NEW.title,NEW.project_id,NEW.status_id,st.name,NEW.assignee_id,NEW.parent_task_id,'unknown','observed',strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM sprints s JOIN statuses st ON st.workspace_id=NEW.workspace_id AND st.id=NEW.status_id WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.sprint_id AND s.is_active=1
 ON CONFLICT(workspace_id,sprint_id,task_id) DO UPDATE SET task_key=excluded.task_key,title=excluded.title,project_id=excluded.project_id,status_id=excluded.status_id,status_name=excluded.status_name,
 assignee_id=excluded.assignee_id,parent_task_id=excluded.parent_task_id,outcome='unknown',source='observed',recorded_at=excluded.recorded_at;
END;
DROP TRIGGER IF EXISTS sprint_membership_delete;
CREATE TRIGGER sprint_membership_delete BEFORE DELETE ON tasks BEGIN
 INSERT INTO sprint_task_history(workspace_id,id,sprint_id,task_id,task_key,title,project_id,status_id,status_name,assignee_id,parent_task_id,outcome,source,recorded_at)
 SELECT OLD.workspace_id,lower(hex(randomblob(16))),OLD.sprint_id,OLD.id,OLD.task_key,OLD.title,OLD.project_id,OLD.status_id,COALESCE(st.name,''),OLD.assignee_id,OLD.parent_task_id,'removed','observed',strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM sprints s LEFT JOIN statuses st ON st.workspace_id=OLD.workspace_id AND st.id=OLD.status_id WHERE s.workspace_id=OLD.workspace_id AND s.id=OLD.sprint_id AND s.is_active=1
 ON CONFLICT(workspace_id,sprint_id,task_id) DO UPDATE SET outcome='removed',source='observed',recorded_at=excluded.recorded_at;
END;

DROP TRIGGER IF EXISTS sprint_command_validate;
CREATE TRIGGER sprint_command_validate BEFORE INSERT ON sprint_command_contexts BEGIN
 SELECT RAISE(ABORT,'sprint_invalid_input') WHERE NEW.operation NOT IN('start','complete') OR json_extract(NEW.command,'$.commandId') IS NOT NEW.id
  OR json_extract(NEW.command,'$.operation') IS NOT NEW.operation OR json_extract(NEW.command,'$.sprintId') IS NOT NEW.sprint_id;
 SELECT RAISE(ABORT,'sprint_forbidden') WHERE NOT EXISTS(SELECT 1 FROM members m JOIN auth_users u ON u.id=m.auth_id WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.actor_id
  AND m.auth_id=NEW.auth_id AND m.is_active=1 AND COALESCE(u.banned,0)=0 AND (SELECT count(*) FROM members WHERE workspace_id=m.workspace_id AND auth_id=m.auth_id AND is_active=1)=1);
 SELECT RAISE(ABORT,'sprint_command_reused') WHERE EXISTS(SELECT 1 FROM sprint_command_receipts WHERE workspace_id=NEW.workspace_id AND id=NEW.id);
 SELECT RAISE(ABORT,'sprint_conflict') WHERE NEW.operation='start' AND (EXISTS(SELECT 1 FROM sprints WHERE workspace_id=NEW.workspace_id AND is_active=1)
  OR EXISTS(SELECT 1 FROM sprints WHERE id=NEW.sprint_id) OR EXISTS(SELECT 1 FROM sprints WHERE workspace_id=NEW.workspace_id AND name=json_extract(NEW.command,'$.name')));
 SELECT RAISE(ABORT,'sprint_invalid_input') WHERE NEW.operation='start' AND (json_type(NEW.command,'$.taskIds')<>'array' OR json_array_length(NEW.command,'$.taskIds')>2000
  OR length(trim(json_extract(NEW.command,'$.name'))) NOT BETWEEN 1 AND 120 OR json_type(NEW.command,'$.includeBacklog') NOT IN('true','false'));
 SELECT RAISE(ABORT,'sprint_invalid_input') WHERE NEW.operation='start' AND EXISTS(SELECT 1 FROM json_each(NEW.command,'$.taskIds') j
  WHERE NOT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.workspace_id=t.workspace_id AND p.id=t.project_id JOIN statuses st ON st.workspace_id=t.workspace_id AND st.id=t.status_id
   WHERE t.workspace_id=NEW.workspace_id AND t.id=j.value AND t.sprint_id IS NULL AND p.is_archived=0 AND st.is_done=0 AND st.is_cancelled=0));
 SELECT RAISE(ABORT,'sprint_conflict') WHERE NEW.operation='start' AND json_extract(NEW.command,'$.includeBacklog')=1 AND EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.workspace_id=t.workspace_id AND p.id=t.project_id
  WHERE t.workspace_id=NEW.workspace_id AND t.sprint_id IS NULL AND p.is_archived=0 AND NOT EXISTS(SELECT 1 FROM statuses st WHERE st.workspace_id=t.workspace_id AND st.id=t.status_id));
 SELECT RAISE(ABORT,'sprint_not_found') WHERE NEW.operation='complete' AND NOT EXISTS(SELECT 1 FROM sprints WHERE workspace_id=NEW.workspace_id AND id=NEW.sprint_id);
 SELECT RAISE(ABORT,'sprint_conflict') WHERE NEW.operation='complete' AND NOT EXISTS(SELECT 1 FROM sprints WHERE workspace_id=NEW.workspace_id AND id=NEW.sprint_id AND is_active=1 AND version=json_extract(NEW.command,'$.expectedVersion'));
 SELECT RAISE(ABORT,'sprint_forbidden') WHERE NEW.operation='complete' AND EXISTS(SELECT 1 FROM tasks t WHERE t.sprint_id=NEW.sprint_id AND (t.workspace_id<>NEW.workspace_id
  OR NOT EXISTS(SELECT 1 FROM projects p WHERE p.workspace_id=t.workspace_id AND p.id=t.project_id) OR NOT EXISTS(SELECT 1 FROM statuses st WHERE st.workspace_id=t.workspace_id AND st.id=t.status_id)));
END;
DROP TRIGGER IF EXISTS sprint_command_apply;
CREATE TRIGGER sprint_command_apply AFTER INSERT ON sprint_command_contexts BEGIN
 INSERT INTO sprints(workspace_id,id,name,is_active,started_at,version,cancelled_count)
 SELECT NEW.workspace_id,NEW.sprint_id,json_extract(NEW.command,'$.name'),1,NEW.created_at,1,0 WHERE NEW.operation='start';
 UPDATE tasks SET sprint_id=NEW.sprint_id WHERE NEW.operation='start' AND workspace_id=NEW.workspace_id AND sprint_id IS NULL
  AND EXISTS(SELECT 1 FROM projects p WHERE p.workspace_id=tasks.workspace_id AND p.id=tasks.project_id AND p.is_archived=0)
  AND EXISTS(SELECT 1 FROM statuses st WHERE st.workspace_id=tasks.workspace_id AND st.id=tasks.status_id AND st.is_done=0 AND st.is_cancelled=0)
  AND (json_extract(NEW.command,'$.includeBacklog')=1 OR id IN(SELECT value FROM json_each(NEW.command,'$.taskIds')));
 UPDATE sprints SET pending_count=(SELECT count(*) FROM tasks t WHERE t.workspace_id=NEW.workspace_id AND t.sprint_id=NEW.sprint_id) WHERE NEW.operation='start' AND workspace_id=NEW.workspace_id AND id=NEW.sprint_id;
 INSERT INTO sprint_task_history(workspace_id,id,sprint_id,task_id,task_key,title,project_id,status_id,status_name,assignee_id,parent_task_id,outcome,source,recorded_at)
 SELECT t.workspace_id,lower(hex(randomblob(16))),NEW.sprint_id,t.id,t.task_key,t.title,t.project_id,t.status_id,st.name,t.assignee_id,t.parent_task_id,
  CASE WHEN st.is_cancelled=1 THEN 'cancelled' WHEN st.is_done=1 THEN 'completed' ELSE 'pending' END,'snapshot',NEW.created_at
 FROM tasks t JOIN statuses st ON st.workspace_id=t.workspace_id AND st.id=t.status_id WHERE NEW.operation='complete' AND t.workspace_id=NEW.workspace_id AND t.sprint_id=NEW.sprint_id
 ON CONFLICT(workspace_id,sprint_id,task_id) DO UPDATE SET task_key=excluded.task_key,title=excluded.title,project_id=excluded.project_id,status_id=excluded.status_id,status_name=excluded.status_name,
 assignee_id=excluded.assignee_id,parent_task_id=excluded.parent_task_id,outcome=excluded.outcome,source='snapshot',recorded_at=excluded.recorded_at;
 UPDATE sprints SET is_active=0,completed_at=NEW.created_at,history_captured_at=NEW.created_at,version=version+1,
 completed_count=(SELECT count(*) FROM sprint_task_history WHERE workspace_id=NEW.workspace_id AND sprint_id=NEW.sprint_id AND source='snapshot' AND outcome='completed'),
 cancelled_count=(SELECT count(*) FROM sprint_task_history WHERE workspace_id=NEW.workspace_id AND sprint_id=NEW.sprint_id AND source='snapshot' AND outcome='cancelled'),
 pending_count=(SELECT count(*) FROM sprint_task_history WHERE workspace_id=NEW.workspace_id AND sprint_id=NEW.sprint_id AND source='snapshot' AND outcome='pending')
 WHERE NEW.operation='complete' AND workspace_id=NEW.workspace_id AND id=NEW.sprint_id;
 UPDATE tasks SET sprint_id=NULL WHERE NEW.operation='complete' AND workspace_id=NEW.workspace_id AND sprint_id=NEW.sprint_id
  AND id IN(SELECT task_id FROM sprint_task_history WHERE workspace_id=NEW.workspace_id AND sprint_id=NEW.sprint_id AND source='snapshot' AND outcome='pending');
 INSERT INTO sprint_command_receipts(workspace_id,id,actor_id,sprint_id,command,result_json,created_at)
 SELECT NEW.workspace_id,NEW.id,NEW.actor_id,NEW.sprint_id,NEW.command,json_object('sprintId',s.id,'version',s.version,'completedCount',s.completed_count,'cancelledCount',COALESCE(s.cancelled_count,0),'pendingCount',s.pending_count,
 'pendingIds',json(CASE WHEN NEW.operation='complete' THEN (SELECT json_group_array(task_id) FROM (SELECT task_id FROM sprint_task_history WHERE workspace_id=NEW.workspace_id AND sprint_id=NEW.sprint_id AND source='snapshot' AND outcome='pending' ORDER BY task_id)) ELSE (SELECT json_group_array(id) FROM (SELECT id FROM tasks WHERE workspace_id=NEW.workspace_id AND sprint_id=NEW.sprint_id ORDER BY id)) END),
 'carryIds',json(CASE WHEN NEW.operation='complete' THEN (SELECT json_group_array(task_id) FROM (SELECT h.task_id FROM sprint_task_history h JOIN projects p ON p.workspace_id=h.workspace_id AND p.id=h.project_id WHERE h.workspace_id=NEW.workspace_id AND h.sprint_id=NEW.sprint_id AND h.source='snapshot' AND h.outcome='pending' AND p.is_archived=0 ORDER BY h.task_id)) ELSE (SELECT json_group_array(id) FROM (SELECT id FROM tasks WHERE workspace_id=NEW.workspace_id AND sprint_id=NEW.sprint_id ORDER BY id)) END),
 'taskIds',json(CASE WHEN NEW.operation='complete' THEN (SELECT json_group_array(task_id) FROM (SELECT task_id FROM sprint_task_history WHERE workspace_id=NEW.workspace_id AND sprint_id=NEW.sprint_id AND source='snapshot' ORDER BY task_id))
 ELSE (SELECT json_group_array(id) FROM (SELECT id FROM tasks WHERE workspace_id=NEW.workspace_id AND sprint_id=NEW.sprint_id ORDER BY id)) END)),NEW.created_at
 FROM sprints s WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.sprint_id;
 DELETE FROM sprint_command_contexts WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
END;

-- Destructive Jira/import replacement cannot discard immutable sprint evidence.
DROP TRIGGER IF EXISTS sprint_history_import_guard;
CREATE TRIGGER sprint_history_import_guard BEFORE INSERT ON task_planning_import_guard
WHEN EXISTS(SELECT 1 FROM sprint_task_history WHERE workspace_id=NEW.workspace_id)
 OR EXISTS(SELECT 1 FROM sprint_command_receipts WHERE workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'work_history_requires_restore'); END;
