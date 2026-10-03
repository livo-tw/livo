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
 SELECT CASE WHEN NEW.operation NOT IN ('create','set_state','edit','triage','start_fix','submit_fix','record_deployment','record_verification','close','reopen','hold','link_tasks','comment','request_handoff','accept_handoff','resolve_handoff') THEN RAISE(ABORT,'qa_forbidden') END;
 SELECT CASE WHEN NEW.operation<>'create' AND NOT EXISTS(SELECT 1 FROM qa_issues q WHERE q.workspace_id=NEW.workspace_id AND q.id=NEW.issue_id AND q.project_id=json_extract(NEW.issue_data,'$.projectId') AND q.reporter_id=json_extract(NEW.issue_data,'$.reporterId') AND (q.state NOT IN ('closed','dismissed') OR NEW.operation IN ('reopen','comment','set_state')) AND CASE
  WHEN NEW.operation='accept_handoff' THEN json_extract(q.data,'$.handoff.nextOwnerId')=NEW.actor_id AND json_extract(q.data,'$.handoff.acceptedAt') IS NULL AND json_extract(q.data,'$.handoff.resolvedAt') IS NULL
  WHEN NEW.operation='resolve_handoff' THEN (NEW.actor_role IN ('admin','super_admin') OR json_extract(q.data,'$.handoff.nextOwnerId')=NEW.actor_id) AND json_extract(q.data,'$.handoff.resolvedAt') IS NULL
  WHEN NEW.actor_role IN ('admin','super_admin') THEN 1
  WHEN NEW.operation IN ('triage','hold','request_handoff') AND EXISTS(SELECT 1 FROM qa_project_coordination c WHERE c.workspace_id=q.workspace_id AND c.id=q.project_id AND c.coordinator_id=NEW.actor_id) THEN 1
  WHEN NEW.operation IN ('triage','record_verification','close') THEN q.qa_owner_id=NEW.actor_id
  WHEN NEW.operation IN ('start_fix','submit_fix') THEN q.assignee_id=NEW.actor_id
  WHEN NEW.operation IN ('record_deployment','link_tasks') THEN q.assignee_id=NEW.actor_id OR q.qa_owner_id=NEW.actor_id
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
