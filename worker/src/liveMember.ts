/**
 * Live caller identity, shared by every path that re-checks its actor inside
 * its own SQL (task writes and planning, task work, releases, knowledge reads,
 * writes, work commands, workflow, preferences and imports).
 *
 * - A browser session (JWT) proves an auth_users login. It is live while the
 *   caller's members row in the caller's workspace is active and still linked
 *   to that login (members.auth_id = sub).
 * - A personal API key (PAT; auth.userId 'pat:<token id>', see auth.ts) proves
 *   an api_tokens row. It is live while that row is unrevoked and bound to the
 *   same active member in the same workspace, and the member's linked login,
 *   if any, is not banned.
 *
 * Either way the predicate selects the member's own row, so a key inherits
 * exactly that member's role, job title and page access, never more.
 */
import type { AuthCtx, Env } from './env';
import { DEFAULT_WORKSPACE } from './env';

const PAT_USER_PREFIX = 'pat:';

export function isPatCaller(auth: Pick<AuthCtx, 'userId'>): boolean {
  return auth.userId.startsWith(PAT_USER_PREFIX);
}

export type LiveMemberOptions = {
  /** Also require the linked login to be unbanned and linked to exactly one
   *  active member of the workspace: the identity rule the command tables'
   *  triggers enforce. A key whose member has no login skips only the login
   *  part; it can still never act for another member. */
  strict?: boolean;
};

/**
 * Correlated SQL predicate over the members row `alias`: it is the caller, in
 * the caller's workspace, active and still bound to the presented credential.
 * Params follow placeholder order; embed the predicate where the row is in scope.
 */
export function liveMemberSql(auth: AuthCtx, alias = 'm', { strict = false }: LiveMemberOptions = {}): { sql: string; params: string[] } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('invalid_member_alias');
  const ws = auth.member.workspaceId || DEFAULT_WORKSPACE;
  const row = `${alias}.workspace_id=? AND ${alias}.id=? AND ${alias}.is_active=1`;
  const oneMember = `(SELECT count(*) FROM members live_x WHERE live_x.workspace_id=${alias}.workspace_id AND live_x.auth_id=${alias}.auth_id AND live_x.is_active=1)=1`;
  if (isPatCaller(auth)) {
    const token = `EXISTS(SELECT 1 FROM api_tokens live_t WHERE live_t.id=? AND live_t.member_id=${alias}.id
      AND live_t.workspace_id=${alias}.workspace_id AND live_t.revoked_at IS NULL)`;
    const unbanned = `NOT EXISTS(SELECT 1 FROM auth_users live_u WHERE live_u.id=${alias}.auth_id AND COALESCE(live_u.banned,0)<>0)`;
    return {
      sql: `${row} AND ${token} AND ${unbanned}${strict ? ` AND (${alias}.auth_id IS NULL OR ${oneMember})` : ''}`,
      params: [ws, auth.member.id, auth.userId.slice(PAT_USER_PREFIX.length)],
    };
  }
  const login = strict
    ? ` AND EXISTS(SELECT 1 FROM auth_users live_u WHERE live_u.id=${alias}.auth_id AND COALESCE(live_u.banned,0)=0) AND ${oneMember}`
    : '';
  return { sql: `${row} AND ${alias}.auth_id=?${login}`, params: [ws, auth.member.id, auth.userId] };
}

export type LiveMember = { id: string; role: string; job_title: string; is_active: number; auth_id: string | null };

/** The caller's live members row, or null when the credential no longer maps to it. */
export async function liveMember(env: Pick<Env, 'DB'>, auth: AuthCtx, options: LiveMemberOptions = {}): Promise<LiveMember | null> {
  const live = liveMemberSql(auth, 'm', options);
  return env.DB.prepare(`SELECT m.id,m.role,COALESCE(m.job_title,'') AS job_title,m.is_active,m.auth_id FROM members m WHERE ${live.sql}`)
    .bind(...live.params).first<LiveMember>();
}

/**
 * The login id recorded by command tables whose triggers re-check
 * `members.auth_id = NEW.auth_id` (task work, knowledge work, releases, QA).
 * A session records its own subject. A key records its member's linked login
 * after the live key check, or null (refuse the command) when the key is no
 * longer live or the member has no login: those triggers only accept logins.
 */
export async function commandAuthId(env: Pick<Env, 'DB'>, auth: AuthCtx): Promise<string | null> {
  if (!isPatCaller(auth)) return auth.userId;
  return (await liveMember(env, auth, { strict: true }))?.auth_id ?? null;
}
