import type { Env } from './env';
import type { ChangeEvent } from './protocol';

/** Trusted handshake context; neither channel names nor client bindings grant access. */
export interface RealtimeIdentity {
  userId: string;
  memberId: string;
  workspaceId: string;
  email: string;
  expiresAt: number;
}

export function realtimeIdentity(headers: Headers): RealtimeIdentity | null {
  const userId = headers.get('x-auth-user') || '';
  const memberId = headers.get('x-auth-member') || '';
  const workspaceId = headers.get('x-auth-workspace') || '';
  const email = headers.get('x-auth-email') || '';
  const expiresAt = Number(headers.get('x-auth-exp'));
  return userId && memberId && workspaceId && email && Number.isSafeInteger(expiresAt) && expiresAt > 0
    ? { userId, memberId, workspaceId, email, expiresAt } : null;
}

/** Always read live identity: a DO must not inherit the Worker's short member cache. */
export async function realtimeIdentityActive(env: Pick<Env, 'DB'>, identity: RealtimeIdentity, now: () => number = Date.now): Promise<boolean> {
  const unexpired = () => identity.expiresAt > Math.floor(now() / 1000);
  if (!unexpired()) return false;
  const row = await env.DB.prepare(`SELECT m.id FROM members m JOIN auth_users u ON u.id=m.auth_id
    WHERE m.workspace_id=? AND m.id=? AND m.auth_id=? AND m.is_active=1 AND COALESCE(u.banned,0)=0
      AND m.email=? COLLATE NOCASE AND u.email=? COLLATE NOCASE
      AND (SELECT count(*) FROM members linked WHERE linked.workspace_id=m.workspace_id
        AND linked.auth_id=m.auth_id AND linked.is_active=1)=1`)
    .bind(identity.workspaceId, identity.memberId, identity.userId, identity.email, identity.email).first();
  // A slow D1 read must not turn a credential that expired while waiting valid.
  return !!row && unexpired();
}

/** All live subscribers, including administrators, receive only their own notices. */
export function realtimeEventForMember(event: ChangeEvent, identity: RealtimeIdentity): ChangeEvent | null {
  const current = event.new ?? event.old;
  if (current?.workspace_id !== undefined && current.workspace_id !== identity.workspaceId) return null;
  if (event.table.startsWith('kb_')) return { ...event, new: {}, old: null };
  if (event.table !== 'notifications') return event;
  if (current?.recipient_id !== identity.memberId) return null;
  // A privileged restore/re-address may have an old row belonging to someone else.
  return { ...event, old: event.old?.recipient_id === identity.memberId ? event.old : null };
}
