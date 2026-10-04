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
