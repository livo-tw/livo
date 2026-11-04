import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import App from '@/App';

const state = vi.hoisted(() => ({
  session: null as Session | null,
  listener: null as ((event: string, session: Session | null) => void) | null,
  mounts: 0,
  gateMounts: 0,
  unmounts: 0,
}));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/sonner', () => ({ Toaster: (): null => null }));
vi.mock('@/components/RequiredPasswordChange', () => ({ default: () => <p>Required password change</p> }));
vi.mock('@/components/qa/ExternalQaAccessGate', () => ({ default: ({ internal }: { internal: React.ReactNode }) => {
  state.gateMounts++;
  return <>{internal}</>;
} }));
vi.mock('@/components/DemoModeBanner', () => ({ default: (): null => null, DEMO_BANNER_HEIGHT: 0 }));
vi.mock('@/lib/demoMode', () => ({ IS_DEMO_PRO: false }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: false, supabase: { auth: {
  getSession: async () => ({ data: { session: state.session } }),
  onAuthStateChange: (listener: (event: string, session: Session | null) => void) => {
    state.listener = listener;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  },
} } }));
vi.mock('@/pages/Index', async () => {
  const React = await import('react');
  return { default: () => {
    const [instance] = React.useState(() => ++state.mounts);
    React.useEffect(() => () => { state.unmounts += 1; }, []);
    return React.createElement('div', { 'data-testid': 'index-instance' }, String(instance));
  } };
});

function session(id: string, accessToken = 'example-token'): Session {
  return {
    access_token: accessToken, refresh_token: 'example-refresh', expires_in: 3600, token_type: 'bearer',
    user: { id, email: id + '@example.com', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-01-01T00:00:00Z' },
  };
}

beforeEach(() => {
  state.session = session('example-user-a');
  state.listener = null;
  state.mounts = 0;
  state.gateMounts = 0;
  state.unmounts = 0;
  window.history.replaceState({}, '', '/');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('application identity scope', () => {
  it('requires a new password before external QA audience discovery or application startup', async () => {
    const temporary = session('external-example');
    temporary.user.user_metadata.livo_password_change_required = true;
    state.session = temporary;
    render(<App />);
    expect(await screen.findByText('Required password change')).toBeInTheDocument();
    expect(state.gateMounts).toBe(0);
    expect(state.mounts).toBe(0);

    await act(async () => { state.listener?.('USER_UPDATED', session('external-example')); });
    expect(await screen.findByTestId('index-instance')).toBeInTheDocument();
    expect(state.gateMounts).toBeGreaterThan(0);
  });

  it('remounts the application when the authenticated user changes', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('index-instance').textContent).toBe('1'));
    await act(async () => { state.listener?.('TOKEN_REFRESHED', session('example-user-b')); });
    await waitFor(() => expect(screen.getByTestId('index-instance').textContent).toBe('2'));
    expect(state.unmounts).toBe(1);
  });

  it('keeps the current application instance for the same user token refresh', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('index-instance').textContent).toBe('1'));
    await act(async () => { state.listener?.('TOKEN_REFRESHED', session('example-user-a', 'example-refreshed-token')); });
    expect(screen.getByTestId('index-instance').textContent).toBe('1');
    expect(state.mounts).toBe(1);
    expect(state.unmounts).toBe(0);
  });
});
