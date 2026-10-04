-- Release history is independent from task/QA state. Internal command rows are not client-accessible.
CREATE TABLE IF NOT EXISTS release_batches (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), revision INTEGER NOT NULL CHECK(revision>0), data TEXT NOT NULL CHECK(json_valid(data)), updated_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS release_commands (
 workspace_id TEXT NOT NULL,id TEXT NOT NULL,batch_id TEXT NOT NULL,actor_id TEXT NOT NULL,auth_id TEXT NOT NULL,
 expected_version INTEGER NOT NULL,operation TEXT NOT NULL,request_hash TEXT NOT NULL,command TEXT NOT NULL,
 data TEXT NOT NULL,event_id TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS release_events (
 workspace_id TEXT NOT NULL,id TEXT NOT NULL,batch_id TEXT NOT NULL,actor_id TEXT NOT NULL,operation TEXT NOT NULL,
 version INTEGER NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES release_batches(workspace_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS release_batch_projects (
 workspace_id TEXT NOT NULL,batch_id TEXT NOT NULL,project_id TEXT NOT NULL,PRIMARY KEY(workspace_id,batch_id,project_id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES release_batches(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS release_batch_tasks (
 workspace_id TEXT NOT NULL,batch_id TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(workspace_id,batch_id,task_id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES release_batches(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS release_outbox (
 workspace_id TEXT NOT NULL,id TEXT NOT NULL,batch_id TEXT NOT NULL,event_id TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending',next_attempt_at TEXT,created_at TEXT NOT NULL,lease_owner TEXT,lease_until TEXT,last_error TEXT,message_ts TEXT,PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,event_id)
);
CREATE TABLE IF NOT EXISTS release_slack_links (
 workspace_id TEXT NOT NULL,id TEXT NOT NULL,batch_id TEXT NOT NULL,team_id TEXT NOT NULL,channel_id TEXT NOT NULL,
 thread_ts TEXT NOT NULL,card_ts TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,batch_id,team_id,channel_id)
);
-- Preserved during whole-database restore; D1 browser sessions cannot create publications.
CREATE TABLE IF NOT EXISTS release_publications (
 workspace_id TEXT NOT NULL,batch_id TEXT NOT NULL,team_id TEXT NOT NULL,channel_id TEXT NOT NULL,published_by TEXT NOT NULL,binding_id TEXT NOT NULL,
 published_at TEXT NOT NULL,command_id TEXT NOT NULL,first_version INTEGER NOT NULL CHECK(first_version>0),PRIMARY KEY(workspace_id,batch_id),
 FOREIGN KEY(workspace_id,batch_id) REFERENCES release_batches(workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS release_batches_order ON release_batches(workspace_id,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS release_events_order ON release_events(workspace_id,batch_id,version DESC);
CREATE TRIGGER IF NOT EXISTS release_command_validate BEFORE INSERT ON release_commands BEGIN
 SELECT RAISE(ABORT,'release_forbidden') WHERE NEW.operation='publish_thread';
 SELECT RAISE(ABORT,'release_invalid_input') WHERE NOT json_valid(NEW.data) OR NOT json_valid(NEW.command) OR NOT json_valid(NEW.result_json)
  OR NEW.batch_id IS NOT json_extract(NEW.data,'$.id') OR NEW.workspace_id IS NOT json_extract(NEW.data,'$.workspaceId')
  OR NEW.id IS NOT json_extract(NEW.command,'$.commandId') OR NEW.batch_id IS NOT json_extract(NEW.command,'$.batchId')
  OR NEW.expected_version IS NOT json_extract(NEW.command,'$.expectedVersion') OR NEW.operation IS NOT json_extract(NEW.command,'$.operation')
  OR json_extract(NEW.data,'$.version') IS NOT NEW.expected_version+1 OR json_extract(NEW.data,'$.manifestRevision')<1
  OR length(NEW.data)>500000 OR length(NEW.request_hash)<>64;
 SELECT RAISE(ABORT,'release_forbidden') WHERE NOT EXISTS(SELECT 1 FROM members m JOIN auth_users u ON u.id=m.auth_id
  WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.actor_id AND m.auth_id=NEW.auth_id AND m.is_active=1 AND COALESCE(u.banned,0)=0
  AND m.role IN('admin','super_admin') AND (SELECT count(*) FROM members WHERE workspace_id=m.workspace_id AND auth_id=m.auth_id AND is_active=1)=1);
 SELECT RAISE(ABORT,'release_conflict') WHERE (NEW.operation='create' AND (NEW.expected_version<>0 OR EXISTS(SELECT 1 FROM release_batches WHERE workspace_id=NEW.workspace_id AND id=NEW.batch_id)))
  OR (NEW.operation<>'create' AND NOT EXISTS(SELECT 1 FROM release_batches WHERE workspace_id=NEW.workspace_id AND id=NEW.batch_id AND version=NEW.expected_version AND (status NOT IN('completed','cancelled') OR NEW.operation='record_maintenance' OR NEW.operation='record_result' AND json_extract(NEW.command,'$.type') IN('rollback','recovery'))));
 SELECT RAISE(ABORT,'release_reference_unavailable') WHERE NEW.operation IN('create','edit_manifest','link_evidence','start_attempt') AND (NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=json_extract(NEW.data,'$.ownerId') AND is_active=1)
  OR EXISTS(SELECT 1 FROM json_each(NEW.data,'$.components') c WHERE NOT EXISTS(SELECT 1 FROM projects p WHERE p.workspace_id=NEW.workspace_id AND p.id=json_extract(c.value,'$.projectId') AND p.is_archived=0))
  OR EXISTS(SELECT 1 FROM json_each(NEW.data,'$.components') c JOIN json_each(c.value,'$.taskIds') t WHERE NOT EXISTS(SELECT 1 FROM tasks x WHERE x.workspace_id=NEW.workspace_id AND x.id=t.value AND x.project_id=json_extract(c.value,'$.projectId'))));
 SELECT RAISE(ABORT,'release_invalid_environment') WHERE NEW.operation IN('create','edit_manifest','start_attempt') AND EXISTS(SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id AND key='deployment_environments' AND
  (json_type(value)<>'object' OR json_extract(value,'$.version') IS NOT 1 OR json_type(value,'$.values') IS NOT 'array' OR json_array_length(value,'$.values') NOT BETWEEN 1 AND 30));
 SELECT RAISE(ABORT,'release_invalid_environment') WHERE NEW.operation IN('create','edit_manifest','start_attempt') AND EXISTS(
  SELECT 1 FROM json_each(NEW.data,'$.components') c JOIN json_each(c.value,'$.targets') t
  WHERE (NEW.operation<>'start_attempt' OR json_extract(t.value,'$.environment')=json_extract(NEW.command,'$.environment'))
  AND NOT EXISTS(SELECT 1 FROM json_each(COALESCE((SELECT json_extract(value,'$.values') FROM system_settings WHERE workspace_id=NEW.workspace_id AND key='deployment_environments'),'["Dev","QA","Stage","Live Staging","Prod"]')) e WHERE e.value=json_extract(t.value,'$.environment')));
 SELECT RAISE(ABORT,'release_evidence_stale') WHERE NEW.operation='link_evidence' AND json_extract(NEW.command,'$.kind')='qa'
  AND NOT EXISTS(SELECT 1 FROM qa_issues q WHERE q.workspace_id=NEW.workspace_id AND q.id=json_extract(NEW.command,'$.issueId') AND q.version=json_extract(NEW.command,'$.issueVersion') AND json_extract(q.data,'$.fixCycle')=json_extract(NEW.data,'$.evidence[#-1].qa.fixCycle'));
END;
-- Whoever requested a release exception never decides it, whatever their role. Checked
-- against the stored batch before release_command_apply replaces it.
CREATE TRIGGER IF NOT EXISTS release_exception_self_decision BEFORE INSERT ON release_commands
WHEN NEW.operation='decide_exception' AND json_valid(NEW.command) BEGIN
 SELECT RAISE(ABORT,'release_self_decision_forbidden') WHERE EXISTS(SELECT 1 FROM release_batches b JOIN json_each(b.data,'$.exceptions') e
  WHERE b.workspace_id=NEW.workspace_id AND b.id=NEW.batch_id AND json_extract(e.value,'$.id')=json_extract(NEW.command,'$.exceptionId')
  AND json_extract(e.value,'$.requestedBy')=NEW.actor_id);
END;
CREATE TRIGGER IF NOT EXISTS release_command_apply AFTER INSERT ON release_commands BEGIN
 INSERT INTO release_batches(workspace_id,id,title,owner_id,status,version,revision,data,updated_at)
 VALUES(NEW.workspace_id,NEW.batch_id,json_extract(NEW.data,'$.title'),json_extract(NEW.data,'$.ownerId'),json_extract(NEW.data,'$.status'),json_extract(NEW.data,'$.version'),json_extract(NEW.data,'$.manifestRevision'),NEW.data,NEW.created_at)
 ON CONFLICT(workspace_id,id) DO UPDATE SET title=excluded.title,owner_id=excluded.owner_id,status=excluded.status,version=excluded.version,revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at;
 INSERT OR IGNORE INTO release_batch_projects(workspace_id,batch_id,project_id) SELECT NEW.workspace_id,NEW.batch_id,json_extract(value,'$.projectId') FROM json_each(NEW.data,'$.components');
 INSERT OR IGNORE INTO release_batch_tasks(workspace_id,batch_id,task_id) SELECT NEW.workspace_id,NEW.batch_id,t.value FROM json_each(NEW.data,'$.components') c JOIN json_each(c.value,'$.taskIds') t;
 INSERT INTO release_events(workspace_id,id,batch_id,actor_id,operation,version,revision,created_at)
 VALUES(NEW.workspace_id,NEW.event_id,NEW.batch_id,NEW.actor_id,NEW.operation,json_extract(NEW.data,'$.version'),json_extract(NEW.data,'$.manifestRevision'),NEW.created_at);
 INSERT INTO release_outbox(workspace_id,id,batch_id,event_id,created_at) VALUES(NEW.workspace_id,NEW.event_id,NEW.batch_id,NEW.event_id,NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS release_import_preserve BEFORE INSERT ON task_planning_import_guard BEGIN
 SELECT RAISE(ABORT,'release_history_requires_restore') WHERE EXISTS(SELECT 1 FROM release_batches WHERE workspace_id=NEW.workspace_id);
END;
