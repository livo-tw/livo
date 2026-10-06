import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const state = vi.hoisted(() => ({
  value: {} as Record<string, unknown> | null, writes: [] as Record<string, unknown>[], conflict: false,
  success: vi.fn(), error: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { success: state.success, error: state.error } }));
// Fictional members only.
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ refreshUsers: async () => {}, users: [
  { id: 'm-ann', name: 'Ann Example', email: 'ann@example.com', isActive: true, sortOrder: 2 },
  { id: 'm-bo', name: 'Bo Example', email: 'bo@example.com', isActive: true, sortOrder: 1 },
  { id: 'm-old', name: 'Old Example', email: 'old@example.com', isActive: false, sortOrder: 3 },
] }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => {
  if (table !== 'system_settings') throw new Error('unexpected_table');
  const filters: Record<string, unknown> = {};
  let patch: Record<string, unknown> | undefined;
  const query = {
    select: () => {
      if (!patch) return query;
      if (state.conflict || filters.key !== 'slack_delivery' || filters.value !== JSON.stringify(state.value)) return Promise.resolve({ data: [], error: null });
      state.writes.push(patch);
      state.value = structuredClone(patch.value) as Record<string, unknown>;
      return Promise.resolve({ data: [{ value: structuredClone(state.value) }], error: null });
    },
    eq: (key: string, value: unknown) => { filters[key] = value; return query; },
    maybeSingle: async () => ({ data: state.value ? { value: structuredClone(state.value) } : null, error: null as null }),
    update: (values: Record<string, unknown>) => { patch = values; return query; },
  };
  return query;
} } }));
import SlackPersonalMessages from '@/components/integrations/SlackPersonalMessages';
import { personalMessageSettings, withPersonalMessages } from '@/lib/slackPersonalMessages';

const base = { enabled: true, teamId: 'TEXAMPLE', dmEnabled: true, weekly: { enabled: false },
  routes: [{ lineId: 'line-example', channelId: 'CTASK' }], qaRoutes: [{ lineId: 'line-example', channelId: 'CQA' }] };
const enable = () => screen.getByLabelText('integrations.slack.dm.enable') as HTMLInputElement;
const all = () => screen.getByLabelText('integrations.slack.dm.scopeAll') as HTMLInputElement;
const listed = () => screen.getByLabelText('integrations.slack.dm.scopeListed') as HTMLInputElement;
const save = () => screen.getByRole('button', { name: 'integrations.slack.dm.save' }) as HTMLButtonElement;
const ready = async () => waitFor(() => expect(enable().disabled).toBe(false));
beforeEach(() => { vi.clearAllMocks(); state.value = structuredClone(base); state.writes = []; state.conflict = false; });
afterEach(cleanup);

describe('the stored personal message setting', () => {
  it('reads no list as every linked member, and writes the list only when chosen', () => {
    expect(personalMessageSettings(base)).toEqual({ enabled: true, onlyListed: false, memberIds: [] });
    expect(personalMessageSettings({ ...base, dmMemberIds: ['b', 'a', 'a', 3] })).toEqual({ enabled: true, onlyListed: true, memberIds: ['a', 'b'] });
    expect(withPersonalMessages({ ...base, dmMemberIds: ['a'] }, false, false, [])).toEqual({ ...base, dmEnabled: false });
    expect(withPersonalMessages(base, true, true, ['b', 'a'])).toEqual({ ...base, dmMemberIds: ['a', 'b'] });
  });
});

describe('personal Slack message settings', () => {
  it('shows the current setting: on, for every linked member', async () => {
    render(<SlackPersonalMessages configured isDemoMode={false} />); await ready();
    expect(enable().checked).toBe(true);
    expect(all().checked).toBe(true);
    expect(save().disabled).toBe(true);
  });

  it('turns personal messages off and keeps routes, bug routes and weekly settings', async () => {
    render(<SlackPersonalMessages configured isDemoMode={false} />); await ready();
    fireEvent.click(enable()); fireEvent.click(save());
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0].value).toEqual({ ...base, dmEnabled: false });
    expect(state.success).toHaveBeenCalledWith('integrations.slack.dm.saved');
  });

  it('limits messages to chosen active members, and back to everyone', async () => {
    render(<SlackPersonalMessages configured isDemoMode={false} />); await ready();
    fireEvent.click(listed());
    expect(screen.queryByText('Old Example')).toBeNull();
    expect(save().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe('integrations.slack.dm.emptyList');
    fireEvent.click(screen.getByLabelText(/Bo Example/));
    fireEvent.click(screen.getByLabelText(/Ann Example/));
    fireEvent.click(save());
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes[0].value).toEqual({ ...base, dmMemberIds: ['m-ann', 'm-bo'] });
    await waitFor(() => expect(save().disabled).toBe(true));
    fireEvent.click(all()); fireEvent.click(save());
    await waitFor(() => expect(state.writes).toHaveLength(2));
    expect(state.writes[1].value).toEqual(base);
  });

  it('finds members by name or e-mail', async () => {
    state.value = { ...base, dmMemberIds: [] };
    render(<SlackPersonalMessages configured isDemoMode={false} />); await ready();
    fireEvent.change(screen.getByLabelText('integrations.slack.dm.search'), { target: { value: 'bo@' } });
    expect(screen.queryByText('Ann Example')).toBeNull();
    expect(screen.getByText('Bo Example')).toBeTruthy();
  });

  it('refuses to overwrite a newer change', async () => {
    render(<SlackPersonalMessages configured isDemoMode={false} />); await ready();
    state.conflict = true;
    fireEvent.click(enable()); fireEvent.click(save());
    await waitFor(() => expect(state.error).toHaveBeenCalledWith('integrations.slack.channelSettingsConflict'));
    expect(state.writes).toHaveLength(0);
  });

  it('stays read-only until Slack notifications are set up', async () => {
    state.value = null;
    render(<SlackPersonalMessages configured isDemoMode={false} />);
    await waitFor(() => expect(screen.getByText('integrations.slack.dm.missingSettings')).toBeTruthy());
    expect(enable().disabled).toBe(true);
  });
});
