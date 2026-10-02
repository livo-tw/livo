-- D1 state CHECK upgrade. Run as one atomic execute; the runner probes sqlite_schema.
-- All child FKs are NO ACTION. Deferral keeps them enforced at commit while the parent is replaced.
PRAGMA defer_foreign_keys = ON;
DROP TRIGGER IF EXISTS qa_issue_insert_reference_guard;
DROP TRIGGER IF EXISTS qa_command_guard;
DROP TRIGGER IF EXISTS qa_command_environment_guard;
DROP TRIGGER IF EXISTS qa_restored_command_guard;
CREATE TABLE qa_issues_status_upgrade (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('new','triaged','in_progress','verification','verified','failed','closed','dismissed')),
  assignee_id TEXT, qa_owner_id TEXT, reporter_id TEXT NOT NULL, title TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0), updated_at TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)), PRIMARY KEY(workspace_id,id),
  CHECK (json_extract(data,'$.id') = id AND json_extract(data,'$.workspaceId') = workspace_id
    AND json_extract(data,'$.projectId') = project_id AND json_extract(data,'$.version') = version
    AND json_extract(data,'$.state') = state)
);
INSERT INTO qa_issues_status_upgrade (workspace_id,id,project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data) SELECT workspace_id,id,project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data FROM qa_issues;
DROP TABLE qa_issues;
ALTER TABLE qa_issues_status_upgrade RENAME TO qa_issues;
CREATE INDEX IF NOT EXISTS idx_qa_issues_list ON qa_issues(workspace_id,project_id,state,updated_at);
CREATE INDEX IF NOT EXISTS idx_qa_issues_assignee ON qa_issues(workspace_id,assignee_id,updated_at);
CREATE TRIGGER IF NOT EXISTS qa_issue_insert_reference_guard BEFORE INSERT ON qa_issues BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM projects WHERE workspace_id=NEW.workspace_id AND id=NEW.project_id AND is_archived=0)
    THEN RAISE(ABORT,'qa_invalid_project') END;
  SELECT CASE WHEN NEW.assignee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.assignee_id)
    THEN RAISE(ABORT,'qa_invalid_member') END;
  SELECT CASE WHEN NEW.qa_owner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.qa_owner_id)
    THEN RAISE(ABORT,'qa_invalid_member') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.data,'$.taskIds') t WHERE NOT EXISTS
    (SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND id=t.value AND project_id=NEW.project_id))
    THEN RAISE(ABORT,'qa_invalid_task') END;
END;
CREATE TRIGGER IF NOT EXISTS qa_command_guard BEFORE INSERT ON qa_commands WHEN NEW.restored_by IS NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id
    AND key='feature_toggles' AND json_extract(value,'$.qa')=1) THEN RAISE(ABORT,'qa_disabled') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id
    AND id=NEW.actor_id AND role=NEW.actor_role AND is_active=1) THEN RAISE(ABORT,'qa_forbidden') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM projects WHERE workspace_id=NEW.workspace_id
    AND id=json_extract(NEW.issue_data,'$.projectId') AND is_archived=0) THEN RAISE(ABORT,'qa_invalid_project') END;
  SELECT CASE WHEN (NEW.expected_version=-1 AND EXISTS (SELECT 1 FROM qa_issues WHERE workspace_id=NEW.workspace_id AND id=NEW.issue_id))
    OR (NEW.expected_version<>-1 AND NOT EXISTS (SELECT 1 FROM qa_issues WHERE workspace_id=NEW.workspace_id
      AND id=NEW.issue_id AND version=NEW.expected_version)) THEN RAISE(ABORT,'qa_conflict') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.issue_data,'$.taskIds') t WHERE NOT EXISTS
    (SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND id=t.value
      AND project_id=json_extract(NEW.issue_data,'$.projectId'))) THEN RAISE(ABORT,'qa_invalid_task') END;
  SELECT CASE WHEN json_extract(NEW.issue_data,'$.assigneeId') IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND is_active=1
      AND id=json_extract(NEW.issue_data,'$.assigneeId')) THEN RAISE(ABORT,'qa_invalid_member') END;
  SELECT CASE WHEN json_extract(NEW.issue_data,'$.qaOwnerId') IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND is_active=1
      AND id=json_extract(NEW.issue_data,'$.qaOwnerId')) THEN RAISE(ABORT,'qa_invalid_member') END;
  SELECT CASE WHEN json_extract(NEW.issue_data,'$.duplicateOfId') IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM qa_issues WHERE workspace_id=NEW.workspace_id
      AND project_id=json_extract(NEW.issue_data,'$.projectId')
      AND id=json_extract(NEW.issue_data,'$.duplicateOfId')) THEN RAISE(ABORT,'qa_invalid_duplicate') END;
END;
CREATE TRIGGER IF NOT EXISTS qa_command_environment_guard BEFORE INSERT ON qa_commands
WHEN NEW.restored_by IS NULL BEGIN
  SELECT CASE WHEN (NEW.expected_version=-1 OR (NEW.operation='edit' AND
    json_extract(NEW.issue_data,'$.observedEnvironment') IS NOT (SELECT json_extract(data,'$.observedEnvironment')
      FROM qa_issues WHERE workspace_id=NEW.workspace_id AND id=NEW.issue_id)))
    AND NOT COALESCE((EXISTS(SELECT 1 FROM livo_deployment_environment_settings_valid settings,
      json_each(CASE WHEN json_valid(settings.value) THEN settings.value ELSE '{}' END,'$.values') choice
      WHERE settings.workspace_id=NEW.workspace_id AND choice.value=json_extract(NEW.issue_data,'$.observedEnvironment'))
    OR (NOT EXISTS(SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id AND key='deployment_environments')
      AND json_extract(NEW.issue_data,'$.observedEnvironment') IN ('Dev','QA','Stage','Live Staging','Prod'))),0)
    THEN RAISE(ABORT,'qa_invalid_environment') END;
  SELECT CASE WHEN NEW.operation='submit_fix' AND json_type(NEW.issue_data,'$.targets') IS NOT 'array'
    THEN RAISE(ABORT,'qa_invalid_environment') END;
  SELECT CASE WHEN NEW.operation='submit_fix' AND EXISTS(SELECT 1 FROM json_each(NEW.issue_data,'$.targets') target
    WHERE NOT COALESCE((EXISTS(SELECT 1 FROM livo_deployment_environment_settings_valid settings,
      json_each(CASE WHEN json_valid(settings.value) THEN settings.value ELSE '{}' END,'$.values') choice
      WHERE settings.workspace_id=NEW.workspace_id AND choice.value=CASE WHEN target.type='object' THEN json_extract(target.value,'$.environment') END)
    OR (NOT EXISTS(SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id AND key='deployment_environments')
      AND CASE WHEN target.type='object' THEN json_extract(target.value,'$.environment') END IN ('Dev','QA','Stage','Live Staging','Prod'))),0))
    THEN RAISE(ABORT,'qa_invalid_environment') END;
END;
CREATE TRIGGER IF NOT EXISTS qa_restored_command_guard BEFORE INSERT ON qa_commands WHEN NEW.restored_by IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.restored_by
    AND role='super_admin' AND is_active=1) THEN RAISE(ABORT,'qa_forbidden') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id
    AND key='feature_toggles' AND json_extract(value,'$.qa')=1) THEN RAISE(ABORT,'qa_disabled') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM qa_issues WHERE workspace_id=NEW.workspace_id AND id=NEW.issue_id)
    THEN RAISE(ABORT,'qa_not_found') END;
END;

-- SQLite keeps a deferred counter for rows in the dropped parent even after the
-- replacement satisfies every FK. Validate the final graph before clearing that
-- counter; an orphan aborts the same transaction, never silently disables FKs.
CREATE TABLE qa_status_fk_validation (violations INTEGER NOT NULL CHECK (violations=0));
INSERT INTO qa_status_fk_validation SELECT count(*) FROM pragma_foreign_key_check;
DROP TABLE qa_status_fk_validation;
PRAGMA defer_foreign_keys = OFF;
