import type { ReactNode } from 'react';
import type { Task } from '@/types';
import type { BoardFilterState } from '@/hooks/useBoardFilters';
import type { ApprovalConfirmPayload } from '@/components/board/BoardApprovalModal';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  tasks: [] as Task[],
  standupMode: false, standupUserId: null as string | null, projectId: null as string | null,
  update: vi.fn(), setTasks: vi.fn(), open: vi.fn(), gate: vi.fn(), refusal: vi.fn(),
  toast: vi.fn<(title: string, options: { action: { onClick: () => Promise<void> } }) => void>(), success: vi.fn(), announce: vi.fn(), undo: vi.fn(), info: vi.fn(), error: vi.fn(), approval: vi.fn(),
}));
const task: Task = { id: 'example-task', taskKey: 'EX-1', title: 'Example title available for long press', projectId: 'example-project', statusId: 'open', priority: 'medium', creatorId: 'example-member', assigneeId: 'example-member', createdAt: '2026-10-07T00:00:00Z', sortOrder: 0, commentCount: 0, attachmentCount: 0, deployments: [] };
const otherTask = { ...task, id: 'other-task', taskKey: 'EX-2', title: 'Other project task', projectId: 'other-project' };
const projects = [{ id: 'example-project', name: 'Example project', lineId: null as string | null }, { id: 'other-project', name: 'Other project', lineId: null as string | null }];
const statuses = [{ id: 'open', name: 'Open', color: '#888', isDone: false, autoStart: false }, { id: 'progress', name: 'In progress', color: '#00f', isDone: false, autoStart: true }];
const users = [{ id: 'example-member', name: 'Example member', jobTitle: 'Engineer', email: 'member@example.com', isActive: true, role: 'member', color: '#008', department: 'engineering' }];
const ui = { approvalsEnabled: false, featureTogglesReady: true, setSelectedTask: state.open };

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string, options?: { title?: string }) => options?.title ? `${key}: ${options.title}` : key }) }));
vi.mock('@/context/AppContext', () => ({ useAppContext: () => ({
  ...ui, allTasks: state.tasks, setAllTasks: state.setTasks, updateTaskInDb: state.update,
  allProjects: projects, statuses, users, productLines: [] as never[], customFields: [] as never[],
  selectedProjectId: state.projectId, selectedLineId: null as string | null, standupMode: state.standupMode, standupUserId: state.standupUserId,
  sprintActive: false, currentSprint: null as { id: string } | null, currentMemberId: users[0].id, currentMember: users[0],
}) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ui }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: state.tasks, setAllTasks: state.setTasks, updateTaskInDb: state.update, statuses, tags: [] as never[], taskDependencies: [] as never[], customFields: [] as never[], customFieldValues: [] as never[] }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: projects }) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ hasFeature: () => false }) }));
vi.mock('@/hooks/useProjectColor', () => ({ useProjectColor: () => () => '#008' }));
vi.mock('@/hooks/useProjectScope', () => ({ useProjectScope: () => ({ projectIds: null as Set<string> | null }), useScopedProjectFilter: () => {} }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => true }));
vi.mock('@/hooks/useSprintFlow', () => ({ useSprintFlow: () => ({ showCompleteModal: false, showStartModal: false }) }));
vi.mock('@/hooks/useStatusChangeGate', () => ({ useStatusChangeGate: () => ({ check: state.gate, refusal: state.refusal }) }));
vi.mock('@/hooks/useUndoStack', async importOriginal => ({
  ...await importOriginal<typeof import('@/hooks/useUndoStack')>(),
  useUndoStack: () => ({ push: state.undo }),
}));
import { useUndoStackState } from '@/hooks/useUndoStack';
vi.mock('@/hooks/useApprovalRules', () => ({ useApprovalRules: () => ({ getRuleForTransition: vi.fn() }) }));
vi.mock('@/hooks/useApprovalWorkflow', () => ({ useApprovalWorkflow: () => ({ requestApproval: vi.fn() }) }));
vi.mock('@/hooks/useTaskAnnouncements', () => ({ useTaskAnnouncements: () => ({}) }));
vi.mock('@/components/board/useBoardApproval', () => ({ useBoardApproval: () => ({ approvalConfirm: null as ApprovalConfirmPayload | null, setApprovalConfirm: state.approval }) }));
vi.mock('@/components/notifications/NotificationToastProvider', () => ({ useNotificationToast: () => ({ triggerNotification: vi.fn() }) }));
vi.mock('@/lib/taskAnnouncements', () => ({ announceStatusChange: state.announce, announceAssignment: vi.fn() }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('sonner', () => ({ toast: Object.assign(state.toast, { info: state.info, error: state.error, success: state.success, dismiss: vi.fn() }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/components/board/BoardSprintHeader', () => ({ default: (): null => null }));
vi.mock('@/components/board/BoardFilters', () => ({ default: ({ filters }: { filters: BoardFilterState }) =>
  <button onClick={() => filters.setFilterAssignees(['example-member'])}>Filter to example assignee</button>
}));
vi.mock('@/components/StandupLaunchDialog', () => ({ default: (): null => null }));
vi.mock('@/components/UpgradePrompt', () => ({ default: (): null => null }));
vi.mock('@/components/board/SprintModals', () => ({ SprintCompleteModal: (): null => null, SprintStartModal: (): null => null }));
vi.mock('@/components/board/BoardApprovalModal', () => ({ default: ({ children }: { children?: ReactNode }) => <>{children}</> }));

// These tests exercise the real BoardView, TaskCard and dnd-kit sensors. DOM
// measurements stand in for layout; they do not prove native browser touch/scroll.
import BoardView from '@/components/BoardView';

const point = (x = 70, y = 100) => ({ identifier: 1, clientX: x, clientY: y });
const start = (node: HTMLElement, x = 70, y = 100) => fireEvent.touchStart(node, { touches: [point(x, y)], changedTouches: [point(x, y)] });
const move = (node: HTMLElement, x: number, y = 100) => fireEvent.touchMove(node, { touches: [point(x, y)], changedTouches: [point(x, y)] });
const end = (node: HTMLElement, x = 350, y = 100) => fireEvent.touchEnd(node, { touches: [], changedTouches: [point(x, y)] });
const rect = (x: number, y: number, width: number, height: number): DOMRect => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });

describe('general task board touch interaction', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear();
    state.tasks = [task, otherTask]; state.update.mockResolvedValue(true);
    state.standupMode = false; state.standupUserId = null; state.projectId = null;
    state.gate.mockReturnValue({ kind: 'direct' }); state.refusal.mockReturnValue(null);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const columns = [...document.querySelectorAll('.snap-start')];
      const column = this.closest('.snap-start');
      const index = column ? columns.indexOf(column) : -1;
      if (this.classList.contains('snap-start')) return rect(index * 280, 50, 260, 500);
      if (column) return rect(index * 280 + 8, 80, 244, 180);
      if (this.style.position === 'fixed' || this.closest('.rotate-2')) return rect(8, 80, 244, 180);
      return rect(0, 0, 1200, 800);
    });
  });
  afterEach(async () => {
    await act(async () => {});
    cleanup(); act(() => { vi.runOnlyPendingTimers(); });
    vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear();
  });
  const mount = () => render(<BoardView />);
  const hold = () => act(() => { vi.advanceTimersByTime(300); });
  const handle = () => screen.getByRole('button', { name: `board.dragCard: ${task.title}` });
  const title = () => screen.getByText(task.title);
  const overlayVisible = () => screen.queryAllByText(task.title).length === 2;
  const drop = async (x = 350) => {
    const target = handle(); start(target); hold();
    move(target, x); act(() => { vi.advanceTimersByTime(20); });
    await act(async () => { end(target, x); });
  };

  it('opens the current standup project with a clean filter and restores the regular board filter on exit', () => {
    const review = { ...task, id: 'review-task', taskKey: 'EX-3', title: 'Card to review', assigneeId: 'another-member', reviewerId: 'example-member' };
    state.tasks = [task, otherTask, review];
    const board = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Filter to example assignee' }));
    expect(screen.queryByText(review.title)).toBeNull();

    state.standupMode = true;
    state.standupUserId = 'example-member';
    state.projectId = 'example-project';
    board.rerender(<BoardView />);
    expect(screen.getByText(review.title)).toBeVisible();
    expect(screen.queryByText(otherTask.title)).toBeNull();

    state.standupMode = false;
    state.standupUserId = null;
    state.projectId = null;
    board.rerender(<BoardView />);
    expect(screen.queryByText(review.title)).toBeNull();
    expect(screen.getByText(otherTask.title)).toBeVisible();
  });

  it('provides a distinct drag handle without sacrificing swiping on the card surface or opening details', () => {
    mount();
    fireEvent.click(handle()); expect(state.open).not.toHaveBeenCalled();
    const text = title(); start(text);
    expect(move(text, 110)).toBe(true); hold(); end(text, 110);
    expect(overlayVisible()).toBe(false); expect(state.update).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(60); });
    fireEvent.click(text); expect(state.open).toHaveBeenCalledExactlyOnceWith(task);
  });

  it('holds the handle, drops in another status and preserves the existing status gate, dates, undo and announcement', async () => {
    mount(); const target = handle(); start(target);
    act(() => { vi.advanceTimersByTime(299); }); expect(overlayVisible()).toBe(false);
    act(() => { vi.advanceTimersByTime(1); }); expect(overlayVisible()).toBe(true);
    expect(move(target, 350)).toBe(false);
    act(() => { vi.advanceTimersByTime(20); });
    await act(async () => { end(target); });
    expect(state.gate).toHaveBeenCalledExactlyOnceWith(task, 'progress');
    expect(state.update).toHaveBeenCalledExactlyOnceWith(task.id, { statusId: 'progress', startedAt: expect.any(String) });
    expect(state.undo).toHaveBeenCalledTimes(1); expect(state.announce).toHaveBeenCalledTimes(1);
    expect(state.open).not.toHaveBeenCalled(); expect(overlayVisible()).toBe(false);
  });

  it('reports a refused guarded undo as failed without an optimistic rollback', async () => {
    state.update.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { result } = renderHook(useUndoStackState);
    state.undo.mockImplementationOnce(result.current.push);
    mount();
    await drop();

    const originalStart = state.update.mock.calls[0][1].startedAt;
    const undoAction = state.toast.mock.calls[0][1].action;
    const trace = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await act(async () => undoAction.onClick());
    } finally {
      trace.mockRestore();
    }
    expect(state.update).toHaveBeenLastCalledWith(task.id, { statusId: 'open', startedAt: undefined }, {
      projectId: task.projectId, statusId: 'progress', startedAt: originalStart, completedAt: undefined,
    });
    expect(state.setTasks).toHaveBeenCalledOnce();
    expect(state.error).toHaveBeenCalledWith('undo.failed');
    expect(state.success).not.toHaveBeenCalled();
  });

  it.each([1, 4, 7])('never captures a slow vertical card swipe of %s px after the handle activation delay', (distance) => {
    mount(); const text = title(); start(text);
    expect(move(text, 70, 100 + distance)).toBe(true);
    act(() => { vi.advanceTimersByTime(700); });
    expect(move(text, 70, 100 + distance)).toBe(true);
    end(text, 70, 100 + distance);
    expect(state.update).not.toHaveBeenCalled(); expect(overlayVisible()).toBe(false);
    fireEvent.click(text); expect(state.open).toHaveBeenCalledExactlyOnceWith(task);
  });

  it('keeps quick edits separate from a drag, including holding an icon nested in the action button', () => {
    mount();
    const buttons = screen.getAllByRole('button', { name: 'card.quickPriority' });
    const icon = buttons[0].querySelector('svg')!;
    start(icon as unknown as HTMLElement); hold();
    expect(overlayVisible()).toBe(false); end(icon as unknown as HTMLElement, 70);
    fireEvent.click(buttons[0]);
    expect(screen.getByRole('button', { name: '最高' })).toBeInTheDocument();
    expect(state.update).not.toHaveBeenCalled(); expect(state.open).not.toHaveBeenCalled();
  });

  it('cancels an interrupted drag and allows a subsequent normal tap', async () => {
    mount(); const target = handle(); start(target); hold();
    await act(async () => { fireEvent.touchCancel(target, { touches: [], changedTouches: [point()] }); });
    expect(state.update).not.toHaveBeenCalled(); expect(overlayVisible()).toBe(false);
    act(() => { vi.advanceTimersByTime(60); }); fireEvent.click(title());
    expect(state.open).toHaveBeenCalledExactlyOnceWith(task);
  });

  it('does not bypass a refused status transition or write to another project', async () => {
    mount(); state.refusal.mockReturnValue('Transition denied');
    await drop(); expect(state.update).not.toHaveBeenCalled(); expect(state.error).toHaveBeenCalledWith('Transition denied');
    act(() => { vi.advanceTimersByTime(60); }); state.gate.mockClear();
    await drop(900); expect(state.update).not.toHaveBeenCalled(); expect(state.gate).not.toHaveBeenCalled();
    expect(state.info).toHaveBeenCalledWith('board.dropOtherProject');
  });

  it('routes an approval-required drop through approval without saving or announcing a direct change', async () => {
    mount(); state.gate.mockReturnValue({ kind: 'approval' });
    await drop();
    expect(state.approval).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id, fromStatusId: 'open', toStatusId: 'progress' }));
    expect(state.update).not.toHaveBeenCalled(); expect(state.announce).not.toHaveBeenCalled();
  });

  it('does not announce or offer undo when the server refuses the save', async () => {
    mount(); state.update.mockResolvedValue(false); await drop();
    expect(state.update).toHaveBeenCalledTimes(1); expect(state.undo).not.toHaveBeenCalled(); expect(state.announce).not.toHaveBeenCalled();
  });

  it.each(['card', 'handle'])('preserves Space and Escape keyboard dragging from the %s', async surface => {
    mount();
    const target = surface === 'handle' ? handle() : screen.getByRole('button', { name: `task.ariaLabel: ${task.title}` });
    target.focus(); fireEvent.keyDown(target, { code: 'Space', key: ' ' });
    expect(overlayVisible()).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    await act(async () => { fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' }); });
    expect(overlayVisible()).toBe(false); expect(state.update).not.toHaveBeenCalled();
  });

  it.each(['card', 'handle'])('moves with ArrowRight and drops exactly once from the %s keyboard surface', async surface => {
    mount();
    const target = surface === 'handle' ? handle() : screen.getByRole('button', { name: `task.ariaLabel: ${task.title}` });
    target.focus(); fireEvent.keyDown(target, { code: 'Space', key: ' ' });
    act(() => { vi.advanceTimersByTime(1); });
    for (let index = 0; index < 8; index++) {
      fireEvent.keyDown(document, { code: 'ArrowRight', key: 'ArrowRight' });
      act(() => { vi.advanceTimersByTime(20); });
    }
    await act(async () => { fireEvent.keyDown(document, { code: 'Space', key: ' ' }); });
    expect(state.update).toHaveBeenCalledExactlyOnceWith(task.id, { statusId: 'progress', startedAt: expect.any(String) });
    expect(state.open).not.toHaveBeenCalled(); expect(overlayVisible()).toBe(false);
  });

  it('keeps Enter opening the card and does not start a keyboard drag from quick edit controls', () => {
    mount();
    const card = screen.getByRole('button', { name: `task.ariaLabel: ${task.title}` });
    fireEvent.keyDown(card, { key: 'Enter', code: 'Enter' });
    expect(state.open).toHaveBeenCalledExactlyOnceWith(task);
    const edit = screen.getAllByRole('button', { name: 'card.quickPriority' })[0];
    edit.focus(); fireEvent.keyDown(edit, { code: 'Space', key: ' ' });
    expect(overlayVisible()).toBe(false); expect(state.update).not.toHaveBeenCalled();
  });
});
