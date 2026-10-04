import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MyAssignmentsProvider, useMyAssignments } from '@/context/MyAssignmentsContext';
import type { QaIssue, QaListResult } from '@/lib/qa/domain';

const mocks = vi.hoisted(() => ({
  member: { id: 'example-owner', role: 'member' }, enabled: true,
  settings: { featureTogglesReady: true, featureTogglesError: null as string | null },
  client: { list: vi.fn() }, remove: vi.fn(), refreshSettings: vi.fn(), refreshTasks: vi.fn(),
}));
vi.mock('@/hooks/useQa', () => ({ useQa: () => ({ client: mocks.client, enabled: mocks.enabled, actor: mocks.member }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ ...mocks.settings, refreshFeatureToggles: mocks.refreshSettings }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: mocks.member.id, currentMember: mocks.member }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [{ id: 'example-task', taskKey: 'EX-1', title: 'Example task', projectId: 'example-project', statusId: 'open', assigneeId: 'example-owner', priority: 'medium', createdAt: '2026-10-01' }], statuses: [{ id: 'open', isDone: false }], refreshTasks: mocks.refreshTasks }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { channel: () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; }, removeChannel: mocks.remove } }));
function Probe() {
  const { items, phase, refresh } = useMyAssignments();
  return <><output data-testid="cards">{phase}:{items.map(item => item.id).join(',')}</output><button onClick={refresh}>Retry</button></>;
}
const app = () => <MyAssignmentsProvider><Probe /></MyAssignmentsProvider>;
const bug = { id: 'example-bug', title: 'Example bug', projectId: 'example-project', assigneeId: 'example-owner', qaOwnerId: null, state: 'triaged', priority: 3, updatedAt: '2026-10-01' } as QaIssue;
const empty: QaListResult = { issues: [], total: 0, hasMore: false };
describe('my assignments acquisition state', () => {
  beforeEach(() => {
    mocks.member = { id: 'example-owner', role: 'member' }; mocks.enabled = true;
    mocks.settings = { featureTogglesReady: true, featureTogglesError: null };
    mocks.client.list.mockReset().mockResolvedValue(empty); mocks.remove.mockClear();
    mocks.refreshSettings.mockClear(); mocks.refreshTasks.mockClear();
  });
  it('keeps the count incomplete until feature settings are known, and does not read QA when disabled', async () => {
    mocks.settings.featureTogglesReady = false; mocks.enabled = false;
    const { rerender } = render(app());
    expect(screen.getByTestId('cards')).toHaveTextContent('loading:example-task');
    expect(mocks.client.list).not.toHaveBeenCalled();
    mocks.settings.featureTogglesError = 'configuration unavailable'; rerender(app());
    await waitFor(() => expect(screen.getByTestId('cards')).toHaveTextContent('error:example-task'));
    await act(async () => screen.getByRole('button', { name: 'Retry' }).click());
    expect(mocks.refreshSettings).toHaveBeenCalledOnce();
    mocks.settings.featureTogglesReady = true; mocks.settings.featureTogglesError = null; rerender(app());
    await waitFor(() => expect(screen.getByTestId('cards')).toHaveTextContent('disabled:example-task'));
    expect(mocks.client.list).not.toHaveBeenCalled();
  });
  it('drops the previous member snapshot immediately while the next identity is loading', async () => {
    mocks.client.list.mockResolvedValue({ issues: [bug], total: 1, hasMore: false });
    const { rerender } = render(app());
    await waitFor(() => expect(screen.getByTestId('cards')).toHaveTextContent('example-bug'));
    mocks.client.list.mockImplementation(() => new Promise<QaListResult>(() => {}));
    mocks.member = { id: 'example-next-member', role: 'member' }; rerender(app());
    expect(screen.getByTestId('cards')).toHaveTextContent('loading:');
    expect(screen.getByTestId('cards')).not.toHaveTextContent('example-bug');
    expect(screen.getByTestId('cards')).not.toHaveTextContent('example-task');
    expect(mocks.remove).toHaveBeenCalled();
  });
  it('exposes a failed QA read as incomplete and lets a retry recover', async () => {
    mocks.client.list.mockRejectedValue(new Error('network unavailable'));
    render(app());
    await waitFor(() => expect(screen.getByTestId('cards')).toHaveTextContent('error:example-task'));
    mocks.client.list.mockResolvedValue(empty);
    await act(async () => screen.getByRole('button', { name: 'Retry' }).click());
    await waitFor(() => expect(screen.getByTestId('cards')).toHaveTextContent('ready:example-task'));
    expect(mocks.refreshTasks).toHaveBeenCalledOnce();
  });
});
