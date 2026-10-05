// A member's own Slack link setting, the cloud counterpart of
// supabase/migrations/20261022_slack_link_preferences.sql. The cloud matches a
// Slack user to a member by email each time (qaSlack.ts) and sends direct
// messages by email (functions/slack.ts); both skip a member who turned linking
// off. Only the member changes it, through these two RPCs.
import type { AuthCtx, Env } from './env';
import { isDemoMember } from './env';

export interface SlackLinkStatus { disabled: boolean; mode: 'email'; linked: null }

export async function slackLinkDisabled(env: Env, ws: string, memberId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS hit FROM slack_link_preferences WHERE workspace_id=? AND member_id=? AND linking_disabled=1')
    .bind(ws, memberId).first<{ hit: number }>();
  return !!row;
}

/** The members, among those given, who turned Slack linking off. */
export async function slackLinkDisabledMembers(env: Env, ws: string, memberIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(memberIds)].filter(Boolean);
  if (!ids.length) return new Set();
  const rows = await env.DB.prepare(`SELECT member_id FROM slack_link_preferences WHERE workspace_id=? AND linking_disabled=1 AND member_id IN (${ids.map(() => '?').join(',')})`)
    .bind(ws, ...ids).all<{ member_id: string }>();
  return new Set(rows.results.map(row => row.member_id));
}

export async function handleSlackLinkRpc(env: Env, auth: AuthCtx, fn: 'livo_slack_link_status' | 'livo_slack_link_set', args: Record<string, unknown>): Promise<SlackLinkStatus> {
  const ws = auth.member.workspaceId, me = auth.member.id;
  if (fn === 'livo_slack_link_set') {
    if (typeof args.p_enabled !== 'boolean' || isDemoMember(env, auth)) throw new Error('slack_link_forbidden');
    await env.DB.prepare('INSERT INTO slack_link_preferences(workspace_id,member_id,linking_disabled,updated_at) VALUES(?,?,?,?) ON CONFLICT(workspace_id,member_id) DO UPDATE SET linking_disabled=excluded.linking_disabled,updated_at=excluded.updated_at')
      .bind(ws, me, args.p_enabled ? 0 : 1, new Date().toISOString()).run();
  }
  return { disabled: await slackLinkDisabled(env, ws, me), mode: 'email', linked: null };
}
