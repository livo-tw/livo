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
  private_draft_owner_id TEXT,
  document_metadata TEXT NOT NULL DEFAULT '{"documentKind":null,"ownerId":null,"applicability":{"productVersion":null,"environment":null,"summary":null}}',
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
  title TEXT NOT NULL DEFAULT '',
  document_metadata TEXT NOT NULL DEFAULT '{"documentKind":null,"ownerId":null,"applicability":{"productVersion":null,"environment":null,"summary":null}}',
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
-- Keys: pair:<email>|<source> (locks one email from one source), ip:<source>,
-- email:<email> (short pause only, never a lockout). See loginThrottle.ts.
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
  expires_at TEXT NOT NULL,
  -- Added after release: existing D1 databases get them from apply-tenant-alters.mjs.
  pair_key TEXT,
  pair_window TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_login_reservations_email ON auth_login_reservations(email_key,email_window,expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_login_reservations_ip ON auth_login_reservations(ip_key,ip_window,expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_login_reservations_pair ON auth_login_reservations(pair_key,pair_window,expires_at);
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

-- A product line cannot be deleted while it still has projects (archived ones
-- included): the line_id foreign key cascades, so deleting the line would delete
-- those projects and every task in them. The app checks first; this refuses too,
-- also when the caller cannot see every project.
CREATE TRIGGER IF NOT EXISTS product_lines_keep_projects BEFORE DELETE ON product_lines
WHEN EXISTS (SELECT 1 FROM projects WHERE workspace_id = OLD.workspace_id AND line_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'product_line_has_projects');
END;

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
  assignee_revision INTEGER NOT NULL DEFAULT 0 CHECK(assignee_revision>=0),
  reviewer_revision INTEGER NOT NULL DEFAULT 0 CHECK(reviewer_revision>=0),
  assignee_acknowledged_at TEXT,
  reviewer_acknowledged_at TEXT,
  reviewer_id         TEXT REFERENCES members(id),
  due_date            TEXT,
  due_date_kind TEXT CHECK(due_date_kind IS NULL OR due_date_kind IN ('estimated','committed')),
  due_date_version INTEGER NOT NULL DEFAULT 0 CHECK(due_date_version>=0),
  due_date_change_reason TEXT,
  due_date_changed_by TEXT,
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
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
);
CREATE INDEX IF NOT EXISTS idx_task_checks_task ON task_checks (task_id);

CREATE TABLE IF NOT EXISTS task_todos (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  is_done    INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
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
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- rules are per project; NULL rows are never matched
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
  completed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  steps_snapshot TEXT,
  rule_snapshot TEXT
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
  acted_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  command_id TEXT,
  request_version INTEGER
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
  verified_by      TEXT CHECK(verified_by IS NULL OR verified_by IN ('email','admin')),
  bound_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_active_at   TEXT,
  UNIQUE (platform, platform_user_id, platform_team_id)
);
CREATE INDEX IF NOT EXISTS idx_external_bindings_member ON external_account_bindings (member_id);
CREATE INDEX IF NOT EXISTS idx_external_bindings_platform ON external_account_bindings (platform, platform_user_id);

-- A member who turned Slack linking off in My settings: LIVO neither acts for their
-- Slack account nor sends it direct messages until they allow it again. Written only
-- by the livo_slack_link_set RPC for the caller (supabase/migrations/20261022_slack_link_preferences.sql).
CREATE TABLE IF NOT EXISTS slack_link_preferences (
  workspace_id     TEXT NOT NULL DEFAULT 'default',
  member_id        TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  linking_disabled INTEGER NOT NULL DEFAULT 0 CHECK (linking_disabled IN (0,1)),
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, member_id)
);

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
  actor_id TEXT NOT NULL, actor_role TEXT NOT NULL,
  actor_auth_id TEXT, expected_version INTEGER NOT NULL,
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

-- Atomic approval commands. Only the verified server adapter can insert contexts;
-- /api/query never exposes contexts, receipts, or delivery jobs. Context authority
-- lasts for one INSERT statement: its AFTER trigger deletes it before committing.
CREATE UNIQUE INDEX IF NOT EXISTS approval_one_pending_task ON approval_requests(workspace_id,task_id) WHERE status='pending';
CREATE UNIQUE INDEX IF NOT EXISTS approval_action_command ON approval_actions(workspace_id,command_id) WHERE command_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS approval_command_contexts (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, actor_id TEXT NOT NULL,
  task_id TEXT NOT NULL, request_id TEXT, operation TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)), payload_hash TEXT NOT NULL,
  event_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS approval_command_receipts (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, actor_id TEXT NOT NULL,
  task_id TEXT NOT NULL, request_id TEXT, payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS approval_events (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL,
  request_id TEXT, actor_id TEXT NOT NULL, command_id TEXT NOT NULL,
  operation TEXT NOT NULL, request_version INTEGER, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,command_id)
);
CREATE TABLE IF NOT EXISTS approval_delivery_outbox (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL,
  request_id TEXT, event_id TEXT NOT NULL, recipient_id TEXT, team_id TEXT NOT NULL, target_id TEXT NOT NULL,
  delivery_type TEXT NOT NULL CHECK(delivery_type IN ('channel','dm')),
  operation TEXT NOT NULL, request_version INTEGER,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','skipped','failed','review')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
  lease_token TEXT, lease_expires_at TEXT, delivered_ts TEXT,
  last_error TEXT, created_at TEXT NOT NULL, delivered_at TEXT,
  PRIMARY KEY(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS approval_delivery_due ON approval_delivery_outbox(state,next_attempt_at);
CREATE TABLE IF NOT EXISTS approval_delivery_threads (
  workspace_id TEXT NOT NULL, team_id TEXT NOT NULL, task_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,team_id,task_id,channel_id)
);

-- Dropped and recreated on every run so existing databases receive policy changes.
DROP TRIGGER IF EXISTS approval_command_validate;
CREATE TRIGGER IF NOT EXISTS approval_command_validate BEFORE INSERT ON approval_command_contexts
BEGIN
  SELECT RAISE(ABORT,'approval_invalid_input') WHERE NEW.operation NOT IN ('submit','approve','reject','return','withdraw','set_requirement')
    OR length(NEW.id) NOT BETWEEN 8 AND 200 OR json_extract(NEW.payload,'$.commandId') IS NOT NEW.id
    OR json_extract(NEW.payload,'$.operation') IS NOT NEW.operation;
  SELECT RAISE(ABORT,'approval_forbidden') WHERE NOT EXISTS(
    SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.actor_id AND is_active=1);
  SELECT RAISE(ABORT,'approval_unavailable') WHERE NOT EXISTS(
    SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id
    WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND (p.is_archived=0 OR NEW.operation='withdraw'));
  SELECT RAISE(ABORT,'approval_idempotency_conflict') WHERE EXISTS(
    SELECT 1 FROM approval_command_receipts WHERE workspace_id=NEW.workspace_id AND id=NEW.id);
  SELECT RAISE(ABORT,'approval_disabled') WHERE NEW.operation NOT IN ('withdraw','set_requirement') AND NOT COALESCE(
    (SELECT CASE WHEN json_type(value,'$.approvals') IN ('true','false') THEN json_extract(value,'$.approvals') END
      FROM system_settings WHERE workspace_id=NEW.workspace_id AND key='feature_toggles'),
    EXISTS(SELECT 1 FROM approval_rules WHERE workspace_id=NEW.workspace_id) OR EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=NEW.workspace_id));
  -- Anyone who may edit a task can require approval; only a live administrator may remove it.
  SELECT RAISE(ABORT,'approval_requirement_admin_only') WHERE NEW.operation='set_requirement'
    AND json_type(NEW.payload,'$.enabled') IS NOT 'true' AND NOT EXISTS(
      SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.actor_id AND is_active=1 AND role IN ('admin','super_admin'));
  SELECT RAISE(ABORT,'approval_conflict') WHERE NEW.operation='set_requirement' AND (
    json_extract(NEW.payload,'$.taskId') IS NOT NEW.task_id OR NOT EXISTS(
      SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.task_id
      AND requires_approval=json_extract(NEW.payload,'$.expectedRequiresApproval')
      AND current_approval_id IS NULL AND approval_status IS NULL)
    OR EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=NEW.workspace_id AND task_id=NEW.task_id AND status='pending'));
  SELECT RAISE(ABORT,'approval_conflict') WHERE NEW.operation='submit' AND (
    json_extract(NEW.payload,'$.taskId') IS NOT NEW.task_id OR NOT EXISTS(
      SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.task_id
        AND status_id=json_extract(NEW.payload,'$.expected.statusId')
        AND requires_approval=json_extract(NEW.payload,'$.expected.requiresApproval')
        AND current_approval_id IS json_extract(NEW.payload,'$.expected.currentApprovalId')
        AND approval_status IS json_extract(NEW.payload,'$.expected.approvalStatus')
        AND current_approval_id IS NULL AND approval_status IS NULL)
    OR EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=NEW.workspace_id AND task_id=NEW.task_id AND status='pending'));
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE NEW.operation='submit' AND (
    (SELECT count(*) FROM approval_rules r JOIN tasks t ON t.project_id=r.project_id AND t.workspace_id=r.workspace_id
      WHERE r.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND r.is_active=1
      AND r.from_status=t.status_id AND r.to_status=json_extract(NEW.payload,'$.toStatusId'))>1
    OR json_extract(NEW.payload,'$.expectedRuleId') IS NOT (
      SELECT r.id FROM approval_rules r JOIN tasks t ON t.project_id=r.project_id AND t.workspace_id=r.workspace_id
      WHERE r.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND r.is_active=1
      AND r.from_status=t.status_id AND r.to_status=json_extract(NEW.payload,'$.toStatusId'))
    OR NOT EXISTS(SELECT 1 FROM statuses WHERE workspace_id=NEW.workspace_id AND id=json_extract(NEW.payload,'$.toStatusId'))
    OR json_extract(NEW.payload,'$.toStatusId') IS json_extract(NEW.payload,'$.expected.statusId'));
  SELECT RAISE(ABORT,'approval_not_required') WHERE NEW.operation='submit' AND json_extract(NEW.payload,'$.expectedRuleId') IS NULL
    AND json_extract(NEW.payload,'$.enableRequirement')=0
    AND EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.task_id AND requires_approval=0);
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE NEW.operation='submit' AND json_extract(NEW.payload,'$.expectedRuleId') IS NOT NULL AND (
    NOT EXISTS(SELECT 1 FROM approval_rule_steps WHERE workspace_id=NEW.workspace_id AND rule_id=json_extract(NEW.payload,'$.expectedRuleId'))
    OR (SELECT count(*) FROM approval_rule_steps WHERE rule_id=json_extract(NEW.payload,'$.expectedRuleId'))>100
    OR EXISTS(SELECT 1 FROM approval_rule_steps s WHERE s.rule_id=json_extract(NEW.payload,'$.expectedRuleId') AND (
      s.workspace_id<>NEW.workspace_id OR s.step_order<1
      OR s.step_order<>(SELECT count(*) FROM approval_rule_steps x WHERE x.rule_id=s.rule_id AND x.step_order<=s.step_order)
      OR (s.approver_type='role' AND (s.approver_role NOT IN ('member','admin','super_admin') OR s.approver_role IS NULL OR s.approver_user_id IS NOT NULL))
      OR (s.approver_type='user' AND (s.approver_role IS NOT NULL OR NOT EXISTS(
        SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=s.approver_user_id AND is_active=1))))));
  SELECT RAISE(ABORT,'approval_conflict') WHERE NEW.operation IN ('approve','reject','return','withdraw') AND NOT EXISTS(
    SELECT 1 FROM approval_requests r JOIN tasks t ON t.workspace_id=r.workspace_id AND t.id=r.task_id
    WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id AND r.task_id=NEW.task_id
      AND r.id=json_extract(NEW.payload,'$.requestId') AND r.status='pending'
      AND r.version=json_extract(NEW.payload,'$.expectedVersion')
      AND (NEW.operation='withdraw' OR r.current_step=json_extract(NEW.payload,'$.expectedStep'))
      AND t.current_approval_id=r.id AND t.approval_status='pending_approval' AND t.status_id=r.from_status);
  SELECT RAISE(ABORT,'approval_forbidden') WHERE NEW.operation='withdraw' AND NOT EXISTS(
    SELECT 1 FROM approval_requests r JOIN members m ON m.id=NEW.actor_id AND m.workspace_id=r.workspace_id
    WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id
      AND (r.requested_by=NEW.actor_id OR m.role IN ('admin','super_admin')));
  -- A requester never decides their own request, whatever their role; it waits for
  -- another approver or is withdrawn.
  SELECT RAISE(ABORT,'approval_self_decision_forbidden') WHERE NEW.operation IN ('approve','reject','return') AND EXISTS(
    SELECT 1 FROM approval_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id AND requested_by=NEW.actor_id);
  -- Legacy pending requests have no trustworthy snapshot. They can be withdrawn
  -- and resubmitted, but must never be reinterpreted using an edited live rule.
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE NEW.operation IN ('approve','reject','return') AND NOT EXISTS(
    SELECT 1 FROM approval_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id
      AND json_valid(steps_snapshot) AND json_type(steps_snapshot)='array' AND json_array_length(steps_snapshot)>0
      AND current_step BETWEEN 1 AND json_array_length(steps_snapshot));
  SELECT RAISE(ABORT,'approval_forbidden') WHERE NEW.operation IN ('approve','reject','return') AND NOT EXISTS(
    SELECT 1 FROM approval_requests r JOIN members m ON m.id=NEW.actor_id AND m.workspace_id=r.workspace_id AND m.is_active=1
      JOIN json_each(r.steps_snapshot) s ON CAST(s.key AS INTEGER)+1=r.current_step
    WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id AND (
      (json_extract(s.value,'$.approver_type')='user' AND json_extract(s.value,'$.approver_user_id')=m.id)
      OR (json_extract(s.value,'$.approver_type')='role' AND json_extract(s.value,'$.approver_role')=m.role)
      OR (r.rule_id IS NULL AND m.role IN ('admin','super_admin'))));
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE NEW.operation='approve' AND NOT EXISTS(
    SELECT 1 FROM approval_requests r JOIN statuses s ON s.id=r.to_status AND s.workspace_id=r.workspace_id
    WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id);
  SELECT RAISE(ABORT,'approval_transition_prerequisite') WHERE (NEW.operation='submit' OR (NEW.operation='approve' AND EXISTS(
    SELECT 1 FROM approval_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id AND current_step=json_array_length(steps_snapshot))))
    AND EXISTS(SELECT 1 FROM status_transition_rules x WHERE x.workspace_id=NEW.workspace_id
      AND x.target_status_id=CASE WHEN NEW.operation='submit' THEN json_extract(NEW.payload,'$.toStatusId') ELSE (
        SELECT to_status FROM approval_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id) END
      AND NOT EXISTS(SELECT 1 FROM status_logs l WHERE l.workspace_id=NEW.workspace_id AND l.task_id=NEW.task_id AND l.to_status_id=x.required_status_id));
END;

DROP TRIGGER IF EXISTS approval_command_apply;
CREATE TRIGGER IF NOT EXISTS approval_command_apply AFTER INSERT ON approval_command_contexts
BEGIN
  INSERT INTO approval_requests(workspace_id,id,task_id,rule_id,requested_by,from_status,to_status,current_step,status,created_at,version,steps_snapshot,rule_snapshot)
    SELECT NEW.workspace_id,NEW.request_id,t.id,json_extract(NEW.payload,'$.expectedRuleId'),NEW.actor_id,t.status_id,
      json_extract(NEW.payload,'$.toStatusId'),1,'pending',NEW.created_at,1,
      CASE WHEN json_extract(NEW.payload,'$.expectedRuleId') IS NULL THEN '[{"step_order":1,"approver_type":"role","approver_role":"admin","approver_user_id":null}]'
      ELSE (SELECT json_group_array(json(step)) FROM (SELECT json_object('step_order',s.step_order,'approver_type',s.approver_type,
        'approver_role',s.approver_role,'approver_user_id',s.approver_user_id) AS step FROM approval_rule_steps s
        WHERE s.workspace_id=NEW.workspace_id AND s.rule_id=json_extract(NEW.payload,'$.expectedRuleId') ORDER BY s.step_order)) END,
      CASE WHEN json_extract(NEW.payload,'$.expectedRuleId') IS NULL THEN NULL ELSE (SELECT json_object('id',r.id,
        'project_id',r.project_id,'from_status',r.from_status,'to_status',r.to_status) FROM approval_rules r
        WHERE r.workspace_id=NEW.workspace_id AND r.id=json_extract(NEW.payload,'$.expectedRuleId')) END
    FROM tasks t WHERE NEW.operation='submit' AND t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id;
  INSERT INTO approval_actions(workspace_id,id,request_id,step_order,action_by,action,comment,acted_at,command_id,request_version)
    SELECT NEW.workspace_id,NEW.event_id,NEW.request_id,r.current_step,NEW.actor_id,NEW.operation,
      json_extract(NEW.payload,'$.comment'),NEW.created_at,NEW.id,r.version+1 FROM approval_requests r
    WHERE NEW.operation IN ('approve','reject','return') AND r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id;
  INSERT INTO status_logs(workspace_id,id,task_id,from_status_id,to_status_id,changed_by,changed_at)
    SELECT NEW.workspace_id,NEW.event_id,NEW.task_id,r.from_status,r.to_status,NEW.actor_id,NEW.created_at
    FROM approval_requests r WHERE NEW.operation='approve' AND r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id
      AND r.current_step=json_array_length(r.steps_snapshot);
  UPDATE tasks SET
    status_id=(SELECT to_status FROM approval_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id),
    started_at=CASE WHEN started_at IS NULL AND EXISTS(SELECT 1 FROM approval_requests r JOIN statuses s ON s.id=r.to_status AND s.workspace_id=r.workspace_id
      WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id AND s.auto_start=1) THEN substr(NEW.created_at,1,10) ELSE started_at END,
    completed_at=CASE WHEN EXISTS(SELECT 1 FROM approval_requests r JOIN statuses s ON s.id=r.to_status AND s.workspace_id=r.workspace_id
      WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id AND s.is_done=1)
      THEN CASE WHEN EXISTS(SELECT 1 FROM statuses WHERE workspace_id=NEW.workspace_id AND id=tasks.status_id AND is_done=1) THEN completed_at ELSE NEW.created_at END ELSE NULL END,
    approval_status=NULL,current_approval_id=NULL
    WHERE NEW.operation='approve' AND workspace_id=NEW.workspace_id AND id=NEW.task_id
      AND EXISTS(SELECT 1 FROM approval_requests r WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id
        AND r.current_step=json_array_length(r.steps_snapshot));
  UPDATE approval_requests SET version=version+1,
    status=CASE WHEN NEW.operation='withdraw' THEN 'cancelled' WHEN NEW.operation='reject' THEN 'rejected'
      WHEN NEW.operation='return' THEN 'returned' WHEN current_step=json_array_length(steps_snapshot) THEN 'approved' ELSE 'pending' END,
    completed_at=CASE WHEN NEW.operation<>'approve' OR current_step=json_array_length(steps_snapshot) THEN NEW.created_at ELSE NULL END,
    current_step=CASE WHEN NEW.operation='approve' AND current_step<json_array_length(steps_snapshot) THEN current_step+1 ELSE current_step END
    WHERE NEW.operation IN ('approve','reject','return','withdraw') AND workspace_id=NEW.workspace_id AND id=NEW.request_id;
  UPDATE tasks SET approval_status=NULL,current_approval_id=NULL WHERE NEW.operation IN ('reject','return','withdraw')
    AND workspace_id=NEW.workspace_id AND id=NEW.task_id AND current_approval_id=NEW.request_id;
  UPDATE tasks SET approval_status='pending_approval',current_approval_id=NEW.request_id,
    requires_approval=CASE WHEN json_extract(NEW.payload,'$.enableRequirement')=1 THEN 1 ELSE requires_approval END
    WHERE NEW.operation='submit' AND workspace_id=NEW.workspace_id AND id=NEW.task_id;
  UPDATE tasks SET requires_approval=json_extract(NEW.payload,'$.enabled')
    WHERE NEW.operation='set_requirement' AND workspace_id=NEW.workspace_id AND id=NEW.task_id;
  INSERT INTO approval_events(workspace_id,id,task_id,request_id,actor_id,command_id,operation,request_version,created_at)
    SELECT NEW.workspace_id,NEW.event_id,NEW.task_id,NEW.request_id,NEW.actor_id,NEW.id,NEW.operation,
      (SELECT version FROM approval_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id),NEW.created_at;
  INSERT INTO activity_logs(workspace_id,id,user_id,action,target_type,task_id,task_key,detail,created_at)
    SELECT NEW.workspace_id,NEW.event_id,NEW.actor_id,'approval_'||NEW.operation,'task',t.id,t.task_key,
      json_object('commandId',NEW.id,'requestId',NEW.request_id,'operation',NEW.operation),NEW.created_at
      FROM tasks t WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id;
  INSERT INTO notifications(workspace_id,id,recipient_id,sender_id,type,task_id,content,is_read,created_at)
    SELECT NEW.workspace_id,NEW.event_id||':'||m.id,m.id,NEW.actor_id,
      CASE WHEN r.status='pending' THEN 'approval_requested' ELSE 'approval_completed' END,NEW.task_id,
      json_object('kind','approval','requestId',r.id,'taskTitle',t.title,'operation',NEW.operation,'version',r.version),0,NEW.created_at
    FROM approval_requests r JOIN tasks t ON t.workspace_id=r.workspace_id AND t.id=r.task_id
    JOIN members m ON m.workspace_id=r.workspace_id AND m.is_active=1 AND m.id<>NEW.actor_id
    WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id AND NEW.operation IN ('submit','approve','reject','return')
      AND ((r.status<>'pending' AND m.id=r.requested_by) OR (r.status='pending' AND m.id<>r.requested_by AND EXISTS(
        SELECT 1 FROM json_each(r.steps_snapshot) s WHERE CAST(s.key AS INTEGER)+1=r.current_step AND (
          (json_extract(s.value,'$.approver_type')='user' AND json_extract(s.value,'$.approver_user_id')=m.id)
          OR (json_extract(s.value,'$.approver_type')='role' AND json_extract(s.value,'$.approver_role')=m.role)
          OR (r.rule_id IS NULL AND m.role IN ('admin','super_admin'))))));
  INSERT INTO approval_delivery_outbox(workspace_id,id,task_id,request_id,event_id,recipient_id,team_id,target_id,delivery_type,operation,request_version,next_attempt_at,created_at)
    SELECT DISTINCT NEW.workspace_id,NEW.event_id||':channel:'||json_extract(route.value,'$.channelId'),NEW.task_id,NEW.request_id,NEW.event_id,NULL,
      json_extract(s.value,'$.teamId'),json_extract(route.value,'$.channelId'),'channel',NEW.operation,r.version,NEW.created_at,NEW.created_at
    FROM approval_requests r JOIN tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id
      JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id
      JOIN system_settings s ON s.workspace_id=r.workspace_id AND s.key='slack_delivery' AND json_valid(s.value)
      JOIN json_each(CASE WHEN json_type(s.value,'$.routes')='array' THEN json_extract(s.value,'$.routes') ELSE '[]' END) route
    WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id AND NEW.operation IN ('submit','approve','reject','return')
      AND json_extract(s.value,'$.enabled')=1 AND json_type(s.value,'$.teamId')='text'
      AND json_type(route.value,'$.channelId')='text' AND COALESCE(json_extract(route.value,'$.enabled'),1)=1
      AND (json_extract(route.value,'$.projectId')=p.id OR json_extract(route.value,'$.lineId')=p.line_id);
  INSERT INTO approval_delivery_outbox(workspace_id,id,task_id,request_id,event_id,recipient_id,team_id,target_id,delivery_type,operation,request_version,next_attempt_at,created_at)
    SELECT NEW.workspace_id,NEW.event_id||':dm:'||n.recipient_id,NEW.task_id,NEW.request_id,NEW.event_id,n.recipient_id,
      json_extract(s.value,'$.teamId'),n.recipient_id,'dm',NEW.operation,r.version,NEW.created_at,NEW.created_at
    FROM notifications n JOIN approval_requests r ON r.workspace_id=n.workspace_id AND r.id=NEW.request_id
      JOIN system_settings s ON s.workspace_id=n.workspace_id AND s.key='slack_delivery' AND json_valid(s.value)
    WHERE n.workspace_id=NEW.workspace_id AND n.id LIKE NEW.event_id||':%' AND json_extract(s.value,'$.enabled')=1
       AND json_extract(s.value,'$.dmEnabled')=1 AND json_type(s.value,'$.teamId')='text'
       AND EXISTS(SELECT 1 FROM approval_delivery_outbox q WHERE q.workspace_id=NEW.workspace_id AND q.event_id=NEW.event_id AND q.delivery_type='channel')
      AND (json_type(s.value,'$.dmMemberIds') IS NULL OR EXISTS(SELECT 1 FROM json_each(s.value,'$.dmMemberIds') m WHERE m.value=n.recipient_id));
  INSERT INTO approval_command_receipts(workspace_id,id,actor_id,task_id,request_id,payload_hash,result_json,created_at)
    SELECT NEW.workspace_id,NEW.id,NEW.actor_id,NEW.task_id,NEW.request_id,NEW.payload_hash,
      json_object('commandId',NEW.id,'replayed',json('false'),'eventId',NEW.event_id,
        'request',CASE WHEN NEW.request_id IS NULL THEN NULL ELSE (SELECT json_object('id',r.id,'task_id',r.task_id,'rule_id',r.rule_id,
          'requested_by',r.requested_by,'from_status',r.from_status,'to_status',r.to_status,'current_step',r.current_step,'status',r.status,
          'version',r.version,'steps_snapshot',CASE WHEN r.steps_snapshot IS NULL THEN NULL ELSE json(r.steps_snapshot) END,
          'rule_snapshot',CASE WHEN r.rule_snapshot IS NULL THEN NULL ELSE json(r.rule_snapshot) END,'created_at',r.created_at,'completed_at',r.completed_at)
          FROM approval_requests r WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id) END,
        'task',json_object('id',t.id,'status_id',t.status_id,'requires_approval',json(CASE WHEN t.requires_approval=1 THEN 'true' ELSE 'false' END),
          'approval_status',t.approval_status,'current_approval_id',t.current_approval_id,'started_at',t.started_at,'completed_at',t.completed_at)),NEW.created_at
      FROM tasks t WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id;
  DELETE FROM approval_command_contexts WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
END;

-- Contexts cannot remain reusable. Exactly one command context exists during a
-- statement, and every protected write must concern its task/request/operation.
CREATE TRIGGER IF NOT EXISTS approval_request_command_insert BEFORE INSERT ON approval_requests
BEGIN
  SELECT RAISE(ABORT,'approval_forbidden') WHERE NOT EXISTS(SELECT 1 FROM approval_command_contexts c
    WHERE c.workspace_id=NEW.workspace_id AND c.request_id=NEW.id AND c.task_id=NEW.task_id
      AND c.actor_id=NEW.requested_by AND c.operation='submit');
END;
CREATE TRIGGER IF NOT EXISTS approval_request_command_update BEFORE UPDATE ON approval_requests
BEGIN
  SELECT RAISE(ABORT,'approval_forbidden') WHERE NEW.workspace_id<>OLD.workspace_id OR NEW.task_id<>OLD.task_id
    OR NEW.rule_id IS NOT OLD.rule_id OR NEW.requested_by<>OLD.requested_by OR NEW.from_status<>OLD.from_status
    OR NEW.to_status<>OLD.to_status OR NEW.steps_snapshot IS NOT OLD.steps_snapshot OR NEW.rule_snapshot IS NOT OLD.rule_snapshot
    OR NEW.version<>OLD.version+1 OR NOT EXISTS(SELECT 1 FROM approval_command_contexts c
      WHERE c.workspace_id=OLD.workspace_id AND c.request_id=OLD.id AND c.task_id=OLD.task_id
      AND c.operation IN ('approve','reject','return','withdraw'));
END;
CREATE TRIGGER IF NOT EXISTS approval_request_pending_delete BEFORE DELETE ON approval_requests WHEN OLD.status='pending'
BEGIN SELECT RAISE(ABORT,'approval_conflict'); END;
CREATE TRIGGER IF NOT EXISTS approval_action_command_insert BEFORE INSERT ON approval_actions
BEGIN
  SELECT RAISE(ABORT,'approval_forbidden') WHERE NOT EXISTS(SELECT 1 FROM approval_command_contexts c
    WHERE c.workspace_id=NEW.workspace_id AND c.request_id=NEW.request_id AND c.actor_id=NEW.action_by
      AND c.id=NEW.command_id AND c.operation=NEW.action);
END;
CREATE TRIGGER IF NOT EXISTS approval_action_immutable BEFORE UPDATE ON approval_actions
BEGIN SELECT RAISE(ABORT,'approval_forbidden'); END;
CREATE TRIGGER IF NOT EXISTS approval_task_command_update BEFORE UPDATE ON tasks
WHEN NEW.approval_status IS NOT OLD.approval_status OR NEW.current_approval_id IS NOT OLD.current_approval_id
  OR NEW.requires_approval<>OLD.requires_approval
  OR ((OLD.current_approval_id IS NOT NULL OR OLD.approval_status='pending_approval'
    OR EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=OLD.workspace_id AND task_id=OLD.id AND status='pending'))
    AND (NEW.status_id<>OLD.status_id OR NEW.project_id<>OLD.project_id))
  OR (NEW.status_id<>OLD.status_id AND OLD.requires_approval=1 AND COALESCE(
    (SELECT CASE WHEN json_type(value,'$.approvals') IN ('true','false') THEN json_extract(value,'$.approvals') END
      FROM system_settings WHERE workspace_id=OLD.workspace_id AND key='feature_toggles'),
    EXISTS(SELECT 1 FROM approval_rules WHERE workspace_id=OLD.workspace_id) OR EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=OLD.workspace_id)))
BEGIN
  SELECT RAISE(ABORT,'approval_forbidden') WHERE NEW.workspace_id<>OLD.workspace_id OR NOT EXISTS(
    SELECT 1 FROM approval_command_contexts c WHERE c.workspace_id=OLD.workspace_id AND c.task_id=OLD.id
      AND c.operation IN ('submit','approve','reject','return','withdraw','set_requirement'));
END;
CREATE TRIGGER IF NOT EXISTS approval_task_pending_delete BEFORE DELETE ON tasks
WHEN OLD.current_approval_id IS NOT NULL OR OLD.approval_status='pending_approval'
 OR EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=OLD.workspace_id AND task_id=OLD.id AND status='pending')
BEGIN SELECT RAISE(ABORT,'approval_conflict'); END;
CREATE TRIGGER IF NOT EXISTS approval_task_no_pointer_insert BEFORE INSERT ON tasks
WHEN NEW.current_approval_id IS NOT NULL OR NEW.approval_status IS NOT NULL
BEGIN SELECT RAISE(ABORT,'approval_forbidden'); END;
CREATE TRIGGER IF NOT EXISTS approval_rule_pending_update BEFORE UPDATE ON approval_rules
WHEN EXISTS(SELECT 1 FROM approval_requests WHERE rule_id=OLD.id AND status='pending')
BEGIN SELECT RAISE(ABORT,'approval_rule_in_use'); END;
CREATE TRIGGER IF NOT EXISTS approval_rule_workspace_insert BEFORE INSERT ON approval_rules
BEGIN
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE
    (NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE workspace_id=NEW.workspace_id AND id=NEW.project_id AND is_archived=0))
    OR NOT EXISTS(SELECT 1 FROM statuses WHERE workspace_id=NEW.workspace_id AND id=NEW.from_status)
    OR NOT EXISTS(SELECT 1 FROM statuses WHERE workspace_id=NEW.workspace_id AND id=NEW.to_status)
    OR NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.created_by AND is_active=1)
    OR NEW.from_status=NEW.to_status;
END;
CREATE TRIGGER IF NOT EXISTS approval_rule_workspace_update BEFORE UPDATE ON approval_rules
BEGIN
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE NEW.workspace_id<>OLD.workspace_id
    OR (NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE workspace_id=NEW.workspace_id AND id=NEW.project_id AND is_archived=0))
    OR NOT EXISTS(SELECT 1 FROM statuses WHERE workspace_id=NEW.workspace_id AND id=NEW.from_status)
    OR NOT EXISTS(SELECT 1 FROM statuses WHERE workspace_id=NEW.workspace_id AND id=NEW.to_status) OR NEW.from_status=NEW.to_status;
END;
CREATE TRIGGER IF NOT EXISTS approval_step_workspace_insert BEFORE INSERT ON approval_rule_steps
BEGIN
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE NOT EXISTS(SELECT 1 FROM approval_rules WHERE workspace_id=NEW.workspace_id AND id=NEW.rule_id)
    OR (NEW.approver_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.approver_user_id AND is_active=1));
END;
CREATE TRIGGER IF NOT EXISTS approval_step_workspace_update BEFORE UPDATE ON approval_rule_steps
BEGIN
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE NEW.workspace_id<>OLD.workspace_id OR NOT EXISTS(SELECT 1 FROM approval_rules WHERE workspace_id=NEW.workspace_id AND id=NEW.rule_id)
    OR (NEW.approver_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.approver_user_id AND is_active=1));
END;
CREATE TRIGGER IF NOT EXISTS approval_rule_history_delete BEFORE DELETE ON approval_rules
WHEN EXISTS(SELECT 1 FROM approval_requests WHERE rule_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'approval_rule_in_use'); END;
CREATE TRIGGER IF NOT EXISTS approval_step_pending_insert BEFORE INSERT ON approval_rule_steps
WHEN EXISTS(SELECT 1 FROM approval_requests WHERE rule_id=NEW.rule_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'approval_rule_in_use'); END;
CREATE TRIGGER IF NOT EXISTS approval_step_pending_update BEFORE UPDATE ON approval_rule_steps
WHEN EXISTS(SELECT 1 FROM approval_requests WHERE rule_id IN (OLD.rule_id,NEW.rule_id) AND status='pending')
BEGIN SELECT RAISE(ABORT,'approval_rule_in_use'); END;
CREATE TRIGGER IF NOT EXISTS approval_step_pending_delete BEFORE DELETE ON approval_rule_steps
WHEN EXISTS(SELECT 1 FROM approval_requests WHERE rule_id=OLD.rule_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'approval_rule_in_use'); END;
CREATE TRIGGER IF NOT EXISTS approval_status_pending_delete BEFORE DELETE ON statuses
WHEN EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=OLD.workspace_id AND status='pending' AND (from_status=OLD.id OR to_status=OLD.id))
BEGIN SELECT RAISE(ABORT,'approval_rule_in_use'); END;
CREATE TRIGGER IF NOT EXISTS approval_project_pending_update BEFORE UPDATE ON projects
WHEN NEW.is_archived<>OLD.is_archived OR NEW.workspace_id<>OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT,'approval_rule_in_use') WHERE EXISTS(SELECT 1 FROM approval_requests r JOIN tasks t ON t.id=r.task_id
    WHERE t.project_id=OLD.id AND r.status='pending');
END;
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
DROP TRIGGER IF EXISTS work_task_update_guard;
CREATE TRIGGER work_task_update_guard BEFORE UPDATE ON tasks BEGIN
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
  OR (NEW.project_id IS OLD.project_id AND EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND parent_task_id=NEW.id AND project_id<>NEW.project_id)));
 SELECT RAISE(ABORT,'work_conflict') WHERE (NEW.task_key<>OLD.task_key OR NEW.project_id<>OLD.project_id) AND EXISTS(
  SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND task_key=NEW.task_key AND id<>NEW.id);
END;
-- A parent changing project takes its subtasks along in the same statement; each
-- subtask still passes work_task_update_guard against the already-moved parent.
DROP TRIGGER IF EXISTS work_task_move_subtasks;
CREATE TRIGGER work_task_move_subtasks AFTER UPDATE ON tasks
WHEN NEW.project_id IS NOT OLD.project_id AND NEW.parent_task_id IS NULL BEGIN
 UPDATE tasks SET project_id=NEW.project_id WHERE workspace_id=NEW.workspace_id AND parent_task_id=NEW.id AND project_id IS NOT NEW.project_id;
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
-- Replaced on every apply so a corrected rule reaches existing databases.
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
 SELECT RAISE(ABORT,'work_required_fields') WHERE NEW.operation='create_subtask' AND (
  EXISTS(SELECT 1 FROM system_settings s JOIN json_each(s.value) x WHERE s.workspace_id=NEW.workspace_id AND s.key='required_fields' AND x.value=1 AND (
    x.key NOT IN('title','project','status','priority','dueDate','assignee','reviewer') OR (x.key='dueDate' AND json_extract(NEW.payload,'$.dueDate') IS NULL)
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
-- New subtask keys count every task with the project's prefix, including tasks moved
-- to another project (they keep their key; keys are unique per workspace).
-- DROP + CREATE so existing databases receive trigger changes.
DROP TRIGGER IF EXISTS work_command_apply;
CREATE TRIGGER work_command_apply AFTER INSERT ON task_work_contexts BEGIN
 INSERT INTO task_work_events(workspace_id,id,command_id,actor_id,task_id,operation,before_value,created_at)
  VALUES(NEW.workspace_id,NEW.event_id,NEW.id,NEW.actor_id,NEW.task_id,NEW.operation,NULL,NEW.created_at);
 UPDATE tasks SET assignee_acknowledged_at=CASE WHEN json_extract(NEW.payload,'$.role')='assignee' THEN COALESCE(assignee_acknowledged_at,NEW.created_at) ELSE assignee_acknowledged_at END,
  reviewer_acknowledged_at=CASE WHEN json_extract(NEW.payload,'$.role')='reviewer' THEN COALESCE(reviewer_acknowledged_at,NEW.created_at) ELSE reviewer_acknowledged_at END
  WHERE NEW.operation='acknowledge' AND workspace_id=NEW.workspace_id AND id=NEW.task_id;
 INSERT INTO tasks(workspace_id,id,task_key,project_id,parent_task_id,title,status_id,priority,creator_id,assignee_id,reviewer_id,due_date,sprint_id,started_at,completed_at)
  SELECT NEW.workspace_id,NEW.record_id,p.key||'-'||(SELECT COALESCE(max(CAST(substr(x.task_key,length(p.key)+2) AS INTEGER)),0)+1 FROM tasks x WHERE x.workspace_id=NEW.workspace_id AND substr(x.task_key,1,length(p.key)+1)=p.key||'-'),
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
  WHEN NEW.operation='comment' THEN 1
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
-- Knowledge work: same repeatable guards as the upgrade migration.
CREATE TABLE IF NOT EXISTS kb_publications (
 workspace_id TEXT NOT NULL, id TEXT NOT NULL, page_id TEXT NOT NULL, page_version INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN('effective','superseded')),version INTEGER NOT NULL CHECK(version>0),
 predecessor_id TEXT,successor_id TEXT,published_by TEXT NOT NULL,published_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,page_id) REFERENCES kb_pages(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,page_id,page_version) REFERENCES kb_revisions(workspace_id,page_id,version) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id,predecessor_id) REFERENCES kb_publications(workspace_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id,successor_id) REFERENCES kb_publications(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS kb_one_effective_publication ON kb_publications(workspace_id,page_id) WHERE state='effective';
CREATE TABLE IF NOT EXISTS kb_source_links (
 workspace_id TEXT NOT NULL,id TEXT NOT NULL,page_id TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN('knowledge','task','qa','knowledge_file','task_file','qa_file')),
 source_id TEXT NOT NULL,source_version TEXT NOT NULL,source_page_version INTEGER,created_by TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,page_id,source_kind,source_id),
 FOREIGN KEY(workspace_id,page_id) REFERENCES kb_pages(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,source_id,source_page_version) REFERENCES kb_revisions(workspace_id,page_id,version) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS kb_work_receipts (
 workspace_id TEXT NOT NULL,id TEXT NOT NULL,actor_id TEXT NOT NULL,page_id TEXT NOT NULL,canonical TEXT NOT NULL,event_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,page_id) REFERENCES kb_pages(workspace_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS kb_work_events (
 workspace_id TEXT NOT NULL,id TEXT NOT NULL,actor_id TEXT NOT NULL,page_id TEXT NOT NULL,command_id TEXT NOT NULL,operation TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,command_id),
 FOREIGN KEY(workspace_id,page_id) REFERENCES kb_pages(workspace_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,command_id) REFERENCES kb_work_receipts(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS kb_work_clock(workspace_id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO kb_work_clock(workspace_id) SELECT id FROM workspaces;
CREATE TABLE IF NOT EXISTS kb_work_contexts (
 workspace_id TEXT NOT NULL,id TEXT NOT NULL,actor_id TEXT NOT NULL,auth_id TEXT NOT NULL,page_id TEXT NOT NULL,operation TEXT NOT NULL,
 expected_generation INTEGER NOT NULL,lease_pages TEXT NOT NULL CHECK(json_valid(lease_pages)),PRIMARY KEY(workspace_id,id)
);
CREATE TRIGGER IF NOT EXISTS kb_work_import_guard BEFORE INSERT ON task_planning_import_guard BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM kb_source_links WHERE workspace_id=NEW.workspace_id AND source_kind IN('task','task_file','qa','qa_file'))
  THEN RAISE(ABORT,'knowledge_requires_server_restore') END;
END;
CREATE TRIGGER IF NOT EXISTS kb_work_context_guard BEFORE INSERT ON kb_work_contexts BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM members m JOIN auth_users u ON u.id=m.auth_id WHERE m.workspace_id=NEW.workspace_id
  AND m.id=NEW.actor_id AND m.auth_id=NEW.auth_id AND m.is_active=1 AND m.role IN('member','admin','super_admin') AND COALESCE(u.banned,0)=0
  AND (SELECT count(*) FROM members x WHERE x.workspace_id=m.workspace_id AND x.auth_id=m.auth_id AND x.is_active=1)=1)
  THEN RAISE(ABORT,'knowledge_forbidden') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM kb_work_clock WHERE workspace_id=NEW.workspace_id AND generation=NEW.expected_generation)
  THEN RAISE(ABORT,'knowledge_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM kb_work_receipts WHERE workspace_id=NEW.workspace_id AND id=NEW.id)
  THEN RAISE(ABORT,'knowledge_conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM field_locks l JOIN json_each(NEW.lease_pages) p ON l.lock_key='kb:'||p.value
  WHERE l.workspace_id=NEW.workspace_id AND l.locked_by<>NEW.actor_id AND julianday(l.expires_at)>julianday('now'))
  THEN RAISE(ABORT,'knowledge_conflict') END;
END;
CREATE TRIGGER IF NOT EXISTS kb_work_page_insert_guard BEFORE INSERT ON kb_pages BEGIN
 SELECT CASE WHEN (NEW.private_draft_owner_id IS NOT NULL OR NEW.document_metadata<>'{"documentKind":null,"ownerId":null,"applicability":{"productVersion":null,"environment":null,"summary":null}}')
  AND NOT EXISTS(SELECT 1 FROM kb_work_contexts WHERE workspace_id=NEW.workspace_id AND page_id=NEW.id AND operation='save_draft' AND actor_id=NEW.private_draft_owner_id)
  THEN RAISE(ABORT,'knowledge_forbidden') END;
END;
CREATE TRIGGER IF NOT EXISTS kb_work_page_update_guard BEFORE UPDATE ON kb_pages BEGIN
 SELECT CASE WHEN (NEW.private_draft_owner_id IS NOT OLD.private_draft_owner_id OR NEW.document_metadata IS NOT OLD.document_metadata
  OR (OLD.private_draft_owner_id IS NOT NULL AND (NEW.parent_id IS NOT OLD.parent_id OR NEW.project_id IS NOT OLD.project_id OR NEW.access_policy IS NOT OLD.access_policy)))
  AND NOT EXISTS(SELECT 1 FROM kb_work_contexts WHERE workspace_id=NEW.workspace_id AND page_id=NEW.id)
  THEN RAISE(ABORT,'knowledge_forbidden') END;
END;
CREATE TRIGGER IF NOT EXISTS kb_work_revision_delete_guard BEFORE DELETE ON kb_revisions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM kb_publications WHERE workspace_id=OLD.workspace_id AND page_id=OLD.page_id AND page_version=OLD.version)
  OR EXISTS(SELECT 1 FROM kb_source_links WHERE workspace_id=OLD.workspace_id AND source_kind='knowledge' AND source_id=OLD.page_id AND source_page_version=OLD.version)
  THEN RAISE(ABORT,'knowledge_conflict') END;
END;
DROP TRIGGER IF EXISTS kb_save_revision;
CREATE TRIGGER kb_save_revision AFTER UPDATE ON kb_pages WHEN NEW.version<>OLD.version BEGIN
 INSERT OR IGNORE INTO kb_revisions(id,workspace_id,page_id,title,body,document_metadata,created_by,created_at,version)
 VALUES(lower(hex(randomblob(16))),OLD.workspace_id,OLD.id,OLD.title,OLD.body,OLD.document_metadata,OLD.updated_by,OLD.updated_at,OLD.version);
 DELETE FROM kb_revisions WHERE workspace_id=NEW.workspace_id AND page_id=NEW.id AND id IN(
  SELECT id FROM kb_revisions WHERE workspace_id=NEW.workspace_id AND page_id=NEW.id ORDER BY version DESC LIMIT -1 OFFSET 20)
  AND NOT EXISTS(SELECT 1 FROM kb_publications p WHERE p.workspace_id=kb_revisions.workspace_id AND p.page_id=kb_revisions.page_id AND p.page_version=kb_revisions.version)
  AND NOT EXISTS(SELECT 1 FROM kb_source_links l WHERE l.workspace_id=kb_revisions.workspace_id AND l.source_kind='knowledge' AND l.source_id=kb_revisions.page_id AND l.source_page_version=kb_revisions.version);
END;

CREATE TRIGGER IF NOT EXISTS kb_clock_members_insert AFTER INSERT ON members BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_members_update AFTER UPDATE ON members BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_members_delete AFTER DELETE ON members BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_projects_insert AFTER INSERT ON projects BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_projects_update AFTER UPDATE ON projects BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_projects_delete AFTER DELETE ON projects BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_statuses_insert AFTER INSERT ON statuses BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_statuses_update AFTER UPDATE ON statuses BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_statuses_delete AFTER DELETE ON statuses BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_tasks_insert AFTER INSERT ON tasks BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_tasks_update AFTER UPDATE ON tasks BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_tasks_delete AFTER DELETE ON tasks BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_task_specs_insert AFTER INSERT ON task_specs BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_task_specs_update AFTER UPDATE ON task_specs BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_task_specs_delete AFTER DELETE ON task_specs BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_task_attachments_insert AFTER INSERT ON task_attachments BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_task_attachments_update AFTER UPDATE ON task_attachments BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_task_attachments_delete AFTER DELETE ON task_attachments BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_qa_issues_insert AFTER INSERT ON qa_issues BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_qa_issues_update AFTER UPDATE ON qa_issues BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_qa_issues_delete AFTER DELETE ON qa_issues BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_qa_attachments_insert AFTER INSERT ON qa_attachments BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_qa_attachments_update AFTER UPDATE ON qa_attachments BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_qa_attachments_delete AFTER DELETE ON qa_attachments BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_pages_insert AFTER INSERT ON kb_pages BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_pages_update AFTER UPDATE ON kb_pages BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_pages_delete AFTER DELETE ON kb_pages BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_revisions_insert AFTER INSERT ON kb_revisions BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_revisions_update AFTER UPDATE ON kb_revisions BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_revisions_delete AFTER DELETE ON kb_revisions BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_attachments_insert AFTER INSERT ON kb_attachments BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_attachments_update AFTER UPDATE ON kb_attachments BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_attachments_delete AFTER DELETE ON kb_attachments BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_publications_insert AFTER INSERT ON kb_publications BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_publications_update AFTER UPDATE ON kb_publications BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_publications_delete AFTER DELETE ON kb_publications BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_source_links_insert AFTER INSERT ON kb_source_links BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_source_links_update AFTER UPDATE ON kb_source_links BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_kb_source_links_delete AFTER DELETE ON kb_source_links BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_field_locks_insert AFTER INSERT ON field_locks BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_field_locks_update AFTER UPDATE ON field_locks BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_field_locks_delete AFTER DELETE ON field_locks BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_system_settings_insert AFTER INSERT ON system_settings BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_system_settings_update AFTER UPDATE ON system_settings BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_system_settings_delete AFTER DELETE ON system_settings BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_external_account_bindings_insert AFTER INSERT ON external_account_bindings BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_external_account_bindings_update AFTER UPDATE ON external_account_bindings BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(NEW.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_external_account_bindings_delete AFTER DELETE ON external_account_bindings BEGIN INSERT INTO kb_work_clock(workspace_id,generation) VALUES(OLD.workspace_id,1) ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1; END;
CREATE TRIGGER IF NOT EXISTS kb_clock_auth_update AFTER UPDATE ON auth_users BEGIN UPDATE kb_work_clock SET generation=generation+1 WHERE workspace_id IN(SELECT workspace_id FROM members WHERE auth_id=NEW.id); END;
-- Deleting a page removes its knowledge-work bookkeeping (receipts, events,
-- own source links, publications) and every source link that points at the
-- page or one of its files; other publications only lose their pointer.
-- SQLite cannot change these foreign keys in place and checks RESTRICT
-- immediately, so the cleanup runs before the page row is deleted.
DROP TRIGGER IF EXISTS kb_work_page_delete_cleanup;
CREATE TRIGGER kb_work_page_delete_cleanup BEFORE DELETE ON kb_pages BEGIN
 DELETE FROM kb_source_links WHERE workspace_id=OLD.workspace_id AND (page_id=OLD.id OR (source_kind='knowledge' AND source_id=OLD.id)
  OR (source_kind='knowledge_file' AND source_id IN(SELECT id FROM kb_attachments WHERE workspace_id=OLD.workspace_id AND page_id=OLD.id)));
 UPDATE kb_publications SET predecessor_id=NULL WHERE workspace_id=OLD.workspace_id AND page_id<>OLD.id
  AND predecessor_id IN(SELECT id FROM kb_publications WHERE workspace_id=OLD.workspace_id AND page_id=OLD.id);
 UPDATE kb_publications SET successor_id=NULL WHERE workspace_id=OLD.workspace_id AND page_id<>OLD.id
  AND successor_id IN(SELECT id FROM kb_publications WHERE workspace_id=OLD.workspace_id AND page_id=OLD.id);
 DELETE FROM kb_publications WHERE workspace_id=OLD.workspace_id AND page_id=OLD.id;
 DELETE FROM kb_work_events WHERE workspace_id=OLD.workspace_id AND page_id=OLD.id;
 DELETE FROM kb_work_receipts WHERE workspace_id=OLD.workspace_id AND page_id=OLD.id;
END;
DROP TRIGGER IF EXISTS kb_work_attachment_delete_cleanup;
CREATE TRIGGER kb_work_attachment_delete_cleanup AFTER DELETE ON kb_attachments BEGIN
 DELETE FROM kb_source_links WHERE workspace_id=OLD.workspace_id AND source_kind='knowledge_file' AND source_id=OLD.id;
END;
-- A shared page cannot be moved under a private draft (or anything inside
-- one): that would hide it, and its children, from everyone but the owner.
DROP TRIGGER IF EXISTS kb_draft_hierarchy_guard;
CREATE TRIGGER kb_draft_hierarchy_guard BEFORE UPDATE OF parent_id ON kb_pages
WHEN NEW.parent_id IS NOT NULL AND NEW.parent_id IS NOT OLD.parent_id BEGIN
 SELECT CASE WHEN (WITH RECURSIVE target_chain(id,parent_id,owner,depth) AS (
   SELECT id,parent_id,private_draft_owner_id,1 FROM kb_pages WHERE workspace_id=NEW.workspace_id AND id=NEW.parent_id
   UNION ALL SELECT p.id,p.parent_id,p.private_draft_owner_id,t.depth+1 FROM kb_pages p JOIN target_chain t ON p.id=t.parent_id
    WHERE p.workspace_id=NEW.workspace_id AND t.depth<10
  ) SELECT count(*) FROM target_chain WHERE owner IS NOT NULL)>0
  AND (WITH RECURSIVE source_chain(id,parent_id,owner,depth) AS (
   SELECT OLD.id,OLD.parent_id,OLD.private_draft_owner_id,1
   UNION ALL SELECT p.id,p.parent_id,p.private_draft_owner_id,s.depth+1 FROM kb_pages p JOIN source_chain s ON p.id=s.parent_id
    WHERE p.workspace_id=OLD.workspace_id AND s.depth<10
  ) SELECT count(*) FROM source_chain WHERE owner IS NOT NULL)=0
 THEN RAISE(ABORT,'kb_private_draft_parent') END;
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
DROP TRIGGER IF EXISTS kb_task_key_insert;
CREATE TRIGGER kb_task_key_insert BEFORE INSERT ON tasks WHEN EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND task_key=NEW.task_key AND id<>NEW.id)
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
