CREATE TABLE IF NOT EXISTS task_reminder_preferences (
  workspace_id TEXT NOT NULL DEFAULT 'default', id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  snoozed_until TEXT, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id,task_id,member_id)
);
CREATE TABLE IF NOT EXISTS task_deadline_history (
  workspace_id TEXT NOT NULL DEFAULT 'default', id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id TEXT, previous_due_date TEXT, next_due_date TEXT, previous_kind TEXT, next_kind TEXT,
  reason TEXT, version INTEGER NOT NULL CHECK(version>0), changed_at TEXT NOT NULL,
  UNIQUE(workspace_id,task_id,version)
);
CREATE TRIGGER IF NOT EXISTS livo_deadline_update_guard BEFORE UPDATE ON tasks BEGIN
  SELECT CASE WHEN NULLIF(NEW.due_date,'') IS NULL AND NULLIF(OLD.due_date,'') IS NOT NULL
    AND EXISTS(SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id AND key='required_fields' AND json_extract(value,'$.dueDate')=1)
    THEN RAISE(ABORT,'planning_date_required') END;
  SELECT CASE WHEN NEW.due_date_kind IS NOT NULL AND NEW.due_date_kind NOT IN ('estimated','committed')
    THEN RAISE(ABORT,'planning_invalid_kind') END;
  SELECT CASE WHEN NULLIF(NEW.due_date,'') IS NULL AND NEW.due_date_kind IS NOT NULL
    THEN RAISE(ABORT,'planning_date_required') END;
  SELECT CASE WHEN (NULLIF(NEW.due_date,'') IS NOT NULL AND (length(NEW.due_date)<>10 OR
    NEW.due_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR
    date(NEW.due_date,'+0 days') IS NOT NEW.due_date)) AND (NEW.due_date IS NOT OLD.due_date)
    THEN RAISE(ABORT,'planning_invalid_date') END;
  SELECT CASE WHEN length(COALESCE(NEW.due_date_change_reason,''))>2000
    THEN RAISE(ABORT,'planning_invalid_reason') END;
  SELECT CASE WHEN OLD.due_date_kind='committed' AND NULLIF(OLD.due_date,'') IS NOT NULL
    AND (NULLIF(NEW.due_date,'') IS NULL OR NEW.due_date>OLD.due_date)
    AND NULLIF(trim(NEW.due_date_change_reason),'') IS NULL THEN RAISE(ABORT,'planning_reason_required') END;
  SELECT CASE WHEN NEW.due_date_version<>OLD.due_date_version+
    CASE WHEN NULLIF(NEW.due_date,'') IS NOT NULLIF(OLD.due_date,'') OR NEW.due_date_kind IS NOT OLD.due_date_kind THEN 1 ELSE 0 END
    THEN RAISE(ABORT,'planning_conflict') END;
  SELECT CASE WHEN NEW.due_date_changed_by IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.due_date_changed_by AND is_active=1)
    THEN RAISE(ABORT,'planning_forbidden') END;
END;
CREATE TRIGGER IF NOT EXISTS livo_deadline_insert_guard BEFORE INSERT ON tasks BEGIN
  SELECT CASE WHEN NULLIF(NEW.due_date,'') IS NULL AND NEW.due_date_kind IS NOT NULL
    THEN RAISE(ABORT,'planning_date_required') END;
  SELECT CASE WHEN NEW.due_date_version<>0 THEN RAISE(ABORT,'planning_conflict') END;
END;
-- Inputs are per mutation, never stored for a later unrelated change.
CREATE TRIGGER IF NOT EXISTS livo_deadline_clear_input AFTER UPDATE ON tasks
WHEN NEW.due_date_version=OLD.due_date_version AND (NEW.due_date_change_reason IS NOT NULL OR NEW.due_date_changed_by IS NOT NULL)
BEGIN UPDATE tasks SET due_date_change_reason=NULL,due_date_changed_by=NULL WHERE workspace_id=NEW.workspace_id AND id=NEW.id; END;
CREATE TRIGGER IF NOT EXISTS livo_deadline_clear_insert_input AFTER INSERT ON tasks
WHEN NEW.due_date_change_reason IS NOT NULL OR NEW.due_date_changed_by IS NOT NULL
BEGIN UPDATE tasks SET due_date_change_reason=NULL,due_date_changed_by=NULL WHERE workspace_id=NEW.workspace_id AND id=NEW.id; END;
CREATE TRIGGER IF NOT EXISTS livo_deadline_history AFTER UPDATE ON tasks
WHEN NEW.due_date_version<>OLD.due_date_version BEGIN
  INSERT INTO task_deadline_history(workspace_id,id,task_id,actor_id,previous_due_date,next_due_date,previous_kind,next_kind,reason,version,changed_at)
    VALUES(NEW.workspace_id,lower(hex(randomblob(16))),NEW.id,NEW.due_date_changed_by,NULLIF(OLD.due_date,''),NULLIF(NEW.due_date,''),
      OLD.due_date_kind,NEW.due_date_kind,NULLIF(trim(NEW.due_date_change_reason),''),NEW.due_date_version,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  UPDATE tasks SET due_date_change_reason=NULL,due_date_changed_by=NULL WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS livo_reminder_insert_guard BEFORE INSERT ON task_reminder_preferences BEGIN
  SELECT CASE WHEN NEW.version<>1 THEN RAISE(ABORT,'planning_conflict') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id
    WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND COALESCE(p.is_archived,0)=0)
    OR NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.member_id AND is_active=1)
    THEN RAISE(ABORT,'planning_unavailable') END;
  SELECT CASE WHEN NEW.snoozed_until IS NOT NULL AND (julianday(NEW.snoozed_until) IS NULL OR
    julianday(NEW.snoozed_until)<=julianday('now') OR julianday(NEW.snoozed_until)>julianday('now','+366 days'))
    THEN RAISE(ABORT,'planning_invalid_pause') END;
END;
CREATE TRIGGER IF NOT EXISTS livo_reminder_update_guard BEFORE UPDATE ON task_reminder_preferences BEGIN
  SELECT CASE WHEN NEW.workspace_id<>OLD.workspace_id OR NEW.id<>OLD.id OR NEW.task_id<>OLD.task_id OR NEW.member_id<>OLD.member_id
    OR NEW.version<>OLD.version+1 THEN RAISE(ABORT,'planning_conflict') END;
  SELECT CASE WHEN NEW.snoozed_until IS NOT NULL AND (julianday(NEW.snoozed_until) IS NULL OR
    julianday(NEW.snoozed_until)<=julianday('now') OR julianday(NEW.snoozed_until)>julianday('now','+366 days'))
    THEN RAISE(ABORT,'planning_invalid_pause') END;
END;
CREATE TRIGGER IF NOT EXISTS livo_suppress_paused_due BEFORE INSERT ON notifications
WHEN NEW.type='due_soon' AND EXISTS(SELECT 1 FROM task_reminder_preferences p WHERE p.workspace_id=NEW.workspace_id
  AND p.task_id=NEW.task_id AND p.member_id=NEW.recipient_id AND julianday(p.snoozed_until)>julianday('now'))
BEGIN SELECT RAISE(IGNORE); END;
-- Server-only transient assertion, inserted and removed within the same batch
-- as every child/task delete. This is never an authorization receipt.
CREATE TABLE IF NOT EXISTS task_planning_import_guard(workspace_id TEXT PRIMARY KEY);
CREATE TRIGGER IF NOT EXISTS livo_planning_import_approval_guard BEFORE INSERT ON task_planning_import_guard
WHEN EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=NEW.workspace_id AND status='pending')
  OR EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND (current_approval_id IS NOT NULL OR approval_status IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'approval_pending'); END;
CREATE TRIGGER IF NOT EXISTS livo_planning_import_guard BEFORE INSERT ON task_planning_import_guard
WHEN EXISTS(SELECT 1 FROM task_deadline_history WHERE workspace_id=NEW.workspace_id)
  OR EXISTS(SELECT 1 FROM task_reminder_preferences WHERE workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'planning_history_requires_restore'); END;
