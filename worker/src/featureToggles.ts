import type { Env } from './env';

/** Server notification guard; keep fallback semantics aligned with the UI resolver. */
export async function approvalsEnabled(env: Env, workspaceId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT COALESCE(
    (SELECT CASE WHEN json_type(value, '$.approvals') IN ('true', 'false')
      THEN json_extract(value, '$.approvals') END
     FROM system_settings WHERE workspace_id = ?1 AND key = 'feature_toggles'),
    EXISTS (SELECT 1 FROM approval_rules WHERE workspace_id = ?1) OR
    EXISTS (SELECT 1 FROM approval_requests WHERE workspace_id = ?1)
  ) AS enabled`).bind(workspaceId).first<{ enabled: number }>();
  return row?.enabled === 1;
}
