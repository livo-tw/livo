import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Sprint } from '@/context/SprintContext';
import type { SprintHistoryRecord } from '@/lib/sprintLifecycle';
import DashboardSprintHistory from '@/components/dashboard/DashboardSprintHistory';
import { readSprintHistory } from '@/lib/sprintHistory';
type Reply = { data: unknown; error: unknown };
const api = vi.hoisted(() => ({ range: vi.fn<(sprintId: string, start: number, end: number) => PromiseLike<Reply>>() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: object) => key + (values ? ` ${JSON.stringify(values)}` : '') }) }));
vi.mock('@/components/dashboard/useDashboardData', () => ({ formatDate: (value: string | null) => value ?? '—' }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (table: string) => {
  if (table !== 'sprint_task_history') throw new Error('wrong table');
  let sprintId = '';
  const query = { select: () => query, eq: (key: string, id: string) => { if (key !== 'sprint_id') throw new Error('missing sprint scope'); sprintId = id; return query; }, order: () => query, range: (start: number, end: number) => api.range(sprintId, start, end) };
  return query;
} } }));
const sprint = (id: string, recorded = true): Sprint => ({ id, name: `Example ${id}`, startedAt: '2026-01-01', completedAt: '2026-01-14', completedCount: 2, pendingCount: 1, cancelledCount: recorded ? 1 : null, historyCapturedAt: recorded ? '2026-01-14' : null, isActive: false });
const record = (sprintId: string, id = 'record-one'): SprintHistoryRecord => ({ id, sprint_id: sprintId, task_id: `task-${id}`, task_key: `EX-${id}`, title: `Snapshot ${id}`, project_id: 'project-example', status_id: 'finished', status_name: 'Finished at closing', assignee_id: null, parent_task_id: null, outcome: 'completed', source: 'snapshot', recorded_at: '2026-01-14' });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const open = (name: string) => fireEvent.click(screen.getByRole('button', { name: `sprint.history.open {"name":"Example ${name}"}` }));
beforeEach(() => { api.range.mockReset().mockResolvedValue({ data: [], error: null }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('sprint history actual loader boundaries', () => {
  it('paginates a full500-row page rather than silently truncating the closed sprint', async () => {
    const first = Array.from({ length: 500 }, (_, index) => record('recorded', `r-${index}`));
    api.range.mockResolvedValueOnce({ data: first, error: null }).mockResolvedValueOnce({ data: [record('recorded', 'last')], error: null });
    const rows = await readSprintHistory('recorded');
    expect(rows).toHaveLength(501);
    expect(api.range.mock.calls).toEqual([['recorded', 0, 499], ['recorded', 500, 999]]);
  });

  it('rejects an inaccessible later page instead of returning a misleading partial success', async () => {
    api.range.mockResolvedValueOnce({ data: Array.from({ length: 500 }, (_, index) => record('recorded', `r-${index}`)), error: null }).mockResolvedValueOnce({ data: null, error: { code: '42501' } });
    await expect(readSprintHistory('recorded')).rejects.toThrow('sprint_history_unavailable');
  });

  it.each([
    { data: null, error: null },
    { data: [record('another-sprint')], error: null },
    { data: [{ ...record('recorded'), outcome: 'invented' }], error: null },
  ])('rejects missing or wrong-scope/outcome results instead of fabricating empty membership', async reply => {
    api.range.mockResolvedValue(reply);
    await expect(readSprintHistory('recorded')).rejects.toThrow('sprint_history_unavailable');
  });
});

describe('sprint history UI evidence and late reads', () => {
  it.each([false, true])('keeps cancellation out of completion rate and legacy breakdown unknown (mobile=%s)', isMobile => {
    const known = sprint('recorded'), legacy = sprint('legacy', false);
    render(<DashboardSprintHistory currentSprint={null} completedSprints={[known, legacy]} isMobile={isMobile} />);
    const currentRow = screen.getByText('Example recorded').parentElement!;
    const legacyRow = screen.getByText('Example legacy').parentElement!;
    expect(currentRow).toHaveTextContent('50%');
    expect(legacyRow).toHaveTextContent('—');
    expect(legacyRow).toHaveTextContent('sprint.history.legacyFinished');
    expect(legacyRow).toHaveTextContent(isMobile ? 'sprint.history.cancelledUnknown' : 'sprint.history.unknown');
    expect(legacyRow).not.toHaveTextContent('0%');
  });

  it('shows a genuine zero-member recorded sprint as0%, distinct from unknown legacy history', () => {
    render(<DashboardSprintHistory currentSprint={null} completedSprints={[{ ...sprint('empty'), completedCount: 0, cancelledCount: 0, pendingCount: 0 }]} isMobile={false} />);
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('shows read failure and permits a fresh retry, never claiming empty history after denial', async () => {
    api.range.mockResolvedValueOnce({ data: null, error: { code: '42501' } }).mockResolvedValueOnce({ data: [record('recorded')], error: null });
    render(<DashboardSprintHistory currentSprint={null} completedSprints={[sprint('recorded')]} isMobile={false} />);
    open('recorded');
    expect(await screen.findByRole('alert')).toHaveTextContent('sprint.history.loadFailed');
    expect(screen.queryByText('sprint.history.empty')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'sprint.history.retry' }));
    expect(await screen.findByText('Snapshot record-one')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('preserves explicit legacy unknown outcome without inferring completed from a current status label', async () => {
    api.range.mockResolvedValue({ data: [{ ...record('legacy'), source: 'legacy', outcome: 'unknown', status_name: 'Currently finished' }], error: null });
    render(<DashboardSprintHistory currentSprint={null} completedSprints={[sprint('legacy', false)]} isMobile={false} />);
    open('legacy');
    expect(await screen.findByText('sprint.history.outcomes.unknown')).toBeTruthy();
    expect(screen.getByText('sprint.history.legacyNotice')).toBeTruthy();
    expect(screen.queryByText('sprint.history.outcomes.completed')).toBeNull();
  });

  it.each([false, true])('ignores a previous closed-dialog read after opening another sprint (old rejection=%s)', async rejectOld => {
    const first = deferred<Reply>(), second = deferred<Reply>();
    api.range.mockImplementation(id => id === 'old' ? first.promise : second.promise);
    render(<DashboardSprintHistory currentSprint={null} completedSprints={[sprint('old'), sprint('new')]} isMobile={false} />);
    open('old');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    open('new');
    await act(async () => { second.resolve({ data: [record('new', 'new-visible')], error: null }); await second.promise; });
    expect(await screen.findByText('Snapshot new-visible')).toBeTruthy();
    await act(async () => {
      if (rejectOld) first.reject(new Error('old read failed'));
      else first.resolve({ data: [record('old', 'old-hidden')], error: null });
      await Promise.resolve();
    });
    expect(screen.getByText('Snapshot new-visible')).toBeTruthy();
    expect(screen.queryByText('Snapshot old-hidden')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
