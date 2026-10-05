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
  it.each([[false, false, 'admin'], [true, false, 'member']])('hides unsupported surfaces (%s,%s,%s)', (on, cloud, role) => {
    Object.assign(state, { on, cloud, role, demo: false });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<SlackActionsSection />);
    expect(container.innerHTML).toBe(''); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('shows Cloudflare QA setup guidance without calling the Docker-only configuration endpoint', () => {
    Object.assign(state, { on: true, cloud: true, role: 'admin', demo: false });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); render(<SlackActionsSection />);
    expect(screen.getByText('qa.slackCloud')).toBeTruthy(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('offers manual mapping only to the workspace owner', async () => {
    Object.assign(state, { on: true, cloud: false, role: 'super_admin', demo: false });
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('slackUsers=1')
      ? json({ users: [{ id: 'UEXAMPLE', name: 'Slack Person', email: 'person@example.org' }] })
      : json({ connected: false, lastSeen: null, bindings: [] })));
    render(<SlackActionsSection />);
    fireEvent.click(screen.getByText('slackActions.manual.load'));
    const memberSelect = await waitFor(() => screen.getByLabelText('slackActions.manual.member')) as HTMLSelectElement;
    const options = [...memberSelect.options].map(o => o.value).filter(Boolean);
    expect(options).toEqual(['admin-self', 'member-plain', 'admin-other', 'super-one']);
    const slackSelect = screen.getByLabelText('slackActions.manual.slackUser') as HTMLSelectElement;
    expect([...slackSelect.options].map(o => o.value)).toContain('UEXAMPLE');
  });
  const owner = (bindings: unknown[], users: unknown[]) => {
    Object.assign(state, { on: true, cloud: false, role: 'super_admin', demo: false });
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('slackUsers=1') ? json({ users }) : json({ connected: true, lastSeen: null, bindings })));
    render(<SlackActionsSection />);
  };
  const values = (label: string) => [...(screen.getByLabelText(label) as HTMLSelectElement).options].map(o => o.value).filter(Boolean);
  const mapping = (memberId: string, slackId: string, extra: Record<string, unknown> = {}) => ({ id: `binding-${memberId}`, member_id: memberId,
    platform_user_id: slackId, display_name: slackId, memberName: memberId, active: true, verifiedBy: 'email', verifiedByOwner: false, is_verified: true, reconfirm_required: false, ...extra });
  it('hides members and Slack accounts that are already mapped, but keeps mappings that need the owner again', async () => {
    owner([
      mapping('member-plain', 'UWORKING'),
      mapping('admin-other', 'USUSPENDED', { verifiedBy: 'admin', is_verified: false, reconfirm_required: true }),
      mapping('super-one', 'UUNTRUSTED', { verifiedBy: 'admin', verifiedByOwner: false }),
      mapping('admin-self', 'UOWNERMADE', { verifiedBy: 'admin', verifiedByOwner: true }),
    ], ['UWORKING', 'USUSPENDED', 'UUNTRUSTED', 'UOWNERMADE', 'UFREE'].map(id => ({ id, name: id.toLowerCase(), email: `${id.toLowerCase()}@example.org` })));
    await waitFor(() => expect(screen.getAllByText('slackActions.manual.reconfirm')).toHaveLength(2));
    fireEvent.click(screen.getByText('slackActions.manual.load'));
    await waitFor(() => screen.getByLabelText('slackActions.manual.member'));
    expect(values('slackActions.manual.member')).toEqual(['admin-other', 'super-one']);
    expect(values('slackActions.manual.slackUser')).toEqual(['USUSPENDED', 'UUNTRUSTED', 'UFREE']);
    fireEvent.click(screen.getByLabelText('slackActions.manual.showMapped'));
    expect(values('slackActions.manual.member')).toEqual(['admin-self', 'member-plain', 'admin-other', 'super-one']);
    expect(values('slackActions.manual.slackUser')).toEqual(['UWORKING', 'USUSPENDED', 'UUNTRUSTED', 'UOWNERMADE', 'UFREE']);
    expect(screen.getByRole('option', { name: /^uworking · uworking@example\.org · slackActions\.manual\.mappedTag$/ })).toBeTruthy();
  });
  it('says so when every member is mapped, and keeps the switch to show them', async () => {
    owner(['admin-self', 'member-plain', 'admin-other', 'super-one'].map((id, index) => mapping(id, `UMAPPED${index}`)),
      [{ id: 'UMAPPED0', name: 'Mapped', email: 'mapped@example.org' }]);
    await waitFor(() => expect(screen.getAllByText('slackActions.unbind')).toHaveLength(4));
    fireEvent.click(screen.getByText('slackActions.manual.load'));
    expect(await screen.findByText('slackActions.manual.allMembersMapped')).toBeTruthy();
    expect(screen.getByText('slackActions.manual.allSlackMapped')).toBeTruthy();
    expect(values('slackActions.manual.member')).toEqual([]);
    fireEvent.click(screen.getByLabelText('slackActions.manual.showMapped'));
    expect(values('slackActions.manual.member')).toHaveLength(4);
    expect(screen.queryByText('slackActions.manual.allMembersMapped')).toBeNull();
  });
  it('lists Slack accounts that look like the chosen member first, without choosing one', async () => {
    owner([], [{ id: 'UBOB', name: 'Bob', email: 'bob@example.org' }, { id: 'UPLAIN', name: 'plain.member', email: 'pm@example.org' },
      { id: 'UCAROL', name: 'Carol', email: 'carol@example.org' }, { id: 'UNICK', name: 'Plainy', email: 'nick@example.org', realName: 'Plain Member' }]);
    fireEvent.click(screen.getByText('slackActions.manual.load'));
    await waitFor(() => screen.getByLabelText('slackActions.manual.member'));
    const slackSelect = screen.getByLabelText('slackActions.manual.slackUser') as HTMLSelectElement;
    expect(slackSelect.querySelector('optgroup')).toBeNull();
    fireEvent.change(screen.getByLabelText('slackActions.manual.member'), { target: { value: 'member-plain' } });
    const groups = [...slackSelect.querySelectorAll('optgroup')].map(group => [group.label, [...group.querySelectorAll('option')].map(o => o.value)]);
    expect(groups).toEqual([['slackActions.manual.likely', ['UPLAIN', 'UNICK']], ['slackActions.manual.otherAccounts', ['UBOB', 'UCAROL']]]);
    expect(slackSelect.value).toBe('');
    expect(screen.getByText('slackActions.manual.likelyHint')).toBeTruthy();
    expect((screen.getByText('slackActions.manual.bind') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('slackActions.manual.member'), { target: { value: 'super-one' } });
    expect(slackSelect.querySelector('optgroup')).toBeNull();
    expect([...slackSelect.options].map(o => o.value).filter(Boolean)).toEqual(['UBOB', 'UPLAIN', 'UCAROL', 'UNICK']);
  });
  it('lets admins inspect status but cannot assign identities or unbind members', async () => {
    Object.assign(state, { on: true, cloud: false, role: 'admin', demo: false });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ connected: false, lastSeen: null,
      bindings: [{ id: 'example-id', display_name: 'Example Slack', memberName: 'Example member', active: true, verifiedBy: 'email' }] })));
    vi.stubGlobal('fetch', fetchMock); render(<SlackActionsSection />);
    expect(screen.getByText('slackActions.manual.ownerOnly')).toBeTruthy();
    expect(screen.queryByText('slackActions.manual.load')).toBeNull();
    const unbind = await waitFor(() => screen.getByText('slackActions.unbind')) as HTMLButtonElement;
    expect(unbind.disabled).toBe(true);
    expect(fetchMock.mock.calls.every((call: unknown[]) => !(call[1] as RequestInit)?.body)).toBe(true);
  });
  it('shows a clear demo state without touching a backend', () => {
    Object.assign(state, { on: true, cloud: false, role: 'admin', demo: true });
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    render(<SlackActionsSection />);
    expect(screen.getByText('slackActions.demo')).toBeTruthy(); expect(fetchMock).not.toHaveBeenCalled();
  });
});
