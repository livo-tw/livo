import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const state = vi.hoisted(() => ({ on: false, cloud: false, demo: false, role: 'admin' }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ featureToggles: { slackActions: state.on }, featureTogglesReady: true }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMember: { id: 'admin-self', role: state.role } }) }));
const members = [
  { id: 'admin-self', name: 'Admin Self', role: 'admin', isActive: true, email: 'self@example.com' },
  { id: 'member-plain', name: 'Plain Member', role: 'member', isActive: true, email: 'plain@example.com' },
  { id: 'admin-other', name: 'Other Admin', role: 'admin', isActive: true, email: 'other@example.com' },
  { id: 'super-one', name: 'Super One', role: 'super_admin', isActive: true, email: 'super@example.com' },
  { id: 'member-off', name: 'Off Member', role: 'member', isActive: false, email: 'off@example.com' },
];
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: members }) }));
vi.mock('@/lib/apiBase', () => ({ get USE_CF_BACKEND() { return state.cloud; }, fnUrl: () => 'https://example.com' }));
vi.mock('@/lib/demoMode', () => ({ get IS_DEMO_PRO() { return state.demo; } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'example-token' } } })) } } }));
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
  it('offers manual mapping and lets an admin pick only plain members or themselves', async () => {
    Object.assign(state, { on: true, cloud: false, role: 'admin', demo: false });
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('slackUsers=1')
      ? json({ users: [{ id: 'UEXAMPLE', name: 'Slack Person', email: 'person@example.org' }] })
      : json({ connected: false, lastSeen: null, bindings: [] })));
    render(<SlackActionsSection />);
    fireEvent.click(screen.getByText('slackActions.manual.load'));
    const memberSelect = await waitFor(() => screen.getByLabelText('slackActions.manual.member')) as HTMLSelectElement;
    const options = [...memberSelect.options].map(o => o.value).filter(Boolean);
    expect(options).toEqual(['admin-self', 'member-plain']);
    const slackSelect = screen.getByLabelText('slackActions.manual.slackUser') as HTMLSelectElement;
    expect([...slackSelect.options].map(o => o.value)).toContain('UEXAMPLE');
  });
  it('shows a clear demo state without touching a backend', () => {
    Object.assign(state, { on: true, cloud: false, role: 'admin', demo: true });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    render(<SlackActionsSection />);
    expect(screen.getByText('slackActions.demo')).toBeTruthy(); expect(fetchMock).not.toHaveBeenCalled();
  });
});
