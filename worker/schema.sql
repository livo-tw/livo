-- LIVO D1 schema — full Postgres → SQLite translation.
-- Conventions (DESIGN.md):
--   ids/timestamps/json → TEXT; booleans → INTEGER 0/1; enums → TEXT + CHECK.
--   uuid/expression PK defaults are generated in db.ts (crypto.randomUUID()),
--   NOT via SQL default. Timestamp columns keep a strftime() fallback default,
--   but db.ts fills ISO strings on insert (autoNowCols in tables.ts).
--   PRAGMA foreign_keys is always ON in D1.
--
-- Idempotent: every statement is CREATE ... IF NOT EXISTS.
--
-- TENANCY (2026-07 cloud beta, see CLOUD-BETA-DESIGN.md): every tenant table
-- carries `workspace_id TEXT NOT NULL DEFAULT 'default'`. Fresh DBs get it
-- from these CREATEs; PRE-EXISTING DBs must run migrate/tenant-alters.sql
-- via migrate/apply-tenant-alters.mjs BEFORE this file (CI does this).
-- Self-host / local installs keep everything in workspace 'default' and see
-- no behavior change.

-- ── Auth (Worker-issued JWTs; replaces Supabase GoTrue) ─────────────────────

-- Knowledge base: composite references keep pages/files inside their workspace.
CREATE TABLE IF NOT EXISTS kb_pages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  body TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 1000000),
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  parent_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  admin_only INTEGER NOT NULL DEFAULT 0 CHECK (admin_only IN (0,1)),
  category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('general','meeting')),
  access_policy TEXT NOT NULL DEFAULT '{"mode":"inherit"}' CHECK (json_valid(access_policy)),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id) REFERENCES kb_pages(workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_kb_pages_scope ON kb_pages(workspace_id, project_id, parent_id, sort_order);
CREATE TABLE IF NOT EXISTS kb_revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  page_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL,
  UNIQUE(workspace_id, page_id, version),
  FOREIGN KEY (workspace_id, page_id) REFERENCES kb_pages(workspace_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS kb_attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  page_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size >= 0 AND file_size <= 2097152),
  file_type TEXT NOT NULL DEFAULT '',
  storage_path TEXT NOT NULL UNIQUE,
  storage_bucket TEXT NOT NULL DEFAULT 'kb-files',
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (workspace_id, page_id) REFERENCES kb_pages(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_kb_attachments_page ON kb_attachments(workspace_id, page_id);

CREATE TABLE IF NOT EXISTS kb_comments (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'default', page_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 10000), created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (workspace_id,page_id) REFERENCES kb_pages(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_kb_comments_page ON kb_comments(workspace_id,page_id,created_at);

CREATE TRIGGER IF NOT EXISTS kb_insert_tree BEFORE INSERT ON kb_pages BEGIN
  SELECT CASE WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM projects WHERE workspace_id = NEW.workspace_id AND id = NEW.project_id AND is_archived = 0
  ) THEN RAISE(ABORT, 'kb_invalid_project') END;
  SELECT CASE WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM kb_pages WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id
      AND project_id IS NEW.project_id AND is_archived = 0
  ) THEN RAISE(ABORT, 'kb_invalid_parent') END;
  SELECT CASE WHEN (WITH RECURSIVE ancestors(id, parent_id, depth) AS (
    SELECT id, parent_id, 1 FROM kb_pages WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id
    UNION ALL SELECT p.id, p.parent_id, a.depth+1 FROM kb_pages p JOIN ancestors a ON p.id = a.parent_id
      WHERE p.workspace_id = NEW.workspace_id AND a.depth < 3
  ) SELECT COALESCE(MAX(depth),0) FROM ancestors) >= 3 THEN RAISE(ABORT, 'kb_depth') END;
END;

CREATE TRIGGER IF NOT EXISTS kb_update_tree BEFORE UPDATE OF parent_id, project_id ON kb_pages BEGIN
  SELECT CASE WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM projects WHERE workspace_id = NEW.workspace_id AND id = NEW.project_id
      AND (is_archived = 0 OR NEW.project_id IS OLD.project_id)
  ) THEN RAISE(ABORT, 'kb_invalid_project') END;
  SELECT CASE WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM kb_pages WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id
      AND project_id IS NEW.project_id AND (is_archived = 0 OR NEW.parent_id IS OLD.parent_id)
  ) THEN RAISE(ABORT, 'kb_invalid_parent') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM kb_pages WHERE workspace_id = NEW.workspace_id
    AND parent_id = NEW.id AND project_id IS NOT NEW.project_id) THEN RAISE(ABORT, 'kb_invalid_parent') END;
  SELECT CASE WHEN (WITH RECURSIVE ancestors(id, parent_id, depth) AS (
    SELECT id, parent_id, 1 FROM kb_pages WHERE workspace_id = NEW.workspace_id AND id = NEW.parent_id
    UNION ALL SELECT p.id, p.parent_id, a.depth+1 FROM kb_pages p JOIN ancestors a ON p.id = a.parent_id
      WHERE p.workspace_id = NEW.workspace_id AND a.depth < 3
  ), descendants(id, depth) AS (
    SELECT NEW.id, 1 UNION ALL SELECT p.id, d.depth+1 FROM kb_pages p JOIN descendants d ON p.parent_id = d.id
      WHERE p.workspace_id = NEW.workspace_id AND d.depth < 4
  ) SELECT CASE WHEN EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id) THEN 4
    ELSE (SELECT COALESCE(MAX(depth),0) FROM ancestors) + (SELECT MAX(depth) FROM descendants) END
  ) > 3 THEN RAISE(ABORT, 'kb_depth') END;
END;

-- The previous body and pruning commit in the SAME statement as the edit.
CREATE TRIGGER IF NOT EXISTS kb_save_revision AFTER UPDATE ON kb_pages
WHEN NEW.version != OLD.version BEGIN
  INSERT INTO kb_revisions(id, workspace_id, page_id, body, created_by, created_at, version)
    VALUES (lower(hex(randomblob(16))), OLD.workspace_id, OLD.id, OLD.body, OLD.updated_by, OLD.updated_at, OLD.version);
  DELETE FROM kb_revisions WHERE workspace_id = NEW.workspace_id AND page_id = NEW.id AND id IN (
    SELECT id FROM kb_revisions WHERE workspace_id = NEW.workspace_id AND page_id = NEW.id
      ORDER BY version DESC LIMIT -1 OFFSET 20
  );
END;

CREATE TABLE IF NOT EXISTS auth_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT,
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- replaced_by / consumed_at support a short refresh-token reuse-grace window so
-- rotation does not sign out other tabs racing on the same token. NOTE: these
-- columns are added only to this CREATE — D1 has no IF NOT EXISTS for ADD COLUMN,
-- so an existing local DB needs a fresh schema apply to pick them up.
CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  replaced_by TEXT,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_user ON auth_refresh_tokens (user_id);
-- The refresh handler purges expired tokens by expires_at (perf audit §3):
CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_expires ON auth_refresh_tokens (expires_at);

-- Login throttle is global auth plumbing: identity is not tenant-scoped before login.
-- failures counts confirmed failures ONLY; in-flight work has expiring reservations.
CREATE TABLE IF NOT EXISTS auth_login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures>=0),
  window_start TEXT NOT NULL,
  locked_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_window ON auth_login_attempts(window_start);
CREATE TABLE IF NOT EXISTS auth_login_reservations (
  id TEXT PRIMARY KEY,
  email_key TEXT NOT NULL,
  email_window TEXT NOT NULL,
  ip_key TEXT,
  ip_window TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_login_reservations_email ON auth_login_reservations(email_key,email_window,expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_login_reservations_ip ON auth_login_reservations(ip_key,ip_window,expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_login_reservations_expiry ON auth_login_reservations(expires_at);

-- ── Core team / board tables ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS members (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  avatar     TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('super_admin','admin','member')),
  is_qa_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_qa_admin IN (0,1)),
  job_title  TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT '#6B778C',
  email      TEXT NOT NULL DEFAULT '',
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  auth_id    TEXT,                          -- no FK: imported data may hold stale ids; app heals by email
  theme      TEXT NOT NULL DEFAULT 'dark'
);
-- Unique email so the email-fallback heal in requireMember can never match two rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_email_nocase ON members(email COLLATE NOCASE);
-- requireMember's primary lookup — the hottest query in the system (perf audit §1):
CREATE INDEX IF NOT EXISTS idx_members_auth_id ON members (auth_id);

-- Supabase profiles table (auth-coupled; kept for parity, unused by the app UI)
CREATE TABLE IF NOT EXISTS profiles (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id           TEXT PRIMARY KEY,            -- = auth_users.id
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url   TEXT,
  created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS product_lines (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT NOT NULL DEFAULT '📁',
  color      TEXT NOT NULL DEFAULT '#6B778C',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projects (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id          TEXT PRIMARY KEY,
  line_id     TEXT NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  key         TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6B778C',
  is_archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS statuses (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,                 -- deliberately NOT unique (skipped migration)
  color      TEXT NOT NULL DEFAULT '#6B778C',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_done    INTEGER NOT NULL DEFAULT 0,
  auto_start INTEGER NOT NULL DEFAULT 0,
  auto_done  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sprints (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id              TEXT PRIMARY KEY,         -- uuid generated in db.ts
  name            TEXT NOT NULL DEFAULT '',
  started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at    TEXT,
  completed_count INTEGER NOT NULL DEFAULT 0,
  pending_count   INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tasks (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id                  TEXT PRIMARY KEY,
  task_key            TEXT NOT NULL,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  status_id           TEXT NOT NULL REFERENCES statuses(id),
  priority            TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('highest','high','medium','low','lowest')),
  creator_id          TEXT NOT NULL REFERENCES members(id),
  assignee_id         TEXT REFERENCES members(id),
  reviewer_id         TEXT REFERENCES members(id),
  due_date            TEXT,
  started_at          TEXT,
  completed_at        TEXT,
  gitlab_url          TEXT,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now')),
  comment_count       INTEGER NOT NULL DEFAULT 0,
  sprint_id           TEXT REFERENCES sprints(id) ON DELETE SET NULL,
  department          TEXT,
  parent_task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  approval_status     TEXT,
  current_approval_id TEXT,                 -- no FK (PG had none)
  requires_approval   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_parent_task_id_idx ON tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks (project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status_id ON tasks (status_id);
-- Hot filters used by board/sprint views and the Slack digest (perf audit §1):
CREATE INDEX IF NOT EXISTS idx_tasks_sprint_id   ON tasks (sprint_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_id ON tasks (assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_reviewer_id ON tasks (reviewer_id);

CREATE TABLE IF NOT EXISTS task_deployments (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id          TEXT PRIMARY KEY,             -- uuid generated in db.ts
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('deployed','scheduled')),
  deploy_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_deployments_task ON task_deployments (task_id);

CREATE TABLE IF NOT EXISTS task_specs (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  background  TEXT NOT NULL DEFAULT '',
  requirement TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS task_checks (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  is_done    INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_task_checks_task ON task_checks (task_id);

CREATE TABLE IF NOT EXISTS task_todos (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  is_done    INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_task_todos_task ON task_todos (task_id);

CREATE TABLE IF NOT EXISTS comments (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES members(id),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  attachment_url  TEXT,
  attachment_name TEXT,
  attachment_size INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments (task_id);

CREATE TABLE IF NOT EXISTS status_logs (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status_id TEXT REFERENCES statuses(id),
  to_status_id   TEXT NOT NULL REFERENCES statuses(id),
  changed_by     TEXT NOT NULL REFERENCES members(id),
  changed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_status_logs_task ON status_logs (task_id);

-- No FK on task_id (app inserts '' — DESIGN.md exception); nullable per schema report §9.13
CREATE TABLE IF NOT EXISTS notifications (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id           TEXT PRIMARY KEY,            -- uuid generated in db.ts
  recipient_id TEXT NOT NULL REFERENCES members(id),
  sender_id    TEXT NOT NULL REFERENCES members(id),
  type         TEXT NOT NULL,
  task_id      TEXT,
  content      TEXT NOT NULL DEFAULT '',
  is_read      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications (recipient_id, created_at DESC);

CREATE TABLE IF NOT EXISTS member_manuals (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id            TEXT PRIMARY KEY,           -- uuid generated in db.ts
  member_id     TEXT NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
  best_state    TEXT NOT NULL DEFAULT '',
  communication TEXT NOT NULL DEFAULT '',
  difficulty    TEXT NOT NULL DEFAULT '',
  landmine      TEXT NOT NULL DEFAULT '',
  bonus         TEXT NOT NULL DEFAULT '',
  custom_fields TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(custom_fields) AND json_type(custom_fields) = 'object'),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ── Tags (pre-migration Supabase tables; shape from frontend usage) ─────────

CREATE TABLE IF NOT EXISTS tags (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6B778C'
);

CREATE TABLE IF NOT EXISTS task_tags (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id      TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_tags_task ON task_tags (task_id);
CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags (tag_id);

-- ── Backups ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS backup_settings (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id                  TEXT PRIMARY KEY,     -- uuid generated in db.ts
  enabled             INTEGER NOT NULL DEFAULT 0,
  interval_days       INTEGER NOT NULL DEFAULT 7,
  backup_hour         INTEGER NOT NULL DEFAULT 3,
  notify_email        TEXT NOT NULL DEFAULT '',
  last_backup_at      TEXT,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  notify_channel      TEXT NOT NULL DEFAULT '',
  task_notify_channel TEXT NOT NULL DEFAULT '',
  task_notify_types   TEXT NOT NULL DEFAULT '["task_created","status_changed","assignee_changed","comment_added"]',  -- JSON array (was text[])
  -- Slack DM notify window (read by slack-notify, written by 系統管理 → 通知).
  -- NOTE: pre-existing DBs created without these columns need a one-time
  --   ALTER TABLE backup_settings ADD COLUMN dm_notify_enabled INTEGER NOT NULL DEFAULT 1;
  --   ALTER TABLE backup_settings ADD COLUMN dm_notify_start_hour INTEGER NOT NULL DEFAULT 0;
  --   ALTER TABLE backup_settings ADD COLUMN dm_notify_end_hour INTEGER NOT NULL DEFAULT 24;
  -- (slack.ts reads defensively via SELECT *, so reads work either way.)
  dm_notify_enabled    INTEGER NOT NULL DEFAULT 1,
  dm_notify_start_hour INTEGER NOT NULL DEFAULT 0,
  dm_notify_end_hour   INTEGER NOT NULL DEFAULT 24
);

CREATE TABLE IF NOT EXISTS backup_history (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id           TEXT PRIMARY KEY,            -- uuid generated in db.ts
  filename     TEXT NOT NULL,
  file_size    INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ── Attachments / user prefs / logs ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS task_attachments (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id           TEXT PRIMARY KEY,            -- uuid generated in db.ts
  task_id      TEXT NOT NULL,               -- no FK (PG had none)
  file_name    TEXT NOT NULL,
  file_size    INTEGER NOT NULL DEFAULT 0,
  file_type    TEXT NOT NULL DEFAULT '',
  storage_path TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  uploaded_by  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments (task_id);

CREATE TABLE IF NOT EXISTS user_column_configs (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id           TEXT PRIMARY KEY,            -- uuid generated in db.ts
  member_id    TEXT NOT NULL,
  view_key     TEXT NOT NULL,
  visible_keys TEXT NOT NULL DEFAULT '[]',  -- JSON
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (member_id, view_key)
);

-- user_id nullable (PG had NOT NULL + ON DELETE SET NULL contradiction; resolved per report §2.20)
CREATE TABLE IF NOT EXISTS activity_logs (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id          TEXT PRIMARY KEY,             -- uuid generated in db.ts
  user_id     TEXT REFERENCES members(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT 'task',
  task_id     TEXT,
  task_key    TEXT,
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_logs_task_id ON activity_logs (task_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_id ON activity_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs (created_at DESC);

-- ── Collaborative field locks (written by rpc.ts) ───────────────────────────

-- Composite PK: lock keys are client strings (e.g. 'status-manage-presence')
-- that repeat across workspaces. Pre-tenancy DBs are recreated by
-- migrate/tenant-alters.sql (locks are 30s-TTL ephemera — safe to drop).
CREATE TABLE IF NOT EXISTS field_locks (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  lock_key   TEXT NOT NULL,
  locked_by  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, lock_key)
);
CREATE INDEX IF NOT EXISTS idx_field_locks_expires ON field_locks (expires_at);
CREATE INDEX IF NOT EXISTS idx_field_locks_locked_by ON field_locks (locked_by);

-- ── Settings key/value stores ───────────────────────────────────────────────

-- Composite PKs: every workspace has its own 'license'/'required_fields'/…
-- rows. Pre-tenancy DBs are recreated (data-preserving) by
-- migrate/tenant-alters.sql; db.ts extends upsert conflict targets with
-- workspace_id for these tables (meta wsConflict flag).
CREATE TABLE IF NOT EXISTS system_settings (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  key        TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '{}',    -- JSON
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  PRIMARY KEY (workspace_id, key)
);


-- A validated settings view keeps SQL writes and all environment consumers on
-- one contract. Missing keys use defaults; malformed stored rows fail closed.
CREATE VIEW IF NOT EXISTS livo_deployment_environment_settings_valid AS
SELECT workspace_id,settings.value FROM system_settings settings WHERE key='deployment_environments' AND
  CASE WHEN json_valid(settings.value) THEN
    CASE WHEN json_type(settings.value)='object' AND json_type(settings.value,'$.version') IN ('integer','real')
      AND json_extract(settings.value,'$.version')=1 AND json_type(settings.value,'$.values')='array' THEN
      (SELECT count(*) FROM json_each(settings.value))=2
      AND json_array_length(settings.value,'$.values') BETWEEN 1 AND 30
      AND NOT EXISTS(SELECT 1 FROM json_each(settings.value,'$.values') item
        WHERE item.type<>'text' OR length(item.value) NOT BETWEEN 1 AND 120
          OR item.value IS NOT trim(item.value,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
          OR instr(item.value,char(0))>0 OR item.value GLOB ('*['||char(1)||'-'||char(31)||char(127)||']*'))
      AND (SELECT count(DISTINCT item.value) FROM json_each(settings.value,'$.values') item)=json_array_length(settings.value,'$.values')
    ELSE 0 END
  ELSE 0 END;
CREATE TRIGGER IF NOT EXISTS deployment_environment_setting_insert AFTER INSERT ON system_settings
WHEN NEW.key='deployment_environments' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM livo_deployment_environment_settings_valid WHERE workspace_id=NEW.workspace_id)
    THEN RAISE(ABORT,'invalid_deployment_environments') END;
END;
CREATE TRIGGER IF NOT EXISTS deployment_environment_setting_update AFTER UPDATE ON system_settings
WHEN NEW.key='deployment_environments' OR OLD.key='deployment_environments' BEGIN
  SELECT CASE WHEN OLD.key='deployment_environments' AND
    (NEW.key IS NOT OLD.key OR NEW.workspace_id IS NOT OLD.workspace_id)
    THEN RAISE(ABORT,'deployment_environment_setting_key_immutable') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM livo_deployment_environment_settings_valid WHERE workspace_id=NEW.workspace_id)
    THEN RAISE(ABORT,'invalid_deployment_environments') END;
END;

CREATE TRIGGER IF NOT EXISTS task_deployment_environment_insert BEFORE INSERT ON task_deployments BEGIN
  SELECT CASE WHEN NOT COALESCE((EXISTS(SELECT 1 FROM livo_deployment_environment_settings_valid settings,
      json_each(CASE WHEN json_valid(settings.value) THEN settings.value ELSE '{}' END,'$.values') choice
      WHERE settings.workspace_id=NEW.workspace_id AND choice.value=NEW.environment)
    OR (NOT EXISTS(SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id AND key='deployment_environments')
      AND NEW.environment IN ('Dev','QA','Stage','Live Staging','Prod'))),0)
    THEN RAISE(ABORT,'deployment_environment_unavailable') END;
END;
CREATE TRIGGER IF NOT EXISTS task_deployment_environment_update BEFORE UPDATE ON task_deployments
WHEN NEW.environment IS NOT OLD.environment OR NEW.id IS NOT OLD.id
  OR NEW.task_id IS NOT OLD.task_id OR NEW.workspace_id IS NOT OLD.workspace_id BEGIN
  SELECT CASE WHEN NOT COALESCE((EXISTS(SELECT 1 FROM livo_deployment_environment_settings_valid settings,
      json_each(CASE WHEN json_valid(settings.value) THEN settings.value ELSE '{}' END,'$.values') choice
      WHERE settings.workspace_id=NEW.workspace_id AND choice.value=NEW.environment)
    OR (NOT EXISTS(SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id AND key='deployment_environments')
      AND NEW.environment IN ('Dev','QA','Stage','Live Staging','Prod'))),0)
    THEN RAISE(ABORT,'deployment_environment_unavailable') END;
END;

CREATE TABLE IF NOT EXISTS team_settings (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  key        TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '{}',    -- JSON
  updated_by TEXT REFERENCES members(id) ON DELETE SET NULL,
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (workspace_id, key)
);

-- ── Slack notify prefs / auto-report configs ────────────────────────────────

CREATE TABLE IF NOT EXISTS user_notification_preferences (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  user_id          TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  enabled          INTEGER NOT NULL DEFAULT 0,
  frequency        TEXT NOT NULL DEFAULT 'daily',
  weekday          INTEGER NOT NULL DEFAULT 1,
  hour             INTEGER NOT NULL DEFAULT 9,
  include_assigned INTEGER NOT NULL DEFAULT 1,
  include_review   INTEGER NOT NULL DEFAULT 1,
  last_sent_at     TEXT,
  -- Email 通知（指派/提及/到期）；既有 DB 需手動 ALTER（見 email_config 註解）
  email_notify_enabled INTEGER NOT NULL DEFAULT 1,
  email_notify_types   TEXT NOT NULL DEFAULT '["assigned","mentioned","due_soon"]',
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS user_report_configs (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id                TEXT PRIMARY KEY,       -- expression default in PG → generated in db.ts
  user_id           TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  report_type       TEXT NOT NULL DEFAULT 'daily',
  enabled           INTEGER NOT NULL DEFAULT 0,
  hour              INTEGER NOT NULL DEFAULT 17,
  minute            INTEGER NOT NULL DEFAULT 30,
  weekday           INTEGER NOT NULL DEFAULT 5,
  template_key      TEXT NOT NULL DEFAULT 'default_daily',
  custom_template   TEXT,
  scope             TEXT NOT NULL DEFAULT 'assigned_to_me',
  scope_project_ids TEXT,                   -- JSON array (was text[])
  send_target       TEXT NOT NULL DEFAULT 'dm',
  send_channel      TEXT,
  last_sent_at      TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, report_type)
);

-- ── Orders (server-only; never exposed via /api/query) ──────────────────────

CREATE TABLE IF NOT EXISTS orders (
  id                  TEXT PRIMARY KEY,     -- uuid generated in db.ts / payments.ts
  merchant_trade_no   TEXT NOT NULL UNIQUE,
  email               TEXT NOT NULL,
  plan_type           TEXT NOT NULL CHECK (plan_type IN ('standard','professional')),
  amount              INTEGER NOT NULL,
  payment_status      TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed')),
  license_key         TEXT,
  download_token      TEXT,
  download_expires_at TEXT,
  ecpay_trade_no      TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at             TEXT
);
CREATE INDEX IF NOT EXISTS orders_download_token_idx ON orders (download_token) WHERE download_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_merchant_trade_no_idx ON orders (merchant_trade_no);

-- Buyer「我已完成付款」reports for the manual rails (bank transfer / PayPal).
-- Server-only (never registered in tables.ts). Keyed by order so re-reports
-- refresh the row. Feeds the seller-notification email + one-click fulfill link.
CREATE TABLE IF NOT EXISTS order_payment_reports (
  order_no     TEXT PRIMARY KEY,   -- orders.merchant_trade_no
  last5        TEXT,               -- buyer-reported account last-5 digits / note
  reported_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  notified_at  TEXT                -- when the seller-notify email went out
);

-- ── Trial leads (14-day self-host trial funnel; server-only) ────────────────
-- Written by functions/trial.ts (create-trial). Not client-queryable (never
-- registered in tables.ts). One row per email; `key` is a real PRO license key
-- whose expiry is today+14d (same HMAC scheme as orders). reminded_at is set
-- when the "3 days left" reminder email has been sent (scheduled() cron).
CREATE TABLE IF NOT EXISTS trial_leads (
  email              TEXT PRIMARY KEY COLLATE NOCASE,
  key                TEXT NOT NULL,
  tier               TEXT NOT NULL DEFAULT 'professional',
  issued_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at         TEXT NOT NULL,
  team               TEXT,
  ip                 TEXT,
  reminded_at        TEXT,
  converted_order_id TEXT
);
-- Reminder cron scans by expiry among not-yet-reminded leads:
CREATE INDEX IF NOT EXISTS idx_trial_leads_expires ON trial_leads (expires_at);
-- Soft IP cap (recent issuances from one IP):
CREATE INDEX IF NOT EXISTS idx_trial_leads_ip ON trial_leads (ip, issued_at);

-- ── Custom fields ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS custom_fields (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  field_name    TEXT NOT NULL,
  field_type    TEXT NOT NULL CHECK (field_type IN ('text','textarea','number','select','date','boolean','user')),
  options       TEXT,                       -- JSON
  is_required   INTEGER NOT NULL DEFAULT 0,
  default_value TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_custom_fields_project_id ON custom_fields (project_id);

CREATE TABLE IF NOT EXISTS task_custom_field_values (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  field_id      TEXT NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value_text    TEXT,
  value_number  REAL,
  value_date    TEXT,
  value_boolean INTEGER,
  value_user_id TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (task_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_task_custom_field_values_task_id ON task_custom_field_values (task_id);
CREATE INDEX IF NOT EXISTS idx_task_custom_field_values_field_id ON task_custom_field_values (field_id);

-- ── Dependencies / templates ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS task_dependencies (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id                 TEXT PRIMARY KEY,      -- expression default in PG → generated in db.ts
  task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dependency_type    TEXT NOT NULL DEFAULT 'finish_to_start',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_task_id ON task_dependencies (task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends_on ON task_dependencies (depends_on_task_id);

CREATE TABLE IF NOT EXISTS task_templates (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id                       TEXT PRIMARY KEY,
  project_id               TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  description              TEXT NOT NULL DEFAULT '',
  default_priority         TEXT CHECK (default_priority IN ('highest','high','medium','low','lowest')),
  default_tag_ids          TEXT NOT NULL DEFAULT '[]',  -- JSON
  default_spec_background  TEXT NOT NULL DEFAULT '',
  default_spec_requirement TEXT NOT NULL DEFAULT '',
  default_spec_notes       TEXT NOT NULL DEFAULT '',
  created_by               TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  default_check_items      TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  default_todo_items       TEXT NOT NULL DEFAULT '[]'  -- JSON array of strings
);

-- ── Work reports / board prefs / transition rules ───────────────────────────

CREATE TABLE IF NOT EXISTS work_reports (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id           TEXT PRIMARY KEY,            -- uuid generated in db.ts
  user_id      TEXT NOT NULL,               -- no FK (PG had none after type fix)
  report_type  TEXT NOT NULL CHECK (report_type IN ('daily','weekly','monthly')),
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  is_edited    INTEGER NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_work_reports_user_type_period ON work_reports (user_id, report_type, period_start DESC);

CREATE TABLE IF NOT EXISTS user_board_prefs (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  user_id            TEXT PRIMARY KEY,
  card_fields        TEXT NOT NULL DEFAULT '{}',  -- JSON
  custom_card_fields TEXT NOT NULL DEFAULT '{}',  -- JSON
  subtask_mode       TEXT NOT NULL DEFAULT 'independent' CHECK (subtask_mode IN ('independent','nested')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS status_transition_rules (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id                 TEXT PRIMARY KEY,      -- expression default in PG → generated in db.ts
  target_status_id   TEXT NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
  required_status_id TEXT NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
  created_at         TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (target_status_id, required_status_id)
);

-- ── Approval workflow ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS approval_rules (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id          TEXT PRIMARY KEY,             -- uuid generated in db.ts
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global
  from_status TEXT NOT NULL,                -- stores status IDs in practice
  to_status   TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (project_id, from_status, to_status)
);
CREATE INDEX IF NOT EXISTS idx_approval_rules_project ON approval_rules (project_id);

CREATE TABLE IF NOT EXISTS approval_rule_steps (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id               TEXT PRIMARY KEY,        -- uuid generated in db.ts
  rule_id          TEXT NOT NULL REFERENCES approval_rules(id) ON DELETE CASCADE,
  step_order       INTEGER NOT NULL,
  approver_type    TEXT NOT NULL CHECK (approver_type IN ('role','user')),
  approver_role    TEXT,
  approver_user_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  allow_delegate   INTEGER NOT NULL DEFAULT 0,
  timeout_hours    INTEGER,
  timeout_action   TEXT CHECK (timeout_action IN ('remind','auto_approve','escalate')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (rule_id, step_order)
);
CREATE INDEX IF NOT EXISTS idx_approval_steps_rule ON approval_rule_steps (rule_id);

CREATE TABLE IF NOT EXISTS approval_requests (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id           TEXT PRIMARY KEY,            -- uuid generated in db.ts
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rule_id      TEXT REFERENCES approval_rules(id) ON DELETE CASCADE,  -- nullable
  requested_by TEXT NOT NULL,
  from_status  TEXT NOT NULL,
  to_status    TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','returned','cancelled')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests (task_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests (status);

CREATE TABLE IF NOT EXISTS approval_actions (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id         TEXT PRIMARY KEY,              -- uuid generated in db.ts
  request_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  action_by  TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('approve','reject','return')),
  comment    TEXT,
  acted_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_approval_actions_request ON approval_actions (request_id);

-- ── External integrations (bidirectional) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS external_account_bindings (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id               TEXT PRIMARY KEY,        -- uuid generated in db.ts
  member_id        TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  platform         TEXT NOT NULL CHECK (platform IN ('slack','teams','line')),
  platform_user_id TEXT NOT NULL,
  platform_team_id TEXT,
  display_name     TEXT,
  is_verified      INTEGER NOT NULL DEFAULT 0,
  bound_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_active_at   TEXT,
  UNIQUE (platform, platform_user_id, platform_team_id)
);
CREATE INDEX IF NOT EXISTS idx_external_bindings_member ON external_account_bindings (member_id);
CREATE INDEX IF NOT EXISTS idx_external_bindings_platform ON external_account_bindings (platform, platform_user_id);

CREATE TABLE IF NOT EXISTS external_action_logs (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id                  TEXT PRIMARY KEY,     -- uuid generated in db.ts
  member_id           TEXT NOT NULL,
  binding_id          TEXT REFERENCES external_account_bindings(id) ON DELETE SET NULL,
  platform            TEXT NOT NULL,
  action_type         TEXT NOT NULL CHECK (action_type IN ('approval_approve','approval_reject','approval_return','status_change','comment_add','task_view','task_assign','slash_command')),
  target_task_id      TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  action_payload      TEXT,                 -- JSON
  result_status       TEXT NOT NULL DEFAULT 'success' CHECK (result_status IN ('success','failed','denied','expired')),
  error_message       TEXT,
  platform_message_id TEXT,
  acted_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_external_actions_member ON external_action_logs (member_id);
CREATE INDEX IF NOT EXISTS idx_external_actions_date ON external_action_logs (acted_at);

CREATE TABLE IF NOT EXISTS slack_thread_mappings (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id                TEXT PRIMARY KEY,       -- uuid generated in db.ts
  slack_channel_id  TEXT NOT NULL,
  slack_thread_ts   TEXT NOT NULL,
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  notification_type TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (slack_channel_id, slack_thread_ts)
);
CREATE INDEX IF NOT EXISTS idx_slack_threads_task ON slack_thread_mappings (task_id);

-- Customer-bound Slack credentials (single row id='singleton'). Server-only:
-- NEVER registered in tables.ts, so the bot token can never be read via
-- /api/query. Set through the admin-gated /api/functions/slack-config endpoint
-- (which runs auth.test and stores the resolved team name for display). Lets a
-- self-host customer bind their OWN Slack workspace from the app UI without
-- editing env/secrets. resolveSlackToken() reads this first, else env.SLACK_BOT_TOKEN.
CREATE TABLE IF NOT EXISTS slack_config (
  id            TEXT PRIMARY KEY DEFAULT 'singleton',
  bot_token     TEXT,          -- xoxb-… ; server-only, never returned to clients
  team_name     TEXT,          -- from auth.test, shown to admin as 已連線: {team}
  configured_at TEXT,
  configured_by TEXT           -- member id who set it
);

CREATE TABLE IF NOT EXISTS interaction_tokens (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id          TEXT PRIMARY KEY,             -- uuid generated in db.ts
  token_hash  TEXT NOT NULL UNIQUE,
  action_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  platform    TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  is_used     INTEGER NOT NULL DEFAULT 0,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ── Report sending ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS report_send_targets (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id             TEXT PRIMARY KEY,          -- uuid generated in db.ts
  project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global
  report_type    TEXT NOT NULL CHECK (report_type IN ('daily','weekly','monthly')),
  channel_type   TEXT NOT NULL CHECK (channel_type IN ('slack','email','line','webhook')),
  channel_config TEXT NOT NULL,             -- JSON
  format         TEXT NOT NULL DEFAULT 'text' CHECK (format IN ('text','full','pdf')),
  is_enabled     INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_report_targets_project ON report_send_targets (project_id);
CREATE INDEX IF NOT EXISTS idx_report_targets_type ON report_send_targets (report_type);

CREATE TABLE IF NOT EXISTS report_send_logs (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id              TEXT PRIMARY KEY,         -- uuid generated in db.ts
  report_type     TEXT NOT NULL,
  target_id       TEXT REFERENCES report_send_targets(id) ON DELETE SET NULL,
  channel_type    TEXT NOT NULL,
  channel_target  TEXT NOT NULL,
  format          TEXT NOT NULL,
  content_preview TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
  error_message   TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  sent_by         TEXT NOT NULL,
  sent_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_report_logs_date ON report_send_logs (sent_at);

-- ── Smart notifications ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_templates (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id               TEXT PRIMARY KEY,        -- uuid generated in db.ts
  organization_id  TEXT,
  name             TEXT NOT NULL,
  event_type       TEXT NOT NULL CHECK (event_type IN ('task_created','status_changed','assignee_changed','due_reminder','overdue','approval_requested','approval_completed','comment_added','custom')),
  template_content TEXT NOT NULL DEFAULT '',
  tone             TEXT NOT NULL DEFAULT 'neutral' CHECK (tone IN ('neutral','celebration','urgent','warning','friendly')),
  is_default       INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Template names are unique PER WORKSPACE (the old global uq_…_name index is
-- dropped by migrate/tenant-alters.sql on pre-tenancy DBs).
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_templates_ws_name ON notification_templates (workspace_id, name);
CREATE INDEX IF NOT EXISTS idx_notification_templates_event ON notification_templates (event_type);

CREATE TABLE IF NOT EXISTS notification_rules (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id                      TEXT PRIMARY KEY, -- uuid generated in db.ts
  project_id              TEXT,             -- NULL = global; no FK (PG had none)
  event_type              TEXT NOT NULL CHECK (event_type IN ('task_created','status_changed','assignee_changed','due_reminder','overdue','approval_requested','approval_completed','comment_added','custom')),
  from_status             TEXT,
  to_status               TEXT,
  is_enabled              INTEGER NOT NULL DEFAULT 1,
  template_id             TEXT REFERENCES notification_templates(id) ON DELETE SET NULL,
  target_channels         TEXT NOT NULL DEFAULT '[]',  -- JSON
  priority_overrides      TEXT NOT NULL DEFAULT '{}',  -- JSON
  auto_send               INTEGER NOT NULL DEFAULT 0,
  auto_send_delay_seconds INTEGER NOT NULL DEFAULT 3,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notification_rules_event ON notification_rules (event_type);
CREATE INDEX IF NOT EXISTS idx_notification_rules_project ON notification_rules (project_id);

CREATE TABLE IF NOT EXISTS notification_delivery_logs (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id              TEXT PRIMARY KEY,         -- uuid generated in db.ts
  rule_id         TEXT REFERENCES notification_rules(id) ON DELETE SET NULL,
  task_id         TEXT,
  event_type      TEXT NOT NULL CHECK (event_type IN ('task_created','status_changed','assignee_changed','due_reminder','overdue','approval_requested','approval_completed','comment_added','custom')),
  triggered_by    TEXT,
  message_content TEXT NOT NULL DEFAULT '',
  was_customized  INTEGER NOT NULL DEFAULT 0,
  channel_type    TEXT NOT NULL DEFAULT '',
  channel_target  TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','skipped')),
  error_message   TEXT,
  sent_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_task ON notification_delivery_logs (task_id);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_sent_at ON notification_delivery_logs (sent_at DESC);

CREATE TABLE IF NOT EXISTS due_date_reminders (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id            TEXT PRIMARY KEY,           -- uuid generated in db.ts
  task_id       TEXT NOT NULL,
  remind_at     TEXT NOT NULL,
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('before_1day','due_day','overdue')),
  is_sent       INTEGER NOT NULL DEFAULT 0,
  sent_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_due_reminders_remind_at ON due_date_reminders (remind_at) WHERE is_sent = 0;
CREATE INDEX IF NOT EXISTS idx_due_reminders_task ON due_date_reminders (task_id);

-- ── Standup ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS standup_sessions (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id                     TEXT PRIMARY KEY,  -- uuid generated in db.ts
  created_by             TEXT NOT NULL,
  started_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at               TEXT,
  sprint_id              TEXT,              -- no FK (PG had none)
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  default_speak_duration INTEGER NOT NULL DEFAULT 120,
  sort_mode              TEXT NOT NULL DEFAULT 'by_member' CHECK (sort_mode IN ('by_member','by_project','by_due_date','by_department')),
  auto_advance           INTEGER NOT NULL DEFAULT 1,
  buffer_seconds         INTEGER NOT NULL DEFAULT 15
);

CREATE TABLE IF NOT EXISTS standup_member_durations (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id                 TEXT PRIMARY KEY,      -- uuid generated in db.ts
  standup_session_id TEXT NOT NULL REFERENCES standup_sessions(id) ON DELETE CASCADE,
  member_id          TEXT NOT NULL,
  speak_duration     INTEGER NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (standup_session_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_standup_member_durations_session ON standup_member_durations (standup_session_id);

-- ── 時間追蹤（time tracking）────────────────────────────────────────────────
-- 進行中的計時 = started_at 有值且 ended_at IS NULL 的 entry（minutes 0）；
-- 停止時前端結算 minutes 並補 ended_at。手動補登直接寫 minutes + entry_date。
CREATE TABLE IF NOT EXISTS time_entries (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id         TEXT PRIMARY KEY,              -- uuid generated in db.ts
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  minutes    INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  entry_date TEXT NOT NULL,                 -- YYYY-MM-DD（工時歸屬日）
  started_at TEXT,                          -- 計時器起點（ISO）
  ended_at   TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_time_entries_task ON time_entries (task_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_member_date ON time_entries (member_id, entry_date);

-- ── Email 通知設定（客戶自綁 Resend，slack_config 同款 server-only）────────
-- NEVER registered in tables.ts；經 admin-gated /api/functions/email-config
-- 設定（驗證 key 後儲存）。resolveEmailConfig() 先讀這裡，否則退回
-- env.RESEND_API_KEY（雲端實例）。
-- NOTE: 既有 prod D1 需一次性 ALTER 加 user_notification_preferences 欄位：
--   ALTER TABLE user_notification_preferences ADD COLUMN email_notify_enabled INTEGER NOT NULL DEFAULT 1;
--   ALTER TABLE user_notification_preferences ADD COLUMN email_notify_types TEXT NOT NULL DEFAULT '["assigned","mentioned","due_soon"]';
CREATE TABLE IF NOT EXISTS email_config (
  id            TEXT PRIMARY KEY DEFAULT 'singleton',
  api_key       TEXT,          -- Resend API key; server-only, never returned
  from_address  TEXT,          -- 寄件人（客戶自己已驗證的網域）
  configured_at TEXT,
  configured_by TEXT
);

-- ── API tokens（PAT；server-only，經 /api/functions/api-tokens 管理）────────
-- token 明文只在建立當下回傳一次；儲存 sha256。requireMember 接受
-- Authorization: Bearer livo_pat_… 並以 member_id 的身分行事（含權限層）。
CREATE TABLE IF NOT EXISTS api_tokens (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT,
  revoked_at   TEXT
);

-- ── Webhooks（server-only：secret 不可外洩；經 /api/functions/webhooks 管理）─
-- 事件由 worker 端派送（db.ts 變更事件 → dispatchWebhooks），HMAC-SHA256 簽名
-- 放 X-Livo-Signature。events 是 JSON 陣列。
CREATE TABLE IF NOT EXISTS webhook_configs (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id           TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  events       TEXT NOT NULL DEFAULT '["task_created","task_updated","task_deleted","comment_added"]',
  secret       TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_status  TEXT,
  last_sent_at TEXT
);

-- ── Cloud beta tenancy plane（server-only；見 CLOUD-BETA-DESIGN.md）──────────
-- workspaces：每個雲端 Beta 租戶一列。workspace 'default' 沒有列（= 舊有資料／
-- 自架安裝／公開 demo，額度不受限）。cloud_waitlist：官網排隊名單（email PK）。
CREATE TABLE IF NOT EXISTS workspaces (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  plan               TEXT NOT NULL DEFAULT 'beta',
  member_limit       INTEGER NOT NULL DEFAULT 10,
  storage_limit_mb   INTEGER NOT NULL DEFAULT 500,
  storage_used_bytes INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  owner_email        TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- QA is an opt-in domain. All writes go through qa.ts, never /api/query.
CREATE TABLE IF NOT EXISTS qa_issues (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, project_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('new','triaged','in_progress','verification','verified','failed','closed','dismissed')),
  assignee_id TEXT, qa_owner_id TEXT, reporter_id TEXT NOT NULL, title TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0), updated_at TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)), PRIMARY KEY(workspace_id,id),
  CHECK (json_extract(data,'$.id') = id AND json_extract(data,'$.workspaceId') = workspace_id
    AND json_extract(data,'$.projectId') = project_id AND json_extract(data,'$.version') = version
    AND json_extract(data,'$.state') = state)
);
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
CREATE TABLE IF NOT EXISTS qa_commands (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, issue_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, actor_role TEXT NOT NULL, expected_version INTEGER NOT NULL,
  operation TEXT NOT NULL, request_hash TEXT NOT NULL, issue_data TEXT NOT NULL CHECK(json_valid(issue_data)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL, restored_by TEXT,
  PRIMARY KEY(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS idx_qa_commands_issue ON qa_commands(workspace_id,issue_id,created_at);
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
-- Commands validate the current workspace catalog in the same D1 batch as
-- the issue write. Restored history is deliberately outside this constraint.
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
CREATE TABLE IF NOT EXISTS qa_restore_batches (
  workspace_id TEXT NOT NULL,id TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
);
CREATE TRIGGER IF NOT EXISTS qa_restore_guard BEFORE INSERT ON qa_restore_batches BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.actor_id
    AND role='super_admin' AND is_active=1) THEN RAISE(ABORT,'qa_forbidden') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id
    AND key='feature_toggles' AND json_extract(value,'$.qa')=1) THEN RAISE(ABORT,'qa_disabled') END;
END;
CREATE TABLE IF NOT EXISTS qa_comments (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, issue_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  body TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,issue_id) REFERENCES qa_issues(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS idx_qa_comments_issue ON qa_comments(workspace_id,issue_id,created_at);
CREATE TABLE IF NOT EXISTS qa_events (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, issue_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  type TEXT NOT NULL, detail TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,issue_id) REFERENCES qa_issues(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS idx_qa_events_issue ON qa_events(workspace_id,issue_id,version,created_at);
CREATE TABLE IF NOT EXISTS qa_upload_sessions (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, issue_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  file_name TEXT NOT NULL, mime_type TEXT NOT NULL, expected_size INTEGER NOT NULL CHECK(expected_size>0 AND expected_size<=209715200),
  storage_key TEXT NOT NULL, multipart_id TEXT, state TEXT NOT NULL DEFAULT 'initializing'
    CHECK(state IN ('initializing','uploading','finalizing','aborting','complete','aborted')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,issue_id) REFERENCES qa_issues(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS idx_qa_uploads_expiry ON qa_upload_sessions(workspace_id,state,expires_at);
CREATE TRIGGER IF NOT EXISTS qa_upload_reserve_guard BEFORE INSERT ON qa_upload_sessions BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id
    AND key='feature_toggles' AND json_extract(value,'$.qa')=1) THEN RAISE(ABORT,'qa_disabled') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.actor_id AND is_active=1)
    THEN RAISE(ABORT,'qa_forbidden') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM workspaces WHERE id=NEW.workspace_id AND
    storage_used_bytes + NEW.expected_size + COALESCE((SELECT SUM(expected_size) FROM qa_upload_sessions
      WHERE workspace_id=NEW.workspace_id AND state IN ('initializing','uploading','finalizing','aborting')),0)
      > storage_limit_mb*1048576) THEN RAISE(ABORT,'qa_storage_quota') END;
END;
CREATE TABLE IF NOT EXISTS qa_upload_parts (
  workspace_id TEXT NOT NULL, upload_id TEXT NOT NULL, part_number INTEGER NOT NULL,
  size INTEGER NOT NULL, digest TEXT NOT NULL, etag TEXT, lease_token TEXT NOT NULL, claimed_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,upload_id,part_number),
  FOREIGN KEY(workspace_id,upload_id) REFERENCES qa_upload_sessions(workspace_id,id)
);
CREATE TRIGGER IF NOT EXISTS qa_upload_part_guard BEFORE INSERT ON qa_upload_parts BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id
    AND key='feature_toggles' AND json_extract(value,'$.qa')=1) THEN RAISE(ABORT,'qa_disabled') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM qa_upload_sessions s JOIN members m
    ON m.workspace_id=s.workspace_id AND m.id=s.actor_id AND m.is_active=1
    WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.upload_id AND s.state='uploading') THEN RAISE(ABORT,'qa_upload_conflict') END;
END;
CREATE TABLE IF NOT EXISTS qa_attachments (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, issue_id TEXT NOT NULL, uploaded_by TEXT NOT NULL,
  file_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL, restored_by TEXT, PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,issue_id) REFERENCES qa_issues(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS idx_qa_attachments_issue ON qa_attachments(workspace_id,issue_id,created_at);
CREATE TRIGGER IF NOT EXISTS qa_attachment_finalize_guard BEFORE INSERT ON qa_attachments WHEN NEW.restored_by IS NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id
    AND key='feature_toggles' AND json_extract(value,'$.qa')=1) THEN RAISE(ABORT,'qa_disabled') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.uploaded_by AND is_active=1)
    THEN RAISE(ABORT,'qa_forbidden') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM qa_upload_sessions WHERE workspace_id=NEW.workspace_id AND id=NEW.id
    AND issue_id=NEW.issue_id AND actor_id=NEW.uploaded_by AND expected_size=NEW.size AND storage_key=NEW.storage_key
    AND state='finalizing') THEN RAISE(ABORT,'qa_upload_conflict') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM workspaces WHERE id=NEW.workspace_id
    AND storage_used_bytes+NEW.size>storage_limit_mb*1048576) THEN RAISE(ABORT,'qa_storage_quota') END;
END;
CREATE TRIGGER IF NOT EXISTS qa_attachment_finalize AFTER INSERT ON qa_attachments WHEN NEW.restored_by IS NULL BEGIN
  UPDATE workspaces SET storage_used_bytes=storage_used_bytes+NEW.size WHERE id=NEW.workspace_id;
  UPDATE qa_upload_sessions SET state='complete' WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS qa_restored_attachment_guard BEFORE INSERT ON qa_attachments WHEN NEW.restored_by IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.restored_by
    AND role='super_admin' AND is_active=1) THEN RAISE(ABORT,'qa_forbidden') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM system_settings WHERE workspace_id=NEW.workspace_id
    AND key='feature_toggles' AND json_extract(value,'$.qa')=1) THEN RAISE(ABORT,'qa_disabled') END;
END;
CREATE TABLE IF NOT EXISTS qa_slack_links (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'default', issue_id TEXT NOT NULL,
  team_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL, card_ts TEXT,
  created_at TEXT NOT NULL, UNIQUE(workspace_id,team_id,channel_id,thread_ts),
  FOREIGN KEY(workspace_id,issue_id) REFERENCES qa_issues(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS qa_slack_receipts (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS qa_slack_inbox (
  workspace_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, lease_until TEXT,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS idx_qa_slack_inbox_pending ON qa_slack_inbox(workspace_id,state,next_attempt_at,lease_until);

CREATE TABLE IF NOT EXISTS cloud_waitlist (
  email               TEXT PRIMARY KEY COLLATE NOCASE,
  name                TEXT,
  team_size           TEXT,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','invited','joined')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  invited_at          TEXT,
  joined_workspace_id TEXT,
  ip                  TEXT
);
CREATE INDEX IF NOT EXISTS idx_cloud_waitlist_ip ON cloud_waitlist (ip, created_at);

-- Per-workspace hot-path indexes（tenancy filter 注入後的查詢路徑）
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_comments_workspace ON comments (workspace_id);
CREATE INDEX IF NOT EXISTS idx_notifications_workspace ON notifications (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_workspace ON activity_logs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_status_logs_workspace ON status_logs (workspace_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_workspace ON time_entries (workspace_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_members_workspace ON members (workspace_id);

-- Feature switches: preserve legacy teams and keep fresh workspaces opt-in.
INSERT OR IGNORE INTO system_settings (workspace_id, key, value)
SELECT ws, 'feature_toggles', json_object('approvals', json(CASE WHEN
  EXISTS (SELECT 1 FROM approval_rules WHERE workspace_id = ws) OR
  EXISTS (SELECT 1 FROM approval_requests WHERE workspace_id = ws)
  THEN 'true' ELSE 'false' END))
FROM (SELECT 'default' AS ws UNION SELECT id FROM workspaces
  UNION SELECT workspace_id FROM approval_rules UNION SELECT workspace_id FROM approval_requests);

CREATE TRIGGER IF NOT EXISTS feature_toggles_no_pending_insert
BEFORE INSERT ON system_settings
WHEN NEW.key = 'feature_toggles' AND json_type(NEW.value, '$.approvals') = 'false'
BEGIN
  SELECT RAISE(ABORT, 'Withdraw pending approvals before disabling')
  WHERE EXISTS (SELECT 1 FROM approval_requests WHERE workspace_id = NEW.workspace_id AND status = 'pending')
     OR EXISTS (SELECT 1 FROM tasks WHERE workspace_id = NEW.workspace_id
       AND (approval_status = 'pending_approval' OR current_approval_id IS NOT NULL));
END;
CREATE TRIGGER IF NOT EXISTS feature_toggles_no_pending_update
BEFORE UPDATE ON system_settings
WHEN NEW.key = 'feature_toggles' AND json_type(NEW.value, '$.approvals') = 'false'
BEGIN
  SELECT RAISE(ABORT, 'Withdraw pending approvals before disabling')
  WHERE EXISTS (SELECT 1 FROM approval_requests WHERE workspace_id = NEW.workspace_id AND status = 'pending')
     OR EXISTS (SELECT 1 FROM tasks WHERE workspace_id = NEW.workspace_id
       AND (approval_status = 'pending_approval' OR current_approval_id IS NOT NULL));
END;

CREATE TRIGGER IF NOT EXISTS approval_withdraw_clears_task
AFTER UPDATE OF status ON approval_requests
WHEN OLD.status = 'pending' AND NEW.status = 'cancelled'
BEGIN
  UPDATE tasks SET approval_status = NULL, current_approval_id = NULL
  WHERE workspace_id = NEW.workspace_id AND id = NEW.task_id AND current_approval_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS approval_request_enabled_insert
BEFORE INSERT ON approval_requests WHEN NEW.status = 'pending'
BEGIN
  SELECT RAISE(ABORT, 'Approval workflow is disabled') WHERE NOT COALESCE(
    (SELECT CASE WHEN json_type(value, '$.approvals') IN ('true','false')
      THEN json_extract(value, '$.approvals') END FROM system_settings
     WHERE workspace_id = NEW.workspace_id AND key = 'feature_toggles'),
    EXISTS (SELECT 1 FROM approval_rules WHERE workspace_id = NEW.workspace_id) OR
    EXISTS (SELECT 1 FROM approval_requests WHERE workspace_id = NEW.workspace_id)
  );
END;
CREATE TRIGGER IF NOT EXISTS approval_task_pending_insert
BEFORE INSERT ON tasks WHEN NEW.approval_status = 'pending_approval'
BEGIN
  SELECT RAISE(ABORT, 'Approval request is no longer pending')
  WHERE NOT COALESCE(
    (SELECT CASE WHEN json_type(value, '$.approvals') IN ('true','false')
      THEN json_extract(value, '$.approvals') END FROM system_settings
     WHERE workspace_id = NEW.workspace_id AND key = 'feature_toggles'),
    EXISTS (SELECT 1 FROM approval_rules WHERE workspace_id = NEW.workspace_id) OR
    EXISTS (SELECT 1 FROM approval_requests WHERE workspace_id = NEW.workspace_id)
  ) OR NOT EXISTS (
    SELECT 1 FROM approval_requests WHERE workspace_id = NEW.workspace_id
      AND id = NEW.current_approval_id AND task_id = NEW.id AND status = 'pending');
END;

CREATE TRIGGER IF NOT EXISTS approval_request_enabled_update
BEFORE UPDATE ON approval_requests WHEN NEW.status = 'pending'
BEGIN
  SELECT RAISE(ABORT, 'Approval workflow is disabled') WHERE NOT COALESCE(
    (SELECT CASE WHEN json_type(value, '$.approvals') IN ('true','false')
      THEN json_extract(value, '$.approvals') END FROM system_settings
     WHERE workspace_id = NEW.workspace_id AND key = 'feature_toggles'),
    EXISTS (SELECT 1 FROM approval_rules WHERE workspace_id = NEW.workspace_id) OR
    EXISTS (SELECT 1 FROM approval_requests WHERE workspace_id = NEW.workspace_id)
  );
END;
CREATE TRIGGER IF NOT EXISTS approval_task_pending_update
BEFORE UPDATE OF approval_status, current_approval_id ON tasks WHEN NEW.approval_status = 'pending_approval'
BEGIN
  SELECT RAISE(ABORT, 'Approval request is no longer pending')
  WHERE NOT COALESCE(
    (SELECT CASE WHEN json_type(value, '$.approvals') IN ('true','false')
      THEN json_extract(value, '$.approvals') END FROM system_settings
     WHERE workspace_id = NEW.workspace_id AND key = 'feature_toggles'),
    EXISTS (SELECT 1 FROM approval_rules WHERE workspace_id = NEW.workspace_id) OR
    EXISTS (SELECT 1 FROM approval_requests WHERE workspace_id = NEW.workspace_id)
  ) OR NOT EXISTS (
    SELECT 1 FROM approval_requests WHERE workspace_id = NEW.workspace_id
      AND id = NEW.current_approval_id AND task_id = NEW.id AND status = 'pending');
END;

CREATE TRIGGER IF NOT EXISTS approval_notification_enabled
BEFORE INSERT ON notifications WHEN substr(NEW.type, 1, 9) = 'approval_'
BEGIN
  SELECT RAISE(IGNORE) WHERE NOT COALESCE(
    (SELECT CASE WHEN json_type(value, '$.approvals') IN ('true','false')
      THEN json_extract(value, '$.approvals') END FROM system_settings
     WHERE workspace_id = NEW.workspace_id AND key = 'feature_toggles'),
    EXISTS (SELECT 1 FROM approval_rules WHERE workspace_id = NEW.workspace_id) OR
    EXISTS (SELECT 1 FROM approval_requests WHERE workspace_id = NEW.workspace_id)
  );
END;

CREATE TABLE IF NOT EXISTS kb_navigation_preferences (workspace_id TEXT NOT NULL DEFAULT 'default',member_id TEXT NOT NULL,preferences TEXT NOT NULL DEFAULT '{"items":{},"orders":{},"pins":[]}',version INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(workspace_id,member_id));

-- Canonical fragment merged into worker/schema.sql by the integration task.
CREATE TABLE IF NOT EXISTS kb_source_snapshots (
  workspace_id TEXT NOT NULL DEFAULT 'default', id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES kb_pages(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL, source_title TEXT NOT NULL, source_url TEXT, source_key TEXT, source_version TEXT,
  body TEXT NOT NULL, body_hash TEXT NOT NULL, page_version INTEGER NOT NULL, provenance TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kb_snapshot_page ON kb_source_snapshots(workspace_id,page_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS kb_snapshot_identity ON kb_source_snapshots(workspace_id,page_id,body_hash,source_kind,COALESCE(source_key,''));
CREATE TRIGGER IF NOT EXISTS kb_snapshot_immutable BEFORE UPDATE ON kb_source_snapshots BEGIN SELECT RAISE(ABORT,'kb_workflow_immutable'); END;
CREATE TABLE IF NOT EXISTS kb_checklist_items (
  workspace_id TEXT NOT NULL DEFAULT 'default', id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES kb_pages(id) ON DELETE CASCADE,
  anchor_id TEXT NOT NULL, text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 2000), is_done INTEGER NOT NULL DEFAULT 0 CHECK(is_done IN(0,1)),
  version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  completed_by TEXT, completed_at TEXT, UNIQUE(workspace_id,page_id,anchor_id)
);
CREATE TABLE IF NOT EXISTS kb_work_links (
  workspace_id TEXT NOT NULL DEFAULT 'default', id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES kb_pages(id) ON DELETE CASCADE,
  anchor_id TEXT NOT NULL, checklist_id TEXT REFERENCES kb_checklist_items(id) ON DELETE RESTRICT,
  snapshot_id TEXT REFERENCES kb_source_snapshots(id) ON DELETE RESTRICT,
  target_kind TEXT NOT NULL CHECK(target_kind IN('task','qa')), target_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN('reference','meeting','decision','verification')), created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(workspace_id,page_id,anchor_id,target_kind,target_id), UNIQUE(workspace_id,checklist_id)
);
CREATE INDEX IF NOT EXISTS kb_link_target ON kb_work_links(workspace_id,target_kind,target_id);
CREATE INDEX IF NOT EXISTS kb_link_page ON kb_work_links(workspace_id,page_id);
CREATE TABLE IF NOT EXISTS kb_workflow_commands (
  workspace_id TEXT NOT NULL DEFAULT 'default', id TEXT NOT NULL, actor_id TEXT NOT NULL, page_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, result_json TEXT NOT NULL, allowed INTEGER NOT NULL CHECK(allowed=1), created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
);
-- Preserve existing keys; reject only new collisions, including legacy clients.
CREATE TRIGGER IF NOT EXISTS kb_task_key_insert BEFORE INSERT ON tasks WHEN EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND task_key=NEW.task_key)
BEGIN SELECT RAISE(ABORT,'kb_workflow_task_key_conflict'); END;
CREATE TRIGGER IF NOT EXISTS kb_task_key_update BEFORE UPDATE OF task_key ON tasks WHEN OLD.task_key<>NEW.task_key AND EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND task_key=NEW.task_key AND id<>NEW.id)
BEGIN SELECT RAISE(ABORT,'kb_workflow_task_key_conflict'); END;

-- Merge verbatim into schema.sql. Every table is server-only (clientAccess:'none').
CREATE TABLE IF NOT EXISTS knowledge_import_policy (
  workspace_id TEXT PRIMARY KEY DEFAULT 'default',version INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL CHECK(json_valid(data)),updated_by TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_import_jobs (
  id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL DEFAULT 'default',actor_id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),expires_at TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_actor ON knowledge_import_jobs(workspace_id,actor_id,created_at DESC);
CREATE TABLE IF NOT EXISTS knowledge_import_sources (
  id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL DEFAULT 'default',page_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,job_id TEXT NOT NULL,item_id TEXT NOT NULL,
  source_key TEXT NOT NULL,source_hash TEXT NOT NULL,version INTEGER NOT NULL,original TEXT NOT NULL CHECK(json_valid(original)),assets TEXT NOT NULL CHECK(json_valid(assets)),created_by TEXT NOT NULL,created_at TEXT NOT NULL,
  UNIQUE(workspace_id,job_id,item_id),FOREIGN KEY(workspace_id,page_id) REFERENCES kb_pages(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(snapshot_id) REFERENCES kb_source_snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_import_sources_page ON knowledge_import_sources(workspace_id,page_id,source_key,version DESC);

-- Reservations count toward the same workspace usage as normal and QA uploads.
-- Server-only ledger: no client query access and no actor-dependent cleanup.
CREATE TABLE IF NOT EXISTS knowledge_import_files (
  workspace_id TEXT NOT NULL, file_key TEXT NOT NULL, job_id TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes>=0), content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('writing','stored','deleting')),
  operation_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,file_key)
);
CREATE INDEX IF NOT EXISTS idx_import_files_job ON knowledge_import_files(workspace_id,job_id);
CREATE TRIGGER IF NOT EXISTS knowledge_import_files_quota BEFORE INSERT ON knowledge_import_files
WHEN NEW.state='writing' AND NEW.workspace_id!='default'
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM workspaces w WHERE w.id=NEW.workspace_id
    AND w.storage_used_bytes+NEW.bytes+COALESCE((SELECT SUM(expected_size) FROM qa_upload_sessions
      WHERE workspace_id=NEW.workspace_id AND state IN ('initializing','uploading','finalizing','aborting')),0)>w.storage_limit_mb*1048576)
    THEN RAISE(ABORT,'storage_quota_exceeded') END;
END;
CREATE TRIGGER IF NOT EXISTS knowledge_import_files_reserved AFTER INSERT ON knowledge_import_files
BEGIN
  UPDATE workspaces SET storage_used_bytes=storage_used_bytes+NEW.bytes WHERE id=NEW.workspace_id;
END;
CREATE TRIGGER IF NOT EXISTS knowledge_import_files_released AFTER DELETE ON knowledge_import_files
BEGIN
  UPDATE workspaces SET storage_used_bytes=MAX(0,storage_used_bytes-OLD.bytes) WHERE id=OLD.workspace_id;
END;
CREATE TRIGGER IF NOT EXISTS knowledge_import_files_immutable BEFORE UPDATE OF workspace_id,file_key,job_id,bytes,content_hash ON knowledge_import_files
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.file_key IS NOT OLD.file_key OR NEW.job_id IS NOT OLD.job_id
  OR NEW.bytes IS NOT OLD.bytes OR (NEW.content_hash IS NOT OLD.content_hash AND OLD.content_hash!='legacy')
BEGIN SELECT RAISE(ABORT,'storage_identity_immutable'); END;

-- Admission remains closed until historic, unmetered import objects are counted.
CREATE TABLE IF NOT EXISTS knowledge_import_usage_reconciliations (
  workspace_id TEXT PRIMARY KEY, cursor TEXT, version INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)), updated_at TEXT NOT NULL
);

-- System-only retention cursor; contains no member identity or document content.
CREATE TABLE IF NOT EXISTS knowledge_import_maintenance_state (
  id TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_expiry ON knowledge_import_jobs(expires_at,workspace_id,id);
