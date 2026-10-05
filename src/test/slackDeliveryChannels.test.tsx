import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const state = vi.hoisted(() => ({
  value: {} as Record<string, unknown>, writes: [] as Record<string, unknown>[],
  readError: false, writeError: false, conflict: false, success: vi.fn(), error: vi.fn(), tables: [] as string[],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({ toast: { success: state.success, error: state.error } }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => {
  state.tables.push(table);
  const filters: Record<string, unknown> = {};
  let patch: Record<string, unknown> | undefined;
  const query = {
    select: (columns: string) => {
      if (columns !== 'value') throw new Error('unknown_system_settings_column');
      if (!patch) return query;
      if (state.writeError) return Promise.resolve({ data: null as null, error: { message: 'write_denied' } });
      if (state.conflict || filters.key !== 'slack_delivery' || filters.value !== JSON.stringify(state.value)) return Promise.resolve({ data: [], error: null });
      state.writes.push(patch);
      state.value = structuredClone(patch.value) as Record<string, unknown>;
      return Promise.resolve({ data: [{ value: structuredClone(state.value) }], error: null });
    },
    eq: (key: string, value: unknown) => { filters[key] = value; return query; },
    maybeSingle: async () => state.readError ? { data: null as null, error: { message: 'read_failed' } }
      : { data: { value: structuredClone(state.value) }, error: null as null },
    update: (values: Record<string, unknown>) => { patch = values; return query; },
  };
  return query;
} } }));
import SlackDeliveryChannels from '@/components/integrations/SlackDeliveryChannels';
const channels = [{ id: 'CTASK', name: 'tasks', is_member: true }, { id: 'CQA', name: 'bugs', is_member: true }, { id: 'CNEW', name: 'new-bugs', is_member: true }];
const renderPickers = () => render(<SlackDeliveryChannels configured isDemoMode={false} channels={channels} channelsError={null} />);
const task = () => screen.getByLabelText('integrations.slack.channelPickerLabel') as HTMLSelectElement;
const qa = () => screen.getByLabelText('integrations.slack.qaChannelPickerLabel') as HTMLSelectElement;
beforeEach(() => {
  vi.clearAllMocks(); Object.assign(state, { writes: [], tables: [], readError: false, writeError: false, conflict: false });
  state.value = { enabled: true, teamId: 'TEXAMPLE', dmEnabled: true, weekly: { enabled: false, day: 1 },
    routes: [{ lineId: 'line-example', channelId: 'CTASK' }], qaRoutes: [{ lineId: 'line-example', channelId: 'CQA' }] };
});
afterEach(cleanup);
describe('self-host task and QA notification channel settings', () => {
  it('shows both actual delivery channels using IDs and channel names', async () => {
    renderPickers(); await waitFor(() => expect(qa().disabled).toBe(false));
    expect(task().value).toBe('CTASK'); expect(qa().value).toBe('CQA');
    expect(screen.getByRole('option', { name: '#bugs', selected: true })).toBeTruthy();
    expect(state.tables).toEqual(['system_settings']);
  });
  it('changes only QA routes and keeps project scopes, opt-outs and weekly off', async () => {
    renderPickers(); await waitFor(() => expect(qa().disabled).toBe(false));
    fireEvent.change(qa(), { target: { value: 'CNEW' } });
    await waitFor(() => expect(state.success).toHaveBeenCalled());
    expect(state.value).toEqual({ enabled: true, teamId: 'TEXAMPLE', dmEnabled: true, weekly: { enabled: false, day: 1 },
      routes: [{ lineId: 'line-example', channelId: 'CTASK' }], qaRoutes: [{ lineId: 'line-example', channelId: 'CNEW' }] });
    expect(qa().value).toBe('CNEW');
    cleanup(); renderPickers(); await waitFor(() => expect(qa().value).toBe('CNEW'));
  });
  it('changes ordinary tasks independently and allows clearing a QA channel', async () => {
    renderPickers(); await waitFor(() => expect(task().disabled).toBe(false));
    fireEvent.change(task(), { target: { value: 'CNEW' } });
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.value.qaRoutes).toEqual([{ lineId: 'line-example', channelId: 'CQA' }]);
    await waitFor(() => expect(qa().disabled).toBe(false));
    fireEvent.change(qa(), { target: { value: '' } });
    await waitFor(() => expect(state.writes).toHaveLength(2));
    expect(state.value.routes).toEqual([{ lineId: 'line-example', channelId: 'CNEW' }]);
    expect(state.value.qaRoutes).toEqual([{ lineId: 'line-example', channelId: '' }]);
    expect(state.value.dmEnabled).toBe(true); expect(state.value.weekly).toEqual({ enabled: false, day: 1 });
  });
  it('adds the first QA route using existing scopes, preserving disabled routes', async () => {
    delete state.value.qaRoutes;
    state.value.routes = [{ projectId: 'example-project', channelId: 'CTASK' }, { lineId: 'disabled-line', channelId: 'CTASK', enabled: false }];
    renderPickers(); await waitFor(() => expect(qa().disabled).toBe(false));
    fireEvent.change(qa(), { target: { value: 'CQA' } });
    await waitFor(() => expect(state.success).toHaveBeenCalled());
    expect(state.value.qaRoutes).toEqual([{ projectId: 'example-project', channelId: 'CQA' }, { lineId: 'disabled-line', channelId: 'CQA', enabled: false }]);
  });
  it.each(['writeError', 'conflict'] as const)('keeps the saved value and reports a %s', async failure => {
    renderPickers(); await waitFor(() => expect(qa().disabled).toBe(false)); state[failure] = true;
    fireEvent.change(qa(), { target: { value: 'CNEW' } });
    await waitFor(() => expect(state.error).toHaveBeenCalled());
    expect(qa().value).toBe('CQA'); expect(state.writes).toHaveLength(0); expect(state.success).not.toHaveBeenCalled();
  });
  it('does not turn a read failure into empty editable settings', async () => {
    state.readError = true; renderPickers();
    await screen.findAllByRole('alert'); expect(task().disabled).toBe(true); expect(qa().disabled).toBe(true);
    expect(state.writes).toHaveLength(0);
  });
  it('shows multiple project channels without pretending one channel is selected', async () => {
    state.value.qaRoutes = [{ projectId: 'project-a', channelId: 'CQA' }, { projectId: 'project-b', channelId: 'CNEW' }];
    renderPickers(); await waitFor(() => expect(qa().disabled).toBe(false));
    expect(qa().selectedOptions[0].textContent).toBe('integrations.slack.channelMultiple');
  });
});
