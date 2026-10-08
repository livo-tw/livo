import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@/lib/callFunction', () => ({ callFunction: mocks.call }));
import {
  acceptMemberInvitation, memberInvitationUrl, previewMemberInvitation, readMemberInvitationLink,
  requestMemberConfirmation,
} from '@/lib/memberInvitations';

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());
describe('invitation client boundaries', () => {
  it('rejects ambiguous or empty credentials and reads fragment and legacy links', () => {
    expect(readMemberInvitationLink('#invite=first&confirmation=second')).toBeNull();
    expect(readMemberInvitationLink('#invite=first&invite=second')).toBeNull();
    expect(readMemberInvitationLink('#invite=')).toBeNull();
    expect(readMemberInvitationLink('#confirmation=example')).toEqual({ kind: 'confirmation', token: 'example' });
    expect(readMemberInvitationLink('', '?invite=example')).toEqual({ kind: 'invite', token: 'example' });
  });
  it('uses the app base and places credentials in fragments for HTTP links', () => {
    vi.stubEnv('BASE_URL', '/demo/');
    expect(new URL(memberInvitationUrl('example')).pathname).toBe('/demo/join');
    expect(memberInvitationUrl('example', 'http://example.com/join?invite=legacy')).toBe('http://example.com/join#invite=example');
    expect(new URL(memberInvitationUrl('example', 'javascript:example')).protocol).toBe('http:');
  });
  it('does not claim sent email from malformed or unknown successful responses', async () => {
    mocks.call.mockResolvedValue({ ok: true, status: 200, data: { success: true } });
    expect(await requestMemberConfirmation('example', 'Alex', 'alex@example.com')).toEqual({ data: null, error: { code: 'invalid_response' } });
  });
  it('rejects elevated grants inconsistent with QA membership before displaying them', async () => {
    mocks.call.mockResolvedValue({ ok: true, status: 200, data: { role: 'super_admin', isQaAdmin: true, jobTitle: '', workspaceName: 'Example', expiresAt: '2099-10-08T12:00:00Z' } });
    expect((await previewMemberInvitation('example')).error?.code).toBe('invalid_response');
  });
  it('handles thrown network failures without leaking the raw exception to the UI', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.call.mockRejectedValue(new Error('example request internals'));
    expect((await previewMemberInvitation('example')).error?.code).toBe('network_failed');
    expect(log).toHaveBeenCalledWith('[memberInvitations] Request failed', { kind: 'Error' });
    log.mockRestore();
  });
  it('accepts explicit joined-without-session and rejects a malformed login session', async () => {
    mocks.call.mockResolvedValueOnce({ ok: true, status: 200, data: { success: true, session: null } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { success: true, session: { access_token: 'example' } } });
    expect((await acceptMemberInvitation('example', 'example-password')).data).toEqual({ success: true, session: null });
    expect((await acceptMemberInvitation('example', 'example-password')).error?.code).toBe('invalid_response');
  });
});
