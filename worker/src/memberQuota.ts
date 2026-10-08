import type { Env } from './env';

/** A database quota failure is expected contention, not an SQL diagnostic to
 * expose to a caller. Both direct writes and invitation batches use it. */
export function isMemberLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('invitation_member_limit');
}

export async function memberLimitFailure(env: Pick<Env, 'DB'>, workspaceId: string): Promise<{
  error: 'member_limit'; code: 'member_limit'; message: string;
}> {
  let limit: number | undefined;
  try {
    limit = (await env.DB.prepare('SELECT member_limit FROM workspaces WHERE id=?')
      .bind(workspaceId).first<{ member_limit: number }>())?.member_limit;
  } catch { /* Keep the original capacity failure readable during an outage. */ }
  const suffix = limit === undefined ? '' : `（${limit} 人）`;
  return { error: 'member_limit', code: 'member_limit',
    message: `成員數已達團隊上限${suffix}。需要更多名額請聯繫 service@livo-tw.com` };
}
