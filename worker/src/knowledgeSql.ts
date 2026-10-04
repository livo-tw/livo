import type { AuthCtx } from './env';
import { DEFAULT_WORKSPACE } from './env';
import type { KnowledgeAction } from './knowledgeAccess';
import { liveMemberSql } from './liveMember';

/** A correlated SQL predicate, so ACL checks and row reads/writes are atomic. */
export function knowledgePermissionSql(pageExpression: string, action: KnowledgeAction, auth: AuthCtx): { sql: string; params: string[] } {
  const ws = auth.member.workspaceId || DEFAULT_WORKSPACE, live = liveMemberSql(auth, 'm');
  const match = (key: string) => `(EXISTS (SELECT 1 FROM json_each(a.access_policy, '$.${key}.roles') WHERE value=m.role)
    OR EXISTS (SELECT 1 FROM json_each(a.access_policy, '$.${key}.positions') WHERE value=m.job_title)
    OR EXISTS (SELECT 1 FROM json_each(a.access_policy, '$.${key}.member_ids') WHERE value=m.id))`;
  return { sql: `EXISTS (WITH RECURSIVE ancestry(id,parent_id,access_policy,admin_only,is_archived,private_draft_owner_id,depth) AS (
      SELECT kb_acl_seed.id,kb_acl_seed.parent_id,kb_acl_seed.access_policy,kb_acl_seed.admin_only,kb_acl_seed.is_archived,kb_acl_seed.private_draft_owner_id,1
        FROM kb_pages AS kb_acl_seed WHERE kb_acl_seed.workspace_id=? AND kb_acl_seed.id=${pageExpression}
      UNION ALL SELECT p.id,p.parent_id,p.access_policy,p.admin_only,p.is_archived,p.private_draft_owner_id,a.depth+1
        FROM kb_pages p JOIN ancestry a ON p.id=a.parent_id WHERE p.workspace_id=? AND a.depth<4
    ) SELECT 1 FROM members m WHERE ${live.sql} AND m.role IN ('member','admin','super_admin')
    AND EXISTS (SELECT 1 FROM ancestry WHERE parent_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM ancestry a WHERE a.depth>3 OR (a.private_draft_owner_id IS NOT NULL AND a.private_draft_owner_id<>m.id) OR CASE WHEN json_valid(a.access_policy)=0 THEN 1
      WHEN json_extract(a.access_policy,'$.mode')='inherit' THEN 0
      WHEN json_extract(a.access_policy,'$.mode')='custom' THEN NOT (${match('view')}${action === 'view' ? '' : ` AND ${match(action)}`}) ELSE 1 END
      ${action === 'view' ? '' : `OR a.is_archived=1${action === 'edit' ? " OR (a.admin_only=1 AND m.role NOT IN ('admin','super_admin'))" : ''}`})
  )`, params: [ws, ws, ...live.params] };
}
