import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getSession: vi.fn(), setSession: vi.fn(), call: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: {
  getSession: mocks.getSession, setSession: mocks.setSession,
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
} } }));
vi.mock('@/lib/callFunction', () => ({ callFunction: mocks.call }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/components/DemoModeBanner', () => ({ default: (): null => null, DEMO_BANNER_HEIGHT: 0 }));
vi.mock('@/components/RequiredPasswordChange', () => ({ default: () => <p>Password change guard</p> }));
vi.mock('@/pages/Index', () => ({ default: () => <p>Authenticated app</p> }));
vi.mock('@/pages/Auth', () => ({ default: () => <p>Login page</p> }));
vi.mock('@/pages/Signup', () => ({ default: () => <p>New workspace signup</p> }));
import App from '@/App';

afterEach(() => { cleanup(); vi.clearAllMocks(); window.history.replaceState(null, '', '/'); });
describe('public join route', () => {
  it.each([false, true])('opens independently of an existing login (logged in: %s)', async loggedIn => {
    window.history.replaceState(null, '', `${import.meta.env.BASE_URL}join#invite=example-token`);
    mocks.getSession.mockResolvedValue({ data: { session: loggedIn ? {
      access_token: 'existing-example', refresh_token: 'existing-refresh',
      user: { id: 'existing-user', email: 'existing@example.com', user_metadata: {} },
    } : null } });
    mocks.call.mockResolvedValue({ ok: true, status: 200, data: {
      workspaceName: 'Example team', role: 'member', jobTitle: '', isQaAdmin: false, expiresAt: '2099-10-08T12:00:00Z',
    } });
    render(<App />);
    expect(await screen.findByLabelText('memberInvite.nameLabel')).toBeInTheDocument();
    expect(screen.queryByText('New workspace signup')).toBeNull();
    expect(screen.queryByText('Authenticated app')).toBeNull();
    expect(screen.queryByText('Login page')).toBeNull();
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(mocks.call).toHaveBeenCalledWith('member-invitations', { action: 'preview', inviteToken: 'example-token' });
  });
});
