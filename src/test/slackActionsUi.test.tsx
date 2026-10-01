import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
const state = vi.hoisted(() => ({ on: false, cloud: false, demo: false, role: 'admin' }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ featureToggles: { slackActions: state.on }, featureTogglesReady: true }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMember: { role: state.role } }) }));
vi.mock('@/lib/apiBase', () => ({ get USE_CF_BACKEND() { return state.cloud; }, fnUrl: () => 'https://example.com' }));
vi.mock('@/lib/demoMode', () => ({ get IS_DEMO_PRO() { return state.demo; } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import SlackActionsSection from '@/components/integrations/SlackActionsSection';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('Slack actions capability and feature switches', () => {
  it.each([[false, false, 'admin'], [true, true, 'admin'], [true, false, 'member']])('hides unsupported surfaces (%s,%s,%s)', (on, cloud, role) => {
    Object.assign(state, { on, cloud, role, demo: false });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<SlackActionsSection />);
    expect(container.innerHTML).toBe(''); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('shows a clear demo state without touching a backend', () => {
    Object.assign(state, { on: true, cloud: false, role: 'admin', demo: true });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    render(<SlackActionsSection />);
    expect(screen.getByText('slackActions.demo')).toBeTruthy(); expect(fetchMock).not.toHaveBeenCalled();
  });
});
