import type { Env } from './env';

/** A saved mapping is trusted only while both the recipient and its issuer are
 * live. An email match never proves ownership of a direct-registration email. */
export async function trustedSlackRecipients(env: Env, workspace: string, member: string, team: string): Promise<Array<{platform_user_id: string}>> {
  const rows = await env.DB.prepare(`SELECT b.platform_user_id FROM external_account_bindings b
    JOIN members m ON m.workspace_id=b.workspace_id AND m.id=b.member_id
    JOIN auth_users a ON a.id=m.auth_id AND a.banned=0
    WHERE b.workspace_id=? AND b.member_id=? AND b.platform='slack' AND b.platform_team_id=?
      AND b.is_verified=1 AND b.reconfirm_required=0 AND m.is_active=1
      AND (b.verified_by='email' AND m.email_identity_verified=1
        OR b.verified_by='admin' AND EXISTS(SELECT 1 FROM members issuer
          WHERE issuer.workspace_id=b.workspace_id AND issuer.id=b.verified_by_member_id
            AND issuer.role='super_admin' AND issuer.is_active=1))
      AND NOT EXISTS(SELECT 1 FROM slack_link_preferences pref WHERE pref.workspace_id=b.workspace_id
        AND pref.member_id=b.member_id AND pref.linking_disabled=1) LIMIT 2`).bind(workspace, member, team)
    .all<{platform_user_id: string}>();
  return rows.results;
}
