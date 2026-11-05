import { USE_CF_BACKEND } from './apiBase';

/** Same key the Docker manage-member function sets (memberAccounts.ts PASSWORD_CHANGE_FLAG). */
export const PASSWORD_CHANGE_FLAG = 'livo_password_change_required';

type SessionLike = { user?: { user_metadata?: Record<string, unknown> | null; app_metadata?: Record<string, unknown> | null } | null } | null | undefined;

/**
 * Self-host: an admin set this login's password (typed, the configured initial
 * password, or a temporary one), so the member chooses their own before using LIVO.
 */
export function passwordChangeRequired(session: SessionLike): boolean {
  if (USE_CF_BACKEND) return false;
  const app = session?.user?.app_metadata;
  return session?.user?.user_metadata?.[PASSWORD_CHANGE_FLAG] === true
    || (app?.livo_external_qa === true && app.livo_external_qa_password_change_required !== false);
}
