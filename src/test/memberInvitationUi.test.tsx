import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ call: vi.fn(), setSession: vi.fn(), getSession: vi.fn(), signOut: vi.fn(), copy: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/callFunction', () => ({ callFunction: mocks.call }));
vi.mock('@/lib/clipboard', () => ({ copyText: mocks.copy }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { setSession: mocks.setSession, getSession: mocks.getSession, signOut: mocks.signOut } } }));
vi.mock('sonner', () => ({ toast: { success: mocks.toast, error: mocks.toast } }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string) => key, i18n: { language: 'en' },
}) }));

import Join from '@/pages/Join';
import AddMemberModal from '@/components/member-manage/AddMemberModal';
import * as invitationClient from '@/lib/memberInvitations';

const preview = { workspaceName: 'Example team', role: 'member', jobTitle: 'Designer', isQaAdmin: false, expiresAt: '2099-10-08T12:00:00Z' };
const invitation = { id: 'invite-example', createdBy: 'admin-example', createdAt: '2026-10-08T12:00:00Z', expiresAt: preview.expiresAt, role: 'member', jobTitle: '', isQaAdmin: false, status: 'pending' };
const ok = (data: unknown) => ({ ok: true, status: 200, data });
const failed = (error: string) => ({ ok: false, status: 400, data: { error } });
const confirmation = { ...preview, name: 'Alex Example', email: 'alex@example.com' };
const renderJoin = (kind = 'invite') => render(<MemoryRouter initialEntries={[`/join#${kind}=example-token`]}><Join /></MemoryRouter>);
const fillIdentity = async () => {
  fireEvent.change(await screen.findByLabelText('memberInvite.nameLabel'), { target: { value: ' Alex Example ' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'alex@example.com' } });
};
const fillPassword = async (password = 'example-password', confirm = password) => {
  fireEvent.change(await screen.findByLabelText('setPassword.passwordLabel'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('setPassword.confirmLabel'), { target: { value: confirm } });
};
const JoinWithNavigation = () => {
  const navigate = useNavigate();
  return <><button onClick={() => navigate('/join#invite=second-example')}>Open next invitation</button><Join /></>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.call.mockReset();
  mocks.copy.mockResolvedValue(true);
  mocks.getSession.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  mocks.signOut.mockReset().mockResolvedValue({ error: null });
  mocks.setSession.mockResolvedValue({ data: { session: { user: { id: 'user-example' } } }, error: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('public member invitations', () => {
  it('requests email confirmation before exposing password fields or changing a session', async () => {
    mocks.call.mockResolvedValueOnce(ok(preview)).mockResolvedValueOnce(ok({ sent: true }));
    renderJoin();
    await fillIdentity();
    expect(screen.queryByLabelText('setPassword.passwordLabel')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.sendConfirmation' }));
    expect(await screen.findByText('memberInvite.confirmationSent')).toBeInTheDocument();
    expect(mocks.call).toHaveBeenLastCalledWith('member-invitations', { action: 'request_confirmation', inviteToken: 'example-token', name: 'Alex Example', email: 'alex@example.com' });
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'memberInvite.resend' })).toBeDisabled();
  });

  it('shows missing email configuration without claiming an email was sent', async () => {
    mocks.call.mockResolvedValueOnce(ok(preview)).mockResolvedValueOnce(failed('email_not_configured'));
    renderJoin();
    await fillIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.sendConfirmation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('memberInvite.errors.email_not_configured');
    expect(screen.queryByText('memberInvite.confirmationSent')).toBeNull();
    expect(screen.getByRole('button', { name: 'memberInvite.sendConfirmation' })).toBeEnabled();
  });

  it('allows correcting an email typo immediately while retaining cooldowns for each previously sent address', async () => {
    mocks.call.mockResolvedValueOnce(ok(preview)).mockResolvedValueOnce(ok({ sent: true })).mockResolvedValueOnce(ok({ sent: true }));
    renderJoin();
    await fillIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.sendConfirmation' }));
    await screen.findByText('memberInvite.confirmationSent');
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.editDetails' }));
    expect(screen.getByRole('button', { name: 'memberInvite.sendConfirmation' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'corrected@example.com' } });
    expect(screen.getByRole('button', { name: 'memberInvite.sendConfirmation' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.sendConfirmation' }));
    await screen.findByText('memberInvite.confirmationSent');
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.editDetails' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' ALEX@example.com ' } });
    expect(screen.getByRole('button', { name: 'memberInvite.sendConfirmation' })).toBeDisabled();
    expect(mocks.call).toHaveBeenCalledTimes(3);
  });

  it('ignores an old send result after opening a different invitation in the same page', async () => {
    let resolveSend!: (value: ReturnType<typeof ok>) => void;
    mocks.call.mockResolvedValueOnce(ok(preview)).mockImplementationOnce(() => new Promise(resolve => { resolveSend = resolve; })).mockResolvedValueOnce(ok(preview));
    render(<MemoryRouter initialEntries={['/join#invite=example-token']}><JoinWithNavigation /></MemoryRouter>);
    await fillIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.sendConfirmation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open next invitation' }));
    expect(await screen.findByLabelText('memberInvite.nameLabel')).toHaveValue('');
    resolveSend(ok({ sent: true }));
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(3));
    expect(screen.queryByText('memberInvite.confirmationSent')).toBeNull();
    expect(screen.getByRole('button', { name: 'memberInvite.sendConfirmation' })).toBeEnabled();
  });

  it('uses a safe unknown-error message and leaves the form recoverable', async () => {
    mocks.call.mockResolvedValueOnce(ok(preview)).mockResolvedValueOnce(failed('internal-diagnostic-example'));
    renderJoin();
    await fillIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.sendConfirmation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('memberInvite.errors.server_error');
    expect(screen.queryByText('internal-diagnostic-example')).toBeNull();
    expect(screen.queryByText('memberInvite.confirmationSent')).toBeNull();
  });

  it('shows invalid/expired invitations without offering a registration form', async () => {
    mocks.call.mockResolvedValue(failed('invalid_token'));
    renderJoin();
    expect(await screen.findByRole('alert')).toHaveTextContent('memberInvite.errors.invalid_token');
    expect(screen.queryByRole('button', { name: 'memberInvite.sendConfirmation' })).toBeNull();
    expect(screen.getByRole('link', { name: 'setPassword.backToLogin' })).toHaveAttribute('href', `${import.meta.env.BASE_URL}auth`);
  });

  it('lets an invitation preview recover from a network error through the retry button', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.call.mockRejectedValueOnce(new Error('example network failure')).mockResolvedValueOnce(ok(preview));
    renderJoin();
    expect(await screen.findByRole('alert')).toHaveTextContent('memberInvite.errors.network_failed');
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(await screen.findByLabelText('memberInvite.nameLabel')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mocks.call).toHaveBeenCalledTimes(2);
    expect(mocks.setSession).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('blocks password mismatch and passwords over the UTF-8 byte limit', async () => {
    mocks.call.mockResolvedValue(ok(confirmation));
    renderJoin('confirmation');
    await fillPassword('example-password', 'different-password');
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.joinButton' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('setPassword.mismatch');
    await fillPassword('密'.repeat(25));
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.joinButton' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('memberInvite.errors.password_invalid');
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });

  it('accepts only a password and the confirmation token, preserving server-provided grants', async () => {
    const session = { access_token: 'access-example', refresh_token: 'refresh-example', user: { id: 'auth-example', email: confirmation.email } };
    mocks.call.mockResolvedValueOnce(ok(confirmation)).mockResolvedValueOnce(ok({ success: true, session }));
    renderJoin('confirmation');
    await fillPassword();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('Designer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.joinButton' }));
    expect(await screen.findByText('memberInvite.joined')).toBeInTheDocument();
    expect(mocks.call).toHaveBeenLastCalledWith('member-invitations', { action: 'accept', confirmationToken: 'example-token', password: 'example-password' });
    expect(mocks.setSession).toHaveBeenCalledWith(session);
    expect(screen.getByRole('link', { name: 'memberInvite.continueToApp' })).toHaveAttribute('href', import.meta.env.BASE_URL);
  });

  it('treats account creation without a login session as joined and directs the user to sign in', async () => {
    mocks.call.mockResolvedValueOnce(ok(confirmation)).mockResolvedValueOnce(ok({ success: true, session: null }));
    renderJoin('confirmation');
    await fillPassword();
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.joinButton' }));
    expect(await screen.findByText('memberInvite.signInRequired')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'memberInvite.signIn' })).toHaveAttribute('href', `${import.meta.env.BASE_URL}auth`);
    expect(screen.queryByRole('button', { name: 'memberInvite.joinButton' })).toBeNull();
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it.each(['network', 'malformed'])('keeps login recovery when an accept result is lost (%s) and its retry returns an invalid token', async failure => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mocks.call.mockResolvedValueOnce(ok(confirmation));
      if (failure === 'network') mocks.call.mockRejectedValueOnce(new TypeError('isolated response lost'));
      else mocks.call.mockResolvedValueOnce(ok(null));
      mocks.call.mockResolvedValueOnce(failed('invalid_token'));
      renderJoin('confirmation');
      await fillPassword();
      fireEvent.click(screen.getByRole('button', { name: 'memberInvite.joinButton' }));
      expect(await screen.findByText('memberInvite.resultUnknownTitle')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'memberInvite.resultUnknownLogin' })).toHaveAttribute('href', `${import.meta.env.BASE_URL}auth`);
      expect(screen.queryByText('memberInvite.joined')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'memberInvite.joinButton' }));
      expect(await screen.findByText('memberInvite.resultUnknownLinkUnavailable')).toBeInTheDocument();
      expect(screen.getByText('memberInvite.resultUnknownTitle')).toBeInTheDocument();
      const login = screen.getByRole('link', { name: 'memberInvite.resultUnknownLogin' });
      expect(login).toHaveAttribute('href', `${import.meta.env.BASE_URL}auth`);
      expect(login.getAttribute('href')).not.toContain('example-password');
      expect(login.getAttribute('href')).not.toContain('example-token');
      expect(screen.queryByRole('button', { name: 'memberInvite.joinButton' })).toBeNull();
      expect(mocks.setSession).not.toHaveBeenCalled();
      expect(mocks.call).toHaveBeenCalledTimes(3);
    } finally { log.mockRestore(); }
  });

  it('clears uncertain join context when opening another invitation', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      mocks.call.mockResolvedValueOnce(ok(confirmation)).mockRejectedValueOnce(new TypeError('isolated response lost')).mockResolvedValueOnce(ok(preview));
      render(<MemoryRouter initialEntries={['/join#confirmation=example-token']}><JoinWithNavigation /></MemoryRouter>);
      await fillPassword();
      fireEvent.click(screen.getByRole('button', { name: 'memberInvite.joinButton' }));
      await screen.findByText('memberInvite.resultUnknownTitle');
      fireEvent.click(screen.getByRole('button', { name: 'Open next invitation' }));
      await screen.findByLabelText('memberInvite.nameLabel');
      expect(screen.queryByText('memberInvite.resultUnknownTitle')).toBeNull();
      expect(screen.queryByRole('link', { name: 'memberInvite.resultUnknownLogin' })).toBeNull();
    } finally { log.mockRestore(); }
  });

  it('switches an existing account only after the user explicitly chooses recovery login', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const navigate = vi.spyOn(invitationClient, 'navigateToInvitationLogin').mockImplementation((): void => undefined);
    mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'existing-example' } } }, error: null });
    mocks.call.mockResolvedValueOnce(ok(confirmation)).mockRejectedValueOnce(new TypeError('isolated response lost'));
    renderJoin('confirmation');
    await fillPassword();
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.joinButton' }));
    const login = await screen.findByRole('link', { name: 'memberInvite.resultUnknownSwitchAccount' });
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(login);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith();
  });

  it.each(['error', 'throw'])('keeps recovery visible when local sign-out fails (%s), then allows retry', async failure => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const navigate = vi.spyOn(invitationClient, 'navigateToInvitationLogin').mockImplementation((): void => undefined);
    mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'existing-example' } } }, error: null });
    if (failure === 'error') mocks.signOut.mockResolvedValueOnce({ error: { message: 'isolated logout failure' } });
    else mocks.signOut.mockRejectedValueOnce(new TypeError('isolated logout failure'));
    mocks.call.mockResolvedValueOnce(ok(confirmation)).mockRejectedValueOnce(new TypeError('isolated response lost'));
    renderJoin('confirmation');
    await fillPassword();
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.joinButton' }));
    fireEvent.click(await screen.findByRole('link', { name: 'memberInvite.resultUnknownSwitchAccount' }));
    expect(await screen.findByText('memberInvite.recoveryLoginFailed')).toBeInTheDocument();
    expect(screen.getByText('memberInvite.resultUnknownTitle')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(mocks.setSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('link', { name: 'memberInvite.resultUnknownSwitchAccount' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(mocks.signOut).toHaveBeenCalledTimes(2);
    expect(mocks.signOut.mock.calls.every(args => args[0].scope === 'local')).toBe(true);
  });

  it('opens the next invitation after a previous successful join without retaining old success or form values', async () => {
    mocks.call.mockResolvedValueOnce(ok(confirmation)).mockResolvedValueOnce(ok({ success: true, session: null })).mockResolvedValueOnce(ok(preview));
    render(<MemoryRouter initialEntries={['/join#confirmation=example-token']}><JoinWithNavigation /></MemoryRouter>);
    await fillPassword();
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.joinButton' }));
    await screen.findByText('memberInvite.joined');
    fireEvent.click(screen.getByRole('button', { name: 'Open next invitation' }));
    expect(await screen.findByLabelText('memberInvite.nameLabel')).toHaveValue('');
    expect(screen.queryByText('memberInvite.joined')).toBeNull();
    expect(screen.getByLabelText('Email')).toHaveValue('');
  });

  it('does not offer to retry final registration when the verified email already belongs to an account', async () => {
    mocks.call.mockResolvedValueOnce(ok(confirmation)).mockResolvedValueOnce(failed('email_taken'));
    renderJoin('confirmation');
    await fillPassword();
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.joinButton' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('memberInvite.errors.email_taken');
    expect(screen.queryByRole('button', { name: 'memberInvite.joinButton' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'common.retry' })).toBeNull();
  });
});

describe('add member invitation tab', () => {
  const renderModal = (canEditJobTitle = false) => render(<AddMemberModal show onClose={vi.fn()} form={{ email: '', name: '', role: 'member', jobTitle: '', password: '' }} setForm={vi.fn()} jobTitleRef={{ current: null }} jobTitleOpen={false} setJobTitleOpen={vi.fn()} filteredJobTitles={[]} onSubmit={vi.fn()} loading={false} canEditJobTitle={canEditJobTitle} />);

  it('defaults to invitation while preserving the manual name/email/password form', async () => {
    mocks.call.mockResolvedValue(ok({ invitations: [] }));
    renderModal();
    expect(screen.getByRole('tab', { name: 'memberInvite.inviteTab' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('textbox', { name: /Email/ })).toBeNull();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'memberInvite.manualTab' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('textbox', { name: /Email/ })).toBeInTheDocument();
    expect(screen.getByLabelText('memberList.passwordLabel')).toBeInTheDocument();
  });

  it('ordinary admins issue only member invitations, then copy the HTTP-compatible fragment link', async () => {
    mocks.call.mockResolvedValueOnce(ok({ invitations: [] }))
      .mockResolvedValueOnce(ok({ invitation, inviteToken: 'example-token', inviteUrl: 'http://example.com/join#invite=example-token' }))
      .mockResolvedValueOnce(ok({ invitations: [invitation] }));
    renderModal();
    await screen.findByText('memberInvite.empty');
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.createLink' }));
    const link = await screen.findByLabelText('memberInvite.linkLabel');
    expect(link).toHaveValue('http://example.com/join#invite=example-token');
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.copyLink' }));
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith('http://example.com/join#invite=example-token'));
    expect(mocks.call.mock.calls[1]).toEqual(['member-invitations', { action: 'create', role: 'member', jobTitle: '', isQaAdmin: false }]);
  });

  it('shows failed list reads as an error rather than an empty invitation list', async () => {
    mocks.call.mockResolvedValue(failed('server_error'));
    renderModal();
    expect(await screen.findByRole('alert')).toHaveTextContent('memberInvite.loadFailed');
    expect(screen.queryByText('memberInvite.empty')).toBeNull();
  });

  it('requires a clear revoke confirmation before invalidating a pending invitation', async () => {
    mocks.call.mockResolvedValueOnce(ok({ invitations: [invitation] }))
      .mockResolvedValueOnce(ok({ success: true }))
      .mockResolvedValueOnce(ok({ invitations: [{ ...invitation, status: 'revoked' }] }));
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: 'memberInvite.revoke' }));
    expect(mocks.call).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.confirmRevoke' }));
    expect(await screen.findByText('memberInvite.status.revoked')).toBeInTheDocument();
    expect(mocks.call.mock.calls[1]).toEqual(['member-invitations', { action: 'revoke', invitationId: invitation.id }]);
    expect(screen.queryByRole('button', { name: 'memberInvite.revoke' })).toBeNull();
  });

  it('removes the active copy link after a refresh reports that it was used', async () => {
    mocks.call.mockResolvedValueOnce(ok({ invitations: [] }))
      .mockResolvedValueOnce(ok({ invitation, inviteToken: 'example-token', inviteUrl: 'http://example.com/join#invite=example-token' }))
      .mockResolvedValueOnce(ok({ invitations: [invitation] }))
      .mockResolvedValueOnce(ok({ invitations: [{ ...invitation, status: 'used' }] }));
    renderModal();
    await screen.findByText('memberInvite.empty');
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.createLink' }));
    await screen.findByLabelText('memberInvite.linkLabel');
    const refresh = screen.getByRole('button', { name: 'memberInvite.refresh' });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    await screen.findByText('memberInvite.status.used');
    expect(screen.queryByRole('button', { name: 'memberInvite.copyLink' })).toBeNull();
    expect(screen.queryByLabelText('memberInvite.linkLabel')).toBeNull();
  });

  it('removes a newly unavailable copy link and lets the administrator revoke that invitation', async () => {
    mocks.call.mockResolvedValueOnce(ok({ invitations: [] }))
      .mockResolvedValueOnce(ok({ invitation, inviteToken: 'example-token', inviteUrl: 'http://example.com/join#invite=example-token' }))
      .mockResolvedValueOnce(ok({ invitations: [invitation] }))
      .mockResolvedValueOnce(ok({ invitations: [{ ...invitation, status: 'unavailable' }] }))
      .mockResolvedValueOnce(ok({ success: true }))
      .mockResolvedValueOnce(ok({ invitations: [{ ...invitation, status: 'revoked' }] }));
    renderModal();
    await screen.findByText('memberInvite.empty');
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.createLink' }));
    await screen.findByLabelText('memberInvite.linkLabel');
    const refresh = screen.getByRole('button', { name: 'memberInvite.refresh' });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    await screen.findByText('memberInvite.status.unavailable');
    expect(screen.queryByRole('button', { name: 'memberInvite.copyLink' })).toBeNull();
    expect(screen.queryByLabelText('memberInvite.linkLabel')).toBeNull();
    expect(screen.getByText('memberInvite.unavailableHint')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.revoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'memberInvite.confirmRevoke' }));
    await screen.findByText('memberInvite.status.revoked');
    expect(mocks.call.mock.calls[4]).toEqual(['member-invitations', { action: 'revoke', invitationId: invitation.id }]);
  });
});
