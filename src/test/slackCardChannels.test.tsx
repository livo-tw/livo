import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const state = vi.hoisted(() => ({ cloud: false, tables: [] as string[], updates: [] as Record<string, unknown>[] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/apiBase', () => ({ get USE_CF_BACKEND() { return state.cloud; }, fnUrl: (name: string) => `https://example.com/${name}` }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ hasFeature: () => true, isDemoMode: false }) }));
vi.mock('@/components/ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(), ConfirmDialog: null as null }) }));
vi.mock('@/components/UpgradePrompt', () => ({ default: (): null => null }));
vi.mock('@/components/integrations/SlackActionsSection', () => ({ default: (): null => null }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as unknown[], refreshUsers: async () => {} }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'example-token' } } })) },
  from: (table: string) => {
    state.tables.push(table);
    let patch: Record<string, unknown> | undefined;
    const query = {
      select: () => query, limit: () => query,
      update: (value: Record<string, unknown>) => { patch = value; return query; },
      eq: () => patch ? (state.updates.push(patch), Promise.resolve({ error: null })) : query,
      maybeSingle: async () => ({ error: null as null, data: table === 'backup_settings'
        ? { id: 'example-backup-settings', task_notify_channel: 'old-notify' }
        : { value: { enabled: true,
          routes: [{ lineId: 'line-example', channelId: 'CTASK' }], qaRoutes: [{ lineId: 'line-example', channelId: 'CQA' }] } } }),
    };
    return query;
  },
} }));
import SlackCard from '@/components/integrations/SlackCard';
beforeEach(() => {
  Object.assign(state, { cloud: false, tables: [], updates: [] });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('slack-config')
    ? { configured: true, source: 'app', team: 'Example Workspace' }
    : { channels: [{ id: 'CTASK', name: 'tasks', is_member: true }, { id: 'CQA', name: 'bugs', is_member: true }] }),
  { headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('Slack integration channel pickers across backends', () => {
  it('shows the actual task and QA routes on self-host without reading the old backup channel', async () => {
    render(<SlackCard />);
    const qa = await screen.findByLabelText('integrations.slack.qaChannelPickerLabel') as HTMLSelectElement;
    await waitFor(() => expect(qa.disabled).toBe(false));
    expect(qa.value).toBe('CQA');
    expect((screen.getByLabelText('integrations.slack.channelPickerLabel') as HTMLSelectElement).value).toBe('CTASK');
    expect([...new Set(state.tables)]).toEqual(['system_settings']); // the channel pickers and the personal message settings
    expect(screen.queryByRole('option', { name: '#old-notify' })).toBeNull();
  });
  it('keeps the existing Cloudflare channel setting and does not offer a Docker-only QA setting', async () => {
    state.cloud = true; render(<SlackCard />);
    const select = await screen.findByRole('combobox') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('old-notify'));
    expect(screen.queryByLabelText('integrations.slack.qaChannelPickerLabel')).toBeNull();
    expect(state.tables).toEqual(['backup_settings']);
    fireEvent.change(select, { target: { value: 'tasks' } });
    await waitFor(() => expect(state.updates).toEqual([{ task_notify_channel: 'tasks' }]));
  });
});
