-- Server-only QA project settings and commands. Never expose these tables through db registry.
CREATE TABLE IF NOT EXISTS qa_project_coordination (
 workspace_id TEXT NOT NULL,id TEXT NOT NULL,coordinator_id TEXT,version INTEGER NOT NULL CHECK(version>0),updated_by TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS qa_coordination_commands (
 workspace_id TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT NOT NULL,actor_id TEXT NOT NULL,actor_auth_id TEXT NOT NULL,payload_hash TEXT NOT NULL,
 expected_version INTEGER NOT NULL,response TEXT NOT NULL CHECK(json_valid(response)),created_at TEXT NOT NULL,restored_by TEXT,PRIMARY KEY(workspace_id,id)
);
DROP TRIGGER IF EXISTS qa_coordination_guard;
CREATE TRIGGER qa_coordination_guard BEFORE INSERT ON qa_coordination_commands WHEN NEW.restored_by IS NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id AND key='feature_toggles' AND json_extract(value,'$.qa')=1) THEN RAISE(ABORT,'qa_disabled') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM auth_users WHERE id=NEW.actor_auth_id AND COALESCE(banned,0)=0) THEN RAISE(ABORT,'qa_forbidden') END;
 SELECT CASE WHEN (SELECT count(*) FROM members WHERE workspace_id=NEW.workspace_id AND auth_id=NEW.actor_auth_id AND is_active=1)<>1 OR NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.actor_id AND auth_id=NEW.actor_auth_id AND is_active=1 AND role IN ('admin','super_admin')) THEN RAISE(ABORT,'qa_forbidden') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM projects WHERE workspace_id=NEW.workspace_id AND id=NEW.project_id AND is_archived=0) THEN RAISE(ABORT,'qa_project_unavailable') END;
 SELECT CASE WHEN NEW.expected_version<0 OR COALESCE((SELECT version FROM qa_project_coordination WHERE workspace_id=NEW.workspace_id AND id=NEW.project_id),0)<>NEW.expected_version THEN RAISE(ABORT,'qa_version_conflict') END;
 SELECT CASE WHEN json_extract(NEW.response,'$.projectId') IS NOT NEW.project_id OR json_extract(NEW.response,'$.version') IS NOT NEW.expected_version+1 THEN RAISE(ABORT,'qa_invalid_request') END;
 SELECT CASE WHEN json_extract(NEW.response,'$.coordinatorId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=json_extract(NEW.response,'$.coordinatorId') AND is_active=1) THEN RAISE(ABORT,'qa_member_unavailable') END;
END;
DROP TRIGGER IF EXISTS qa_command_coordination_guard;
CREATE TRIGGER qa_command_coordination_guard BEFORE INSERT ON qa_commands WHEN NEW.restored_by IS NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM auth_users WHERE id=NEW.actor_auth_id AND COALESCE(banned,0)=0) THEN RAISE(ABORT,'qa_forbidden') END;
 SELECT CASE WHEN NEW.actor_auth_id IS NULL OR (SELECT count(*) FROM members WHERE workspace_id=NEW.workspace_id AND auth_id=NEW.actor_auth_id AND is_active=1)<>1 OR NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.actor_id AND auth_id=NEW.actor_auth_id AND is_active=1 AND role=NEW.actor_role) THEN RAISE(ABORT,'qa_forbidden') END;
 SELECT CASE WHEN NEW.operation NOT IN ('create','set_state','update_fields','edit','triage','start_fix','submit_fix','record_deployment','record_verification','close','reopen','hold','link_tasks','comment','request_handoff','accept_handoff','resolve_handoff') THEN RAISE(ABORT,'qa_forbidden') END;
 SELECT CASE WHEN NEW.operation<>'create' AND NOT EXISTS(SELECT 1 FROM qa_issues q WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND (q.project_id=json_extract(NEW.issue_data,'$.projectId') OR NEW.operation='update_fields') AND q.reporter_id=json_extract(NEW.issue_data,'$.reporterId') AND (q.state NOT IN ('closed','dismissed') OR NEW.operation IN ('reopen','comment','set_state','update_fields')) AND CASE
  WHEN NEW.operation='accept_handoff' THEN json_extract(q.data,'$.handoff.nextOwnerId')=NEW.actor_id AND json_extract(q.data,'$.handoff.acceptedAt') IS NULL AND json_extract(q.data,'$.handoff.resolvedAt') IS NULL
  WHEN NEW.operation='resolve_handoff' THEN (NEW.actor_role IN ('admin','super_admin') OR json_extract(q.data,'$.handoff.nextOwnerId')=NEW.actor_id) AND json_extract(q.data,'$.handoff.resolvedAt') IS NULL
  WHEN NEW.actor_role IN ('admin','super_admin') THEN 1
  WHEN NEW.operation IN ('triage','update_fields','comment') THEN 1
  WHEN NEW.operation IN ('triage','hold','request_handoff') AND EXISTS(SELECT 1 FROM qa_project_coordination c WHERE c.workspace_id=q.workspace_id AND c.id=q.project_id AND c.coordinator_id=NEW.actor_id) THEN 1
  WHEN NEW.operation IN ('triage','record_verification','close') THEN q.qa_owner_id=NEW.actor_id
  WHEN NEW.operation IN ('start_fix','submit_fix') THEN q.assignee_id=NEW.actor_id
  WHEN NEW.operation='record_deployment' THEN q.assignee_id=NEW.actor_id OR q.qa_owner_id=NEW.actor_id OR EXISTS(
   SELECT 1 FROM livo_deployment_queue_settings_valid settings JOIN system_settings flags ON flags.workspace_id=settings.workspace_id AND flags.key='feature_toggles'
   WHERE settings.workspace_id=NEW.workspace_id AND json_extract(settings.value,'$.enabled')=1 AND CASE WHEN json_valid(flags.value) THEN json_type(flags.value,'$.deploymentQueue')='true' ELSE 0 END
    AND EXISTS(SELECT 1 FROM json_each(settings.value,'$.operatorMemberIds') WHERE value=NEW.actor_id))
  WHEN NEW.operation='link_tasks' THEN q.assignee_id=NEW.actor_id OR q.qa_owner_id=NEW.actor_id
  ELSE NEW.actor_id IN (q.assignee_id,q.qa_owner_id,q.reporter_id) END) THEN RAISE(ABORT,'qa_forbidden') END;
 SELECT CASE WHEN NEW.operation='request_handoff' AND json_extract(NEW.issue_data,'$.handoff.replyBy') IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(NEW.issue_data,'$.handoff.replyBy')) IS NOT json_extract(NEW.issue_data,'$.handoff.replyBy') THEN RAISE(ABORT,'qa_invalid_date') END;
 SELECT CASE WHEN NEW.operation='request_handoff' AND EXISTS(SELECT 1 FROM qa_issues q WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND json_extract(q.data,'$.handoff.id')=json_extract(NEW.issue_data,'$.handoff.id')) THEN RAISE(ABORT,'qa_invalid_request') END;
 SELECT CASE WHEN NEW.operation='request_handoff' AND (NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=json_extract(NEW.issue_data,'$.handoff.nextOwnerId') AND is_active=1)
  OR COALESCE(trim(json_extract(NEW.issue_data,'$.handoff.reason')),'')='' OR length(json_extract(NEW.issue_data,'$.handoff.reason'))>8000
  OR json_extract(NEW.issue_data,'$.handoff.requestedBy') IS NOT NEW.actor_id OR json_extract(NEW.issue_data,'$.handoff.requestedAt') IS NOT json_extract(NEW.issue_data,'$.updatedAt')
  OR json_extract(NEW.issue_data,'$.handoff.acceptedBy') IS NOT NULL OR json_extract(NEW.issue_data,'$.handoff.acceptedAt') IS NOT NULL
  OR json_extract(NEW.issue_data,'$.handoff.resolvedBy') IS NOT NULL OR json_extract(NEW.issue_data,'$.handoff.resolvedAt') IS NOT NULL
  OR json_extract(NEW.issue_data,'$.handoff.resolutionEvidence') IS NOT '') THEN RAISE(ABORT,'qa_invalid_request') END;
 SELECT CASE WHEN NEW.operation IN ('request_handoff','accept_handoff','resolve_handoff') AND EXISTS(SELECT 1 FROM qa_issues q WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND json_remove(NEW.issue_data,'$.handoff','$.version','$.updatedAt')<>json_remove(q.data,'$.handoff','$.version','$.updatedAt')) THEN RAISE(ABORT,'qa_invalid_request') END;
 SELECT CASE WHEN NEW.operation IN ('accept_handoff','resolve_handoff') AND NOT EXISTS(SELECT 1 FROM qa_issues q WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND json_extract(NEW.issue_data,'$.handoff.id')=json_extract(q.data,'$.handoff.id') AND CASE WHEN NEW.operation='accept_handoff'
  THEN json_remove(json_extract(NEW.issue_data,'$.handoff'),'$.acceptedBy','$.acceptedAt')=json_remove(json_extract(q.data,'$.handoff'),'$.acceptedBy','$.acceptedAt') AND json_extract(NEW.issue_data,'$.handoff.acceptedBy')=NEW.actor_id AND json_extract(NEW.issue_data,'$.handoff.acceptedAt')=json_extract(NEW.issue_data,'$.updatedAt')
  ELSE json_remove(json_extract(NEW.issue_data,'$.handoff'),'$.resolvedBy','$.resolvedAt','$.resolutionEvidence')=json_remove(json_extract(q.data,'$.handoff'),'$.resolvedBy','$.resolvedAt','$.resolutionEvidence') AND json_extract(NEW.issue_data,'$.handoff.resolvedBy')=NEW.actor_id AND json_extract(NEW.issue_data,'$.handoff.resolvedAt')=json_extract(NEW.issue_data,'$.updatedAt') AND length(trim(json_extract(NEW.issue_data,'$.handoff.resolutionEvidence'))) BETWEEN 1 AND 8000 END) THEN RAISE(ABORT,'qa_invalid_request') END;
 SELECT CASE WHEN NEW.operation NOT IN ('create','request_handoff','accept_handoff','resolve_handoff') AND EXISTS(SELECT 1 FROM qa_issues q WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND json_extract(NEW.issue_data,'$.handoff') IS NOT json_extract(q.data,'$.handoff')) THEN RAISE(ABORT,'qa_invalid_request') END;
END;

CREATE TRIGGER IF NOT EXISTS qa_coordination_restore_guard BEFORE INSERT ON qa_coordination_commands WHEN NEW.restored_by IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.restored_by AND role='super_admin' AND is_active=1) THEN RAISE(ABORT,'qa_forbidden') END;
END;

CREATE TRIGGER IF NOT EXISTS qa_coordination_import_guard BEFORE INSERT ON task_planning_import_guard BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM qa_issues WHERE workspace_id=NEW.workspace_id AND json_array_length(data,'$.taskIds')>0) THEN RAISE(ABORT,'qa_task_links_require_restore') END;
END;

-- Metadata editing is independent of lifecycle operations and preserves all evidence.
DROP TRIGGER IF EXISTS qa_inline_fields_guard;
CREATE TRIGGER qa_inline_fields_guard BEFORE INSERT ON qa_commands
WHEN NEW.restored_by IS NULL AND NEW.operation='update_fields' BEGIN
 SELECT CASE WHEN NEW.expected_version<1 OR NOT EXISTS(SELECT 1 FROM qa_issues q
  WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND q.version=NEW.expected_version)
  THEN RAISE(ABORT,'qa_conflict') END;
 SELECT CASE WHEN json_type(NEW.issue_data,'$.priority') IS NOT 'integer'
  OR json_extract(NEW.issue_data,'$.priority') NOT BETWEEN 1 AND 5
  OR json_extract(NEW.issue_data,'$.severity') NOT IN ('untriaged','low','medium','high')
  OR json_type(NEW.issue_data,'$.severity') IS NOT 'text'
  OR json_type(NEW.issue_data,'$.assigneeId') IS NULL OR json_type(NEW.issue_data,'$.assigneeId') NOT IN ('null','text')
  OR json_type(NEW.issue_data,'$.qaOwnerId') IS NULL OR json_type(NEW.issue_data,'$.qaOwnerId') NOT IN ('null','text')
  OR json_type(NEW.issue_data,'$.dueDate') IS NULL OR json_type(NEW.issue_data,'$.dueDate') NOT IN ('null','text')
  OR (json_type(NEW.issue_data,'$.dueDate')='text' AND date(json_extract(NEW.issue_data,'$.dueDate'),'0 days') IS NOT json_extract(NEW.issue_data,'$.dueDate'))
  THEN RAISE(ABORT,'qa_invalid_request') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM qa_issues q, json_each(NEW.issue_data) n
  LEFT JOIN json_each(q.data) o ON o.key=n.key
  WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id
  AND n.key NOT IN ('projectId','assigneeId','qaOwnerId','severity','priority','dueDate','version','updatedAt')
  AND (o.key IS NULL OR n.value IS NOT o.value OR n.type IS NOT o.type))
  OR EXISTS(SELECT 1 FROM qa_issues q, json_each(q.data) o
  LEFT JOIN json_each(NEW.issue_data) n ON n.key=o.key
  WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id
  AND o.key NOT IN ('projectId','assigneeId','qaOwnerId','severity','priority','dueDate','version','updatedAt') AND n.key IS NULL)
  THEN RAISE(ABORT,'qa_invalid_request') END;
END;

-- Retired pause preferences must not silently hide deadline notifications.
DROP TRIGGER IF EXISTS livo_suppress_paused_due;


-- Malformed or incomplete deployment settings cannot grant a database capability.
CREATE VIEW IF NOT EXISTS livo_deployment_queue_settings_valid AS
SELECT workspace_id,value FROM system_settings s WHERE s.key='deployment_queue' AND CASE WHEN json_valid(s.value) THEN
 json_type(s.value)='object' AND json_type(s.value,'$.version')='integer' AND json_extract(s.value,'$.version')=1
 AND json_type(s.value,'$.enabled') IN ('true','false') AND (SELECT count(*) FROM json_each(s.value))=4
 AND NOT EXISTS(SELECT 1 FROM json_each(s.value) WHERE key NOT IN ('version','enabled','taskStatusIds','operatorMemberIds'))
 AND json_type(s.value,'$.taskStatusIds')='array' AND json_type(s.value,'$.operatorMemberIds')='array'
 AND json_array_length(s.value,'$.taskStatusIds')<=200 AND json_array_length(s.value,'$.operatorMemberIds')<=200
 AND NOT EXISTS(SELECT 1 FROM json_each(s.value,'$.taskStatusIds') WHERE type<>'text' OR length(value) NOT BETWEEN 1 AND 100 OR value GLOB '*[^a-zA-Z0-9_-]*' OR substr(value,1,1) NOT GLOB '[a-zA-Z0-9]')
 AND NOT EXISTS(SELECT 1 FROM json_each(s.value,'$.operatorMemberIds') WHERE type<>'text' OR length(value) NOT BETWEEN 1 AND 100 OR value GLOB '*[^a-zA-Z0-9_-]*' OR substr(value,1,1) NOT GLOB '[a-zA-Z0-9]')
 AND (SELECT count(*) FROM json_each(s.value,'$.taskStatusIds'))=(SELECT count(DISTINCT value) FROM json_each(s.value,'$.taskStatusIds'))
 AND (SELECT count(*) FROM json_each(s.value,'$.operatorMemberIds'))=(SELECT count(DISTINCT value) FROM json_each(s.value,'$.operatorMemberIds'))
 ELSE 0 END;
DROP TRIGGER IF EXISTS qa_deployment_fields_guard;
CREATE TRIGGER qa_deployment_fields_guard BEFORE INSERT ON qa_commands
WHEN NEW.restored_by IS NULL AND NEW.operation='record_deployment' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM qa_issues q WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND q.state IN ('verification','verified'))
  OR json_type(NEW.issue_data,'$.targets') IS NOT 'array' THEN RAISE(ABORT,'qa_invalid_request') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM qa_issues q, json_each(NEW.issue_data) n LEFT JOIN json_each(q.data) o ON o.key=n.key
  WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND n.key NOT IN ('targets','version','updatedAt') AND (o.key IS NULL OR n.value IS NOT o.value OR n.type IS NOT o.type))
  OR EXISTS(SELECT 1 FROM qa_issues q, json_each(q.data) o LEFT JOIN json_each(NEW.issue_data) n ON n.key=o.key
  WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND o.key NOT IN ('targets','version','updatedAt') AND n.key IS NULL)
  THEN RAISE(ABORT,'qa_invalid_request') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM qa_issues q WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id
  AND (json_array_length(NEW.issue_data,'$.targets')<>json_array_length(q.data,'$.targets') OR json_array_length(NEW.issue_data,'$.targets')<1))
  OR EXISTS(SELECT 1 FROM qa_issues q,json_each(NEW.issue_data,'$.targets') n JOIN json_each(q.data,'$.targets') o ON o.key=n.key
   WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND json_remove(n.value,'$.deployedAt','$.deployedBy','$.deploymentEvidence')<>json_remove(o.value,'$.deployedAt','$.deployedBy','$.deploymentEvidence'))
  OR (SELECT count(*) FROM qa_issues q,json_each(NEW.issue_data,'$.targets') n JOIN json_each(q.data,'$.targets') o ON o.key=n.key
   WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND n.value IS NOT o.value)>1
  OR EXISTS(SELECT 1 FROM qa_issues q,json_each(NEW.issue_data,'$.targets') n JOIN json_each(q.data,'$.targets') o ON o.key=n.key
   WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND n.value IS NOT o.value
    AND (json_type(n.value,'$.deployedAt') IS NOT 'text' OR json_extract(n.value,'$.deployedAt') IS NOT json_extract(NEW.issue_data,'$.updatedAt')
     OR json_extract(n.value,'$.deployedBy') IS NOT NEW.actor_id OR json_type(n.value,'$.deploymentEvidence') IS NOT 'text' OR length(json_extract(n.value,'$.deploymentEvidence'))>8000))
  THEN RAISE(ABORT,'qa_invalid_request') END;
END;
