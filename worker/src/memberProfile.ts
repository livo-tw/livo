// Which members columns a non-super_admin may change, for the members SPECIAL
// write rule in db.ts. Mirrors public.livo_members_update_guard() on the
// Docker build (supabase/migrations/20261001_member_avatar_self_edit.sql).
//
//   admin  → theme / sort_order on any row; auth_id on their own row only
//   member → theme / auth_id on their own row
//   anyone → avatar / color (the round badge) on their own row only
//
// theme and auth_id must stay self-writable: the login linking flow depends on
// them (App.tsx / useAuthState.ts).

const MEMBERS_ADMIN_COLS = new Set(['theme', 'auth_id', 'sort_order']);
const MEMBERS_SELF_COLS = new Set(['theme', 'auth_id']);
const MEMBER_PROFILE_COLS = new Set(['avatar', 'color']);

/** Badge text: not blank, at most 16 code points (the UI keeps it to 2 characters). */
export function isValidMemberAvatar(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0 && Array.from(v).length <= 16;
}

/** Badge colour: #RRGGBB. */
export function isValidMemberColor(v: unknown): boolean {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

/**
 * allow   → run the update as sent
 * own-row → run it only against the caller's own row
 * deny    → a column the caller may not change
 * invalid → avatar / color is malformed
 */
export type MembersUpdateDecision = 'allow' | 'own-row' | 'deny' | 'invalid';

export function decideMembersUpdate(rank: number, patch: Record<string, unknown>): MembersUpdateDecision {
  if (patch.is_qa_admin !== undefined && typeof patch.is_qa_admin !== 'boolean') return 'invalid';
  if (patch.job_title !== undefined && (typeof patch.job_title !== 'string' || patch.job_title.length > 200)) return 'invalid';
  if (rank >= 2) return 'allow'; // super_admin
  const cols = Object.keys(patch).filter((k) => patch[k] !== undefined);
  const base = rank >= 1 ? MEMBERS_ADMIN_COLS : MEMBERS_SELF_COLS;
  if (cols.some((c) => !base.has(c) && !MEMBER_PROFILE_COLS.has(c))) return 'deny';
  if (cols.includes('avatar') && !isValidMemberAvatar(patch.avatar)) return 'invalid';
  if (cols.includes('color') && !isValidMemberColor(patch.color)) return 'invalid';
  const touchesProfile = cols.some((c) => MEMBER_PROFILE_COLS.has(c));
  return rank === 0 || touchesProfile || cols.includes('auth_id') ? 'own-row' : 'allow';
}
