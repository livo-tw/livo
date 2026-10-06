import { USE_CF_BACKEND } from './apiBase';

/** Same key the Docker manage-member function sets (memberAccounts.ts PASSWORD_CHANGE_FLAG). */
export const PASSWORD_CHANGE_FLAG = 'livo_password_change_required';

type SessionLike = { user?: { user_metadata?: Record<string, unknown> | null } | null } | null | undefined;

/**
 * Self-host: an admin set this login's password (typed, the configured initial
 * password, or a temporary one), so the member chooses their own before using LIVO.
 */
export function passwordChangeRequired(session: SessionLike): boolean {
  return !USE_CF_BACKEND && session?.user?.user_metadata?.[PASSWORD_CHANGE_FLAG] === true;
}
