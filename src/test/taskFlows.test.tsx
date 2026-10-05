import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomField, Project, Status, Task, TaskCustomFieldValue, User } from '@/types';

const mocks = vi.hoisted(() => ({
  completeSprint: vi.fn(), startSprint: vi.fn(), logActivity: vi.fn(), slack: vi.fn(), notify: vi.fn(),
  currentSprint: { id: 'sprint-1', name: 'Sprint 1' } as { id: string; name: string } | null,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const translate = vi.hoisted(() => (key: string, values?: Record<string, unknown>) => values ? `${key}:${JSON.stringify(values)}` : key);
vi.mock('i18next', () => ({ default: { t: translate } }));
vi.mock('@/i18n', () => ({ default: { t: translate } }));
vi.mock('@/context/SprintContext', () => ({ useSprintContext: () => ({ currentSprint: mocks.currentSprint, completeSprint: mocks.completeSprint, startSprint: mocks.startSprint }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'me' }) }));
vi.mock('@/lib/activityLog', () => ({ logActivity: mocks.logActivity }));
vi.mock('@/lib/slackNotify', () => ({ sendSlackNotify: mocks.slack }));
vi.mock('@/components/task-detail/utils', () => ({ createNotification: mocks.notify }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ approvalsEnabled: false, featureTogglesReady: true }) }));
import { useSprintFlow } from '@/hooks/useSprintFlow';
import { useBulkActions } from '@/hooks/useBulkActions';
import { announceAssignment, announceStatusChange, type TaskAnnouncementContext } from '@/lib/taskAnnouncements';
import { formatCustomFieldValue } from '@/lib/customFieldDisplay';
import { useTaskStatusChange } from '@/components/task-detail/hooks/useTaskStatusChange';

const task = (id: string, more: Partial<Task> = {}) => ({ id, taskKey: id.toUpperCase(), title: `Title ${id}`, statusId: 'todo', projectId: 'p1', priority: 'medium', ...more }) as Task;
const person = (id: string, name: string) => ({ id, name, email: `${id}@example.com` }) as User;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentSprint = { id: 'sprint-1', name: 'Sprint 1' };
  mocks.slack.mockResolvedValue(undefined);
  mocks.startSprint.mockResolvedValue(true);
});

describe('completing and starting a sprint', () => {
  it('moves unfinished tasks to the next sprint: the start dialog opens with them', async () => {
    mocks.completeSprint.mockResolvedValue({ pendingIds: ['a', 'b'] });
    const { result } = renderHook(() => useSprintFlow());
    await act(async () => { await result.current.complete('next-sprint'); });
    expect(result.current.showStartModal).toBe(true);
    expect(result.current.carryOverTaskIds).toEqual(['a', 'b']);
    // Opening the start dialog again (the board's button) keeps them.
    act(() => result.current.openStart());
    expect(result.current.carryOverTaskIds).toEqual(['a', 'b']);
    await act(async () => { await result.current.confirmStart('Sprint 2', false); });
    expect(mocks.startSprint).toHaveBeenCalledWith('Sprint 2', ['a', 'b'], false);
    expect(result.current.carryOverTaskIds).toEqual([]);
    expect(mocks.logActivity).toHaveBeenCalledWith('me', 'start_sprint', expect.any(String), undefined, undefined, 'sprint');
  });

  it('does not open the start dialog or log anything when completing failed', async () => {
    mocks.completeSprint.mockResolvedValue(null);
    const { result } = renderHook(() => useSprintFlow());
    await act(async () => { await result.current.complete('next-sprint'); });
    expect(result.current.showStartModal).toBe(false);
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it('back to the backlog: no start dialog on the board, but the stand-up always offers the next sprint', async () => {
    mocks.completeSprint.mockResolvedValue({ pendingIds: ['a'] });
    const board = renderHook(() => useSprintFlow());
    await act(async () => { await board.result.current.complete('backlog'); });
    expect(board.result.current.showStartModal).toBe(false);
    const closed = vi.fn();
    const standup = renderHook(() => useSprintFlow({ startAfterComplete: 'always', onStartClosed: closed }));
    await act(async () => { await standup.result.current.complete('backlog'); });
    expect(standup.result.current.showStartModal).toBe(true);
    expect(standup.result.current.carryOverTaskIds).toEqual([]);
    act(() => standup.result.current.cancelStart());
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe('bulk selection', () => {
  it('drops tasks a filter hides, so a bulk action never changes them', () => {
    const all = [task('a'), task('b'), task('c')];
    const { result, rerender } = renderHook(({ shown }) => useBulkActions(shown), { initialProps: { shown: all } });
    act(() => result.current.selectAll());
    expect(result.current.selectedIds.size).toBe(3);
    rerender({ shown: [all[0]] });
    expect([...result.current.selectedIds]).toEqual(['a']);
    expect(result.current.isAllSelected).toBe(true);
    // Clearing the filter does not bring the hidden ones back.
    rerender({ shown: all });
    expect([...result.current.selectedIds]).toEqual(['a']);
    act(() => result.current.toggleSelect('b'));
    expect([...result.current.selectedIds].sort()).toEqual(['a', 'b']);
  });
});

describe('announcements after a saved change', () => {
  const statuses = [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }] as Status[];
  const ctx = (rules = vi.fn()): TaskAnnouncementContext => ({ actor: person('me', 'Me'), users: [person('dev', 'Dev'), person('rev', 'Rev')], projects: [{ id: 'p1', name: 'Project' } as Project], statuses, showRules: rules });

  it('tells the assignee and reviewer once each, Slack and the notification rules', () => {
    const rules = vi.fn();
    announceStatusChange(task('t1', { assigneeId: 'dev', reviewerId: 'dev' }), 'todo', 'done', ctx(rules));
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith('dev', 'me', 'status_changed', 't1', expect.stringContaining('Done'));
    expect(mocks.slack).toHaveBeenCalledWith(expect.objectContaining({ type: 'status_changed', fromStatus: 'To do', toStatus: 'Done', projectName: 'Project', assigneeName: 'Dev' }));
    expect(rules).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }), 'To do', 'Done');
  });

  it('tells a new assignee; bulk edits skip Slack; no message for the same assignee', () => {
    announceAssignment(task('t1', { assigneeId: 'rev' }), 'dev', ctx());
    expect(mocks.notify).toHaveBeenCalledWith('dev', 'me', 'assign', 't1', 'Title t1');
    expect(mocks.slack).toHaveBeenCalledWith(expect.objectContaining({ type: 'assignee_changed', oldAssignee: 'Rev', newAssignee: 'Dev', dmTargets: [expect.objectContaining({ email: 'dev@example.com' })] }));
    vi.clearAllMocks();
    announceAssignment(task('t2'), 'dev', ctx(), { slack: false });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.slack).not.toHaveBeenCalled();
    vi.clearAllMocks();
    announceAssignment(task('t3', { assigneeId: 'dev' }), 'dev', ctx());
    announceAssignment(task('t4'), null, ctx());
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});

describe('custom field values on cards', () => {
  const field = (fieldType: CustomField['fieldType']) => ({ id: 'f', fieldName: 'Field', fieldType }) as CustomField;
  const value = (more: Partial<TaskCustomFieldValue>) => ({ id: 'v', taskId: 't', fieldId: 'f', ...more }) as TaskCustomFieldValue;
  const t = (key: string) => key;
  it('reads the value for the field type instead of a missing "value" property', () => {
    expect(formatCustomFieldValue(field('text'), value({ valueText: 'Hello' }), [], t)).toBe('Hello');
    expect(formatCustomFieldValue(field('number'), value({ valueNumber: 0 }), [], t)).toBe('0');
    expect(formatCustomFieldValue(field('date'), value({ valueDate: '2026-10-04' }), [], t)).toBe('2026-10-04');
    expect(formatCustomFieldValue(field('boolean'), value({ valueBoolean: false }), [], t)).toBe('customField.booleanNo');
    expect(formatCustomFieldValue(field('user'), value({ valueUserId: 'dev' }), [person('dev', 'Dev')], t)).toBe('Dev');
    expect(formatCustomFieldValue(field('select'), undefined, [], t)).toBeNull();
  });
});

describe('changing status in the task detail', () => {
  const statuses = [{ id: 'todo', name: 'To do', isDone: false }, { id: 'done', name: 'Done', isDone: true }] as Status[];
  const render = (saved: boolean) => renderHook(() => useTaskStatusChange({
    task: task('t1', { assigneeId: 'dev' }), project: { id: 'p1', name: 'Project' } as Project, statuses, statusLogs: [], users: [person('dev', 'Dev')],
    currentMemberId: 'me', currentMember: person('me', 'Me'), assignee: person('dev', 'Dev'),
    updateTask: vi.fn().mockResolvedValue(saved), setAllTasks: vi.fn(), setSelectedTask: vi.fn(),
    canTransitionTo: () => ({ allowed: true, missingStatusIds: [] }), triggerNotification: vi.fn(),
    getRuleForTransition: vi.fn().mockResolvedValue(null), requestApproval: vi.fn(),
  }));
  it('tells nobody when the save was refused, and the assignee once it was saved', async () => {
    const refused = render(false);
    await act(async () => { await refused.result.current.handleStatusChange('done'); });
    expect(mocks.notify).not.toHaveBeenCalled(); expect(mocks.slack).not.toHaveBeenCalled();
    const saved = render(true);
    await act(async () => { await saved.result.current.handleStatusChange('done'); });
    expect(mocks.notify).toHaveBeenCalledWith('dev', 'me', 'status_changed', 't1', expect.any(String));
    expect(mocks.slack).toHaveBeenCalledTimes(1);
  });
});
