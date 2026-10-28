import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { Sprint } from '@/context/SprintContext';
import type { Task } from '@/types';
import { SprintCompleteModal, SprintStartModal } from '@/components/board/SprintModals';
import { useSprintFlow } from '@/hooks/useSprintFlow';
const state = vi.hoisted(() => ({ start: vi.fn<(name: string, carry?: string[], include?: boolean) => Promise<boolean>>(), complete: vi.fn<(action?: string) => Promise<{ pendingIds: string[]; carryIds?: string[] } | null>>(), command: { busy: false, unresolved: false }, log: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: object) => key + (values ? ` ${JSON.stringify(values)}` : '') }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/context/SprintContext', () => ({ useSprintContext: () => ({ currentSprint: sprint, startSprint: state.start, completeSprint: state.complete, commandState: state.command }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'actor-example' }) }));
vi.mock('@/lib/activityLog', () => ({ logActivity: state.log }));
const sprint: Sprint = { id: 'sprint-current', name: 'Example current', startedAt: '2026-01-01', completedAt: null, completedCount: 0, pendingCount: 0, isActive: true };
const pending = [{ id: 'task-open', taskKey: 'EX-1', title: 'Example pending' }] as Task[];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function Flow() {
  const flow = useSprintFlow();
  return <><button onClick={flow.openStart}>Open start</button><button onClick={flow.openComplete}>Open complete</button><output data-testid="carry">{flow.carryOverTaskIds.length}</output>
    {flow.showStartModal && <SprintStartModal defaultName="Example next" carryOverCount={flow.carryOverTaskIds.length} excludedCarryCount={flow.skippedCarryCount} backlogCount={3} busy={flow.busy} retryOnly={flow.retryOnly} onClose={flow.cancelStart} onConfirm={(name, include) => { void flow.confirmStart(name, include); }} />}
    {flow.showCompleteModal && <SprintCompleteModal currentSprint={sprint} completedCount={2} cancelledCount={1} pendingTasks={pending} busy={flow.busy} retryOnly={flow.retryOnly} onClose={flow.closeComplete} onComplete={action => { void flow.complete(action); }} />}
  </>;
}
beforeEach(() => { state.start.mockReset().mockResolvedValue(true); state.complete.mockReset().mockResolvedValue({ pendingIds: ['task-a', 'task-b'] }); state.log.mockReset(); state.command.busy = false; state.command.unresolved = false; });
afterEach(() => cleanup());

describe('sprint lifecycle modal choices and recovery', () => {
  it('defaults backlog off, previews disjoint carry and backlog counts without writes, then passes the explicit choice', () => {
    const confirm = vi.fn(), close = vi.fn();
    const view = render(<SprintStartModal defaultName="Example next" carryOverCount={2} backlogCount={3} onConfirm={confirm} onClose={close} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByText('sprint.start.selectedCount {"count":2}')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText('sprint.start.selectedCount {"count":5}')).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'button.startSprint' }));
    expect(confirm).toHaveBeenCalledWith('Example next', true);
    view.unmount();
    render(<SprintStartModal defaultName="Another next" backlogCount={3} onConfirm={confirm} onClose={close} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('freezes start fields and closing while an outcome is unknown, but retries the exact retained inputs', () => {
    const confirm = vi.fn(), close = vi.fn();
    const props = { defaultName: 'Example next', carryOverCount: 2, backlogCount: 3, onConfirm: confirm, onClose: close };
    const view = render(<SprintStartModal {...props} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Kept name' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'button.startSprint' }));
    view.rerender(<SprintStartModal {...props} retryOnly />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('textbox')).toHaveValue('Kept name');
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'sprint.retryOriginal' }));
    expect(confirm.mock.calls).toEqual([['Kept name', true], ['Kept name', true]]);
    view.rerender(<SprintStartModal {...props} busy />);
    expect(screen.getByRole('button', { name: 'sprint.processing' })).toBeDisabled();
  });

  it('previews completed, cancelled and pending separately and freezes the selected close action for an unknown result', () => {
    const complete = vi.fn(), close = vi.fn();
    const props = { currentSprint: sprint, completedCount: 2, cancelledCount: 3, pendingTasks: pending, onComplete: complete, onClose: close };
    const view = render(<SprintCompleteModal {...props} />);
    expect(screen.getByText('sprint.complete.summary {"completedCount":2,"pendingCount":1}')).toBeTruthy();
    expect(screen.getByText('sprint.complete.cancelledSummary {"count":3}')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /nextSprintLabel/ }));
    view.rerender(<SprintCompleteModal {...props} retryOnly />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'sprint.retryOriginal' }));
    expect(complete).toHaveBeenCalledWith('next-sprint');
    view.rerender(<SprintCompleteModal {...props} busy />);
    expect(screen.getByRole('button', { name: 'sprint.processing' })).toBeDisabled();
  });

  it('keeps a failed completion modal and never opens or logs a successful next sprint', async () => {
    state.complete.mockResolvedValue(null);
    render(<Flow />); fireEvent.click(screen.getByRole('button', { name: 'Open complete' }));
    fireEvent.click(screen.getByRole('radio', { name: /nextSprintLabel/ }));
    fireEvent.click(screen.getByRole('button', { name: 'button.confirmComplete' }));
    await waitFor(() => expect(state.complete).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'button.confirmComplete' })).toBeEnabled();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(state.log).not.toHaveBeenCalled();
    expect(screen.getByTestId('carry')).toHaveTextContent('0');
  });

  it('keeps archived pending cards in backlog, previews the excluded count, and starts with only the eligible carry IDs', async () => {
    state.complete.mockResolvedValue({ pendingIds: ['task-a', 'task-b'], carryIds: ['task-a'] });
    render(<Flow />);
    fireEvent.click(screen.getByRole('button', { name: 'Open complete' }));
    fireEvent.click(screen.getByRole('radio', { name: /nextSprintLabel/ }));
    fireEvent.click(screen.getByRole('button', { name: 'button.confirmComplete' }));
    await screen.findByRole('textbox');
    expect(screen.getByTestId('carry')).toHaveTextContent('1');
    expect(screen.getByText('sprint.start.archivedCarryHint {"count":1}')).toBeTruthy();
    expect(screen.getByText('sprint.start.selectedCount {"count":1}')).toBeTruthy();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'button.startSprint' }));
    await waitFor(() => expect(state.start).toHaveBeenCalledWith('Example next', ['task-a'], false));
    expect(state.start).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });

  it('continues committed completion and start transitions when best-effort activity logging rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.log.mockRejectedValue(new Error('Example activity transport failure'));
    const started = vi.fn();
    const view = renderHook(() => useSprintFlow({ onStarted: started }));
    try {
      await act(async () => { expect(await view.result.current.complete('next-sprint')).toBe(true); });
      expect(view.result.current.showCompleteModal).toBe(false);
      expect(view.result.current.showStartModal).toBe(true);
      expect(view.result.current.carryOverTaskIds).toEqual(['task-a', 'task-b']);
      expect(view.result.current.busy).toBe(false);
      await act(async () => { expect(await view.result.current.confirmStart('Example next', false)).toBe(true); });
      expect(state.start).toHaveBeenCalledWith('Example next', ['task-a', 'task-b'], false);
      expect(view.result.current.showStartModal).toBe(false);
      expect(view.result.current.carryOverTaskIds).toEqual([]);
      expect(view.result.current.busy).toBe(false);
      expect(started).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(state.log).toHaveBeenCalledTimes(2));
    } finally { warn.mockRestore(); }
  });

  it('deduplicates same-render Enter, retains failed-start carry/name/choice, and clears carry only after success', async () => {
    const response = deferred<boolean>(); state.start.mockReturnValueOnce(response.promise).mockResolvedValueOnce(true);
    render(<Flow />); fireEvent.click(screen.getByRole('button', { name: 'Open complete' }));
    fireEvent.click(screen.getByRole('radio', { name: /nextSprintLabel/ }));
    fireEvent.click(screen.getByRole('button', { name: 'button.confirmComplete' }));
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'Keep this draft' } }); fireEvent.click(screen.getByRole('checkbox'));
    act(() => { fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' }); });
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(state.start).toHaveBeenCalledWith('Keep this draft', ['task-a', 'task-b'], true);
    expect(screen.getByRole('textbox')).toBeDisabled();
    await act(async () => { response.resolve(false); await response.promise; });
    expect(screen.getByRole('textbox')).toHaveValue('Keep this draft');
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.getByTestId('carry')).toHaveTextContent('2');
    expect(state.log.mock.calls.filter(call => call[1] === 'start_sprint')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'button.startSprint' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(screen.getByTestId('carry')).toHaveTextContent('0');
    expect(state.start).toHaveBeenCalledTimes(2);
    expect(state.log.mock.calls.filter(call => call[1] === 'start_sprint')).toHaveLength(1);
  });
});
