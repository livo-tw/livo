/** Shared invitation contract. Tokens grant only the server-stored invitation. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CONFIRMATION_TTL_MS = 60 * 60 * 1000;
export const CONFIRMATION_RESEND_MS = 10 * 60 * 1000;
export const INVITATION_SEND_LIMIT = 10;

export type InvitationRole = 'member' | 'admin' | 'super_admin';
export type InvitationStatus = 'pending' | 'used' | 'revoked' | 'expired';
export interface InvitationGrant { role: InvitationRole; jobTitle: string; isQaAdmin: boolean }
export interface InvitationMetadata extends InvitationGrant {
  id: string; createdBy: string; createdAt: string; expiresAt: string; status: InvitationStatus;
}
export interface MemberInvitePreview extends InvitationGrant { workspaceName: string; expiresAt: string }
export interface MemberConfirmationPreview extends MemberInvitePreview { name: string; email: string }
export interface InvitationScope { workspaceId: string; id: string }
export type InvitationTokenKind = 'invite' | 'confirmation';

export const INVITATION_ERROR_CODES = [
  'invalid_request', 'invalid_token', 'forbidden', 'api_key_forbidden', 'demo_blocked',
  'email_taken', 'member_limit', 'email_not_configured', 'email_send_failed', 'rate_limited',
  'password_invalid', 'server_error',
] as const;
export type InvitationErrorCode = typeof INVITATION_ERROR_CODES[number];

function prefix(kind: InvitationTokenKind): string { return kind === 'invite' ? 'mi1' : 'mc1'; }

export function mintMemberInvitationToken(kind: InvitationTokenKind, workspaceId: string, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ w: workspaceId, i: id }));
  const scope = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix(kind)}.${scope}.${nonce}`;
}

export function parseMemberInvitationToken(raw: unknown, kind: InvitationTokenKind): InvitationScope | null {
  if (typeof raw !== 'string' || raw.length > 1000) return null;
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== prefix(kind) || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) return null;
  try {
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')), c => c.charCodeAt(0));
    const scope: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!scope || typeof scope !== 'object') return null;
    const value = scope as Record<string, unknown>;
    if (Object.keys(value).length !== 2 || typeof value.w !== 'string' || typeof value.i !== 'string'
      || !/^[A-Za-z0-9_-]{1,200}$/.test(value.w) || !/^[A-Za-z0-9_-]{1,200}$/.test(value.i)) return null;
    return { workspaceId: value.w, id: value.i };
  } catch { return null; }
}

export async function hashMemberInvitationToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

export function validateInvitationGrant(body: Record<string, unknown>): InvitationGrant | null {
  const role = body.role ?? 'member';
  const jobTitle = body.jobTitle ?? '';
  const isQaAdmin = body.isQaAdmin ?? false;
  if ((role !== 'member' && role !== 'admin' && role !== 'super_admin')
    || typeof jobTitle !== 'string' || jobTitle.length > 200 || typeof isQaAdmin !== 'boolean'
    || (isQaAdmin && role !== 'member')) return null;
  return { role, jobTitle: jobTitle.trim(), isQaAdmin };
}

export function canIssueInvitation(callerRole: string, grant: InvitationGrant): boolean {
  return callerRole === 'super_admin' || (callerRole === 'admin' && grant.role === 'member' && !grant.jobTitle && !grant.isQaAdmin);
}

export function validateInviteName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name.length >= 1 && name.length <= 80 && !hasControlCharacters(name) ? name : null;
}

function hasControlCharacters(text: string): boolean {
  return Array.from(text).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

export function validateInviteEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && !hasControlCharacters(email) && /^[^\s@,;<>"'()]+@[^\s@,;<>"'()]+\.[a-z0-9-]{2,}$/i.test(email)
    && !email.endsWith('.invalid') ? email : null;
}

export function validateInvitePassword(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length >= 8 && new TextEncoder().encode(raw).length <= 72;
}

export function invitationStatus(row: { used_at?: string | null; revoked_at?: string | null; expires_at: string }, now = Date.now()): InvitationStatus {
  if (row.used_at) return 'used';
  if (row.revoked_at) return 'revoked';
  return Date.parse(row.expires_at) <= now ? 'expired' : 'pending';
}

/** Accept only the explicit action contract; never accept authority from a joiner. */
export function hasOnlyKeys(body: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(body).every(key => keys.includes(key));
}
