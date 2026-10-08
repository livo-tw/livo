import { callFunction } from './callFunction';
import {
  INVITATION_ERROR_CODES, validateInvitationGrant,
  type InvitationMetadata as StoredInvitationMetadata, type MemberInvitePreview, type MemberConfirmationPreview,
  type InvitationGrant,
} from './memberInvitationsCore';

export interface InvitationError { code: string }
export type InvitationMetadata = Omit<StoredInvitationMetadata, 'status'> & {
  status: StoredInvitationMetadata['status'] | 'unavailable';
};
export type InvitationResult<T> = { data: T; error: null } | { data: null; error: InvitationError };
export interface InvitationSession {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string };
}
export interface CreatedInvitation { invitation: InvitationMetadata; inviteToken: string; inviteUrl: string }
export type MemberInvitationLink = { kind: 'invite' | 'confirmation'; token: string };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const date = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
const grant = (value: unknown): value is InvitationGrant => record(value)
  && typeof value.role === 'string' && typeof value.jobTitle === 'string' && typeof value.isQaAdmin === 'boolean'
  && validateInvitationGrant(value) !== null;
const metadata = (value: unknown): value is InvitationMetadata => grant(value) && record(value)
  && text(value.id) && text(value.createdBy) && date(value.createdAt) && date(value.expiresAt)
  && ['pending', 'used', 'revoked', 'expired', 'unavailable'].includes(String(value.status));
const preview = (value: unknown): value is MemberInvitePreview => grant(value) && record(value)
  && text(value.workspaceName) && date(value.expiresAt);
const confirmation = (value: unknown): value is MemberConfirmationPreview => preview(value) && record(value)
  && text(value.name) && text(value.email);
const session = (value: unknown): value is InvitationSession => record(value)
  && text(value.access_token) && text(value.refresh_token) && record(value.user)
  && text(value.user.id) && text(value.user.email);

async function request<T>(body: unknown, guard: (value: unknown) => value is T): Promise<InvitationResult<T>> {
  try {
    const result = await callFunction<unknown>('member-invitations', body);
    if (!result.ok) {
      const candidate = record(result.data) && typeof result.data.error === 'string' ? result.data.error : 'server_error';
      const code = INVITATION_ERROR_CODES.some(known => known === candidate) ? candidate : 'server_error';
      return { data: null, error: { code } };
    }
    if (!guard(result.data)) return { data: null, error: { code: 'invalid_response' } };
    return { data: result.data, error: null };
  } catch (error) {
    // Tokens and form contents must never appear in diagnostic output.
    console.warn('[memberInvitations] Request failed', { kind: error instanceof Error ? error.name : 'unknown' });
    return { data: null, error: { code: 'network_failed' } };
  }
}

export const listMemberInvitations = () => request({ action: 'list' },
  (value): value is { invitations: InvitationMetadata[] } => record(value)
    && Array.isArray(value.invitations) && value.invitations.every(metadata));
export const createMemberInvitation = (value: InvitationGrant) => request({ action: 'create', ...value },
  (value): value is CreatedInvitation => record(value) && metadata(value.invitation) && text(value.inviteToken) && text(value.inviteUrl));
export const revokeMemberInvitation = (invitationId: string) => request({ action: 'revoke', invitationId },
  (value): value is { success: true } => record(value) && value.success === true);
export const previewMemberInvitation = (inviteToken: string) => request({ action: 'preview', inviteToken }, preview);
export const previewMemberConfirmation = (confirmationToken: string) => request({ action: 'confirmation_preview', confirmationToken }, confirmation);
export const acceptMemberInvitation = (confirmationToken: string, password: string) => request({ action: 'accept', confirmationToken, password },
  (value): value is { success: true; session: InvitationSession | null } => record(value) && value.success === true
    && (value.session === null || session(value.session)));
export const joinMemberInvitation = (inviteToken: string, name: string, email: string, password: string) => request({ action: 'accept_invite', inviteToken, name, email, password },
  (value): value is { success: true; session: InvitationSession | null } => record(value) && value.success === true
    && (value.session === null || session(value.session)));

export function invitationErrorKey(error: InvitationError): string {
  const known = [...INVITATION_ERROR_CODES, 'network_failed', 'invalid_response'];
  return `memberInvite.errors.${known.includes(error.code) ? error.code : 'server_error'}`;
}

/** Keep link credentials in the fragment, with query support for older links. */
export function readMemberInvitationLink(hash: string, search = ''): MemberInvitationLink | null {
  const values = new URLSearchParams(hash.replace(/^#/, '') || search.replace(/^\?/, ''));
  const invite = values.getAll('invite');
  const confirmation = values.getAll('confirmation');
  if (invite.length + confirmation.length !== 1) return null;
  const kind = invite.length ? 'invite' : 'confirmation';
  const token = (invite.length ? invite : confirmation)[0];
  return token && token.length <= 1000 ? { kind, token } : null;
}

export function memberInvitationUrl(inviteToken: string, serverUrl?: string): string {
  const fallback = new URL(`${import.meta.env.BASE_URL}join`, window.location.origin);
  let url = fallback;
  if (serverUrl) {
    try {
      const candidate = new URL(serverUrl);
      if (candidate.protocol === 'https:' || candidate.protocol === 'http:') url = candidate;
    } catch {
      console.warn('[memberInvitations] Invalid invitation URL; using app origin');
    }
  }
  url.search = '';
  url.hash = new URLSearchParams({ invite: inviteToken }).toString();
  return url.toString();
}

/** A recovery login carries no invitation credential or password. */
export function navigateToInvitationLogin(): void {
  window.location.assign(`${import.meta.env.BASE_URL}auth`);
}
