-- Server-only member invitations. Pending confirmations are deliberately not
-- members or auth users: email identity must be proved before Slack can see it.
CREATE TABLE IF NOT EXISTS member_invitations (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin','super_admin')),
  job_title TEXT NOT NULL DEFAULT '' CHECK(length(job_title)<=200),
  is_qa_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_qa_admin IN (0,1)),
  created_by TEXT NOT NULL,
  created_by_auth_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  used_at TEXT,
  used_member_id TEXT,
  used_auth_id TEXT,
  PRIMARY KEY(workspace_id,id),
  CHECK(is_qa_admin=0 OR role='member'),
  CHECK((used_at IS NULL AND used_member_id IS NULL AND used_auth_id IS NULL)
    OR (used_at IS NOT NULL AND used_member_id IS NOT NULL AND used_auth_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_member_invitations_list ON member_invitations(workspace_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_member_invitations_issuer ON member_invitations(workspace_id,created_by,created_at);
CREATE TABLE IF NOT EXISTS member_invitation_confirmations (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  email TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  send_state TEXT NOT NULL DEFAULT 'pending' CHECK(send_state IN ('pending','sent','failed')),
  sent_at TEXT,
  used_at TEXT,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,invitation_id) REFERENCES member_invitations(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS idx_member_invitation_confirmations_invite ON member_invitation_confirmations(workspace_id,invitation_id);
CREATE INDEX IF NOT EXISTS idx_member_invitation_confirmations_retention ON member_invitation_confirmations(workspace_id,expires_at,id);
CREATE TABLE IF NOT EXISTS member_invitation_send_attempts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,invitation_id) REFERENCES member_invitations(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS idx_member_invitation_attempts_invite ON member_invitation_send_attempts(workspace_id,invitation_id,created_at);
CREATE INDEX IF NOT EXISTS idx_member_invitation_attempts_email ON member_invitation_send_attempts(workspace_id,email_hash,created_at);
CREATE INDEX IF NOT EXISTS idx_member_invitation_attempts_source ON member_invitation_send_attempts(workspace_id,source_hash,created_at);
CREATE INDEX IF NOT EXISTS idx_member_invitation_attempts_retention ON member_invitation_send_attempts(workspace_id,created_at,id);

DROP TRIGGER IF EXISTS member_invitation_create_guard;
CREATE TRIGGER member_invitation_create_guard BEFORE INSERT ON member_invitations BEGIN
  SELECT RAISE(ABORT,'invitation_forbidden') WHERE NOT EXISTS (
    SELECT 1 FROM members m JOIN auth_users a ON a.id=m.auth_id AND a.banned=0
    WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.created_by AND m.auth_id=NEW.created_by_auth_id AND m.is_active=1
      AND (m.role='super_admin' OR (m.role='admin' AND NEW.role='member' AND NEW.job_title='' AND NEW.is_qa_admin=0))
      AND (SELECT count(*) FROM members x WHERE x.workspace_id=m.workspace_id AND x.auth_id=m.auth_id AND x.is_active=1)=1
  );
  SELECT RAISE(ABORT,'invitation_invalid') WHERE NEW.used_at IS NOT NULL OR NEW.revoked_at IS NOT NULL;
  SELECT RAISE(ABORT,'invitation_rate_limited') WHERE
    (SELECT count(*) FROM member_invitations i WHERE i.workspace_id=NEW.workspace_id AND i.created_by=NEW.created_by
      AND i.created_at>strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'-1 day'))>=20;
  SELECT RAISE(ABORT,'invitation_forbidden') WHERE NEW.workspace_id<>'default' AND NOT EXISTS (
    SELECT 1 FROM workspaces WHERE id=NEW.workspace_id AND status='active'
  );
END;

DROP TRIGGER IF EXISTS member_invitation_immutable;
CREATE TRIGGER member_invitation_immutable BEFORE UPDATE ON member_invitations
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.role IS NOT OLD.role OR NEW.job_title IS NOT OLD.job_title OR NEW.is_qa_admin IS NOT OLD.is_qa_admin
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_by_auth_id IS NOT OLD.created_by_auth_id
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.used_at IS NOT NULL AND (NEW.used_at IS NOT OLD.used_at OR NEW.used_member_id IS NOT OLD.used_member_id OR NEW.used_auth_id IS NOT OLD.used_auth_id))
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN SELECT RAISE(ABORT,'invitation_invalid'); END;

DROP TRIGGER IF EXISTS member_invitation_accept_guard;
CREATE TRIGGER member_invitation_accept_guard BEFORE UPDATE OF used_at ON member_invitations
WHEN OLD.used_at IS NULL AND NEW.used_at IS NOT NULL BEGIN
  SELECT RAISE(ABORT,'invitation_invalid') WHERE OLD.revoked_at IS NOT NULL OR OLD.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now');
  SELECT RAISE(ABORT,'invitation_forbidden') WHERE NOT EXISTS (
    SELECT 1 FROM members m JOIN auth_users a ON a.id=m.auth_id AND a.banned=0
    WHERE m.workspace_id=OLD.workspace_id AND m.id=OLD.created_by AND m.auth_id=OLD.created_by_auth_id AND m.is_active=1
      AND (m.role='super_admin' OR (m.role='admin' AND OLD.role='member' AND OLD.job_title='' AND OLD.is_qa_admin=0))
      AND (SELECT count(*) FROM members x WHERE x.workspace_id=m.workspace_id AND x.auth_id=m.auth_id AND x.is_active=1)=1
  );
  SELECT RAISE(ABORT,'invitation_forbidden') WHERE OLD.workspace_id<>'default' AND NOT EXISTS (
    SELECT 1 FROM workspaces WHERE id=OLD.workspace_id AND status='active'
  );
  SELECT RAISE(ABORT,'invitation_member_limit') WHERE EXISTS (
    SELECT 1 FROM workspaces w WHERE w.id=OLD.workspace_id
      AND (SELECT count(*) FROM members m WHERE m.workspace_id=w.id AND m.is_active=1)>=w.member_limit
  );
END;

DROP TRIGGER IF EXISTS member_invitation_attempt_guard;
CREATE TRIGGER member_invitation_attempt_guard BEFORE INSERT ON member_invitation_send_attempts BEGIN
  SELECT RAISE(ABORT,'invitation_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM member_invitations i WHERE i.workspace_id=NEW.workspace_id AND i.id=NEW.invitation_id
      AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>NEW.created_at
      AND (i.workspace_id='default' OR EXISTS(SELECT 1 FROM workspaces w WHERE w.id=i.workspace_id AND w.status='active'))
      AND EXISTS(SELECT 1 FROM members m JOIN auth_users a ON a.id=m.auth_id AND a.banned=0
        WHERE m.workspace_id=i.workspace_id AND m.id=i.created_by AND m.auth_id=i.created_by_auth_id AND m.is_active=1
          AND (m.role='super_admin' OR (m.role='admin' AND i.role='member' AND i.job_title='' AND i.is_qa_admin=0))
          AND (SELECT count(*) FROM members x WHERE x.workspace_id=m.workspace_id AND x.auth_id=m.auth_id AND x.is_active=1)=1)
  );
  SELECT RAISE(ABORT,'invitation_rate_limited') WHERE
    (SELECT count(*) FROM member_invitation_send_attempts x WHERE x.workspace_id=NEW.workspace_id AND x.invitation_id=NEW.invitation_id
      AND x.created_at>strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'-1 day'))>=10
    OR (SELECT count(*) FROM member_invitation_send_attempts x WHERE x.workspace_id=NEW.workspace_id AND x.source_hash=NEW.source_hash
      AND x.created_at>strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'-1 day'))>=100
    OR EXISTS(SELECT 1 FROM member_invitation_send_attempts x WHERE x.workspace_id=NEW.workspace_id AND x.email_hash=NEW.email_hash
      AND x.created_at>strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'-10 minutes'));
END;

DROP TRIGGER IF EXISTS member_invitation_confirmation_immutable;
CREATE TRIGGER member_invitation_confirmation_immutable BEFORE UPDATE ON member_invitation_confirmations
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id OR NEW.invitation_id IS NOT OLD.invitation_id
  OR NEW.token_hash IS NOT OLD.token_hash OR NEW.name IS NOT OLD.name OR NEW.email IS NOT OLD.email
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.used_at IS NOT NULL AND NEW.used_at IS NOT OLD.used_at)
BEGIN SELECT RAISE(ABORT,'invitation_invalid'); END;


-- Every entry point shares the same final-seat check: manual creation, imports,
-- account activation and invitation acceptance. AFTER avoids rejecting an
-- INSERT OR IGNORE / idempotent upsert whose row was not actually added.
DROP TRIGGER IF EXISTS members_active_quota_insert;
CREATE TRIGGER members_active_quota_insert AFTER INSERT ON members
WHEN NEW.is_active=1 BEGIN
  SELECT RAISE(ABORT,'invitation_member_limit') WHERE EXISTS (
    SELECT 1 FROM workspaces w WHERE w.id=NEW.workspace_id
      AND (SELECT count(*) FROM members m WHERE m.workspace_id=NEW.workspace_id AND m.is_active=1)>w.member_limit
  );
END;
DROP TRIGGER IF EXISTS members_active_quota_activation;
CREATE TRIGGER members_active_quota_activation AFTER UPDATE OF is_active ON members
WHEN NEW.is_active=1 AND COALESCE(OLD.is_active,0)<>1 BEGIN
  SELECT RAISE(ABORT,'invitation_member_limit') WHERE EXISTS (
    SELECT 1 FROM workspaces w WHERE w.id=NEW.workspace_id
      AND (SELECT count(*) FROM members m WHERE m.workspace_id=NEW.workspace_id AND m.is_active=1)>w.member_limit
  );
END;
