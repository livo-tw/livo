import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { Project, Status, Task, User } from '@/types';
const mocks = vi.hoisted(() => ({ users: [] as User[], tasks: [] as Task[], projects: [] as Project[], sprintActive: false, speaker: vi.fn(), mode: vi.fn(), fetchActive: vi.fn(), durations: vi.fn(), update: vi.fn(), toast: vi.fn<(message: string, options?: { action: { label: string; onClick: () => void } }) => void>() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { count?: number; name?: string }) => {
  if (values?.name !== undefined) return `${key} ${values.name}`;
  return values?.count === undefined ? key : `${key} ${values.count}`;
} }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: mocks.users }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: mocks.tasks, statuses: [] as Status[] }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: mocks.projects }) }));
vi.mock('@/context/SprintContext', () => ({ useSprintContext: () => ({ sprintActive: mocks.sprintActive, currentSprint: undefined as { id: string } | undefined }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ setStandupUserId: mocks.speaker, setStandupMode: mocks.mode }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: null as string | null }) }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('sonner', () => ({ toast: Object.assign(mocks.toast, { error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/components/board/SprintModals', () => ({ SprintCompleteModal: (): null => null, SprintStartModal: (): null => null }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/standupQueries', () => ({ sessionQueries: { fetchActive: mocks.fetchActive, update: mocks.update }, memberDurationQueries: { fetchBySession: mocks.durations } }));
import StandupLaunchDialog from '@/components/StandupLaunchDialog';
import StandupPanel from '@/components/StandupPanel';
import { groupMembers, type QueueItem } from '@/hooks/useStandupGrouping';
import { useStandupSettings, type SortMode, type StandupSettings } from '@/hooks/useStandupSettings';
import { applyStandupOrder, clearStandupLaunch, getStandupLaunch, resolveStandupCursor, restoreStandupGroups, saveStandupLaunch, shuffleStandupOrder, standupQueueKey } from '@/lib/standupLaunch';

const member = (id: string, name: string, jobTitle: string, isActive = true): User => ({ id, name, jobTitle, isActive, avatar: name[0], color: '#667788', email: `${id}@example.com`, role: 'member', sortOrder: 0 });
const settings: StandupSettings = { sortMode: 'by_member', autoAdvance: true, defaultSpeakDuration: 120, bufferSeconds: 15, memberDurations: {} };
const oldSession = { data: { id: 'session1', default_speak_duration: 120, sort_mode: 'by_member', auto_advance: true, buffer_seconds: 15 }, error: null as null };
function LaunchFlow() {
  const [started, setStarted] = useState(false);
  return <><StandupLaunchDialog open={!started} onOpenChange={() => {}} onConfirm={() => setStarted(true)} />{started && <StandupPanel />}</>;
}
const visibleOrder = () => screen.getAllByRole('button').filter(button => mocks.users.some(user => user.name === button.getAttribute('aria-label'))).map(button => button.getAttribute('aria-label'));
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); clearStandupLaunch(); mocks.sprintActive = false;
  mocks.users = [member('a', 'Alex', 'FE'), member('b', 'Blair', 'PM'), member('c', 'Casey', 'BE'), member('inactive', 'Former member', 'QA', false)];
  mocks.projects = [{ id: 'alpha', name: 'Alpha' }, { id: 'zeta', name: 'Zeta' }] as Project[];
  mocks.tasks = [
    { id: 'ta', assigneeId: 'a', projectId: 'zeta', dueDate: '2099-01-01' },
    { id: 'tb', assigneeId: 'b', projectId: 'alpha', dueDate: '2000-01-01' },
    { id: 'tc', assigneeId: 'c', projectId: 'alpha', dueDate: '2099-01-02' },
    { id: 'td', assigneeId: 'inactive', projectId: 'alpha' },
    { id: 'te', assigneeId: 'missing-user', projectId: 'alpha' },
  ] as Task[];
  mocks.fetchActive.mockResolvedValue(oldSession); mocks.durations.mockResolvedValue({ data: [], error: null }); mocks.update.mockResolvedValue({ error: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); clearStandupLaunch(); });

describe('standup launch order and active participants', () => {
  it.each<SortMode>(['by_member', 'by_project', 'by_department', 'by_due_date'])('uses the preview order in the active %s meeting, without a second database settings read', async sortMode => {
    render(<LaunchFlow />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    const label = { by_member: 'byMember', by_project: 'byProject', by_department: 'byDepartment', by_due_date: 'byDueDate' }[sortMode];
    fireEvent.click(screen.getByRole('button', { name: `standup.sortMode.${label}` }));
    const expectedGroups = groupMembers(mocks.users, mocks.tasks, mocks.projects, sortMode, () => 120, 15);
    const preview = within(screen.getByRole('list', { name: 'standup.settings.preview' })).getAllByRole('listitem');
    expect(preview).toHaveLength(expectedGroups.length); expectedGroups.forEach((group, index) => expect(preview[index].textContent).toContain(group.group_title));
    const expectedNames = expectedGroups.flatMap(group => group.members.map(user => user.name));
    if (sortMode !== 'by_member') expect(expectedNames).not.toEqual(['Alex', 'Blair', 'Casey']);
    expect(screen.queryByText('Former member')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'standup.startButton' }));
    await waitFor(() => expect(visibleOrder()).toEqual(expectedNames));
    expect(mocks.fetchActive).toHaveBeenCalledTimes(1); expect(getStandupLaunch()?.settings.sortMode).toBe(sortMode);
    expect(screen.queryByText('Former member')).toBeNull(); expect(mocks.speaker).toHaveBeenLastCalledWith(expectedGroups[0].members[0].id);
  });
  it('closes with Esc like the other dialogs and keeps focus inside', async () => {
    const onOpenChange = vi.fn(), onCancel = vi.fn();
    render(<StandupLaunchDialog open onOpenChange={onOpenChange} onCancel={onCancel} />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1); expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it('shuffles on each click only and starts with the exact last preview order', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const view = render(<LaunchFlow />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    const shuffle = screen.getByRole('button', { name: 'standup.settings.shuffle' });
    fireEvent.click(shuffle);
    const first = within(screen.getByRole('list', { name: 'standup.settings.preview' })).getAllByRole('listitem').map(row => row.textContent);
    const calls = random.mock.calls.length; view.rerender(<LaunchFlow />); expect(random).toHaveBeenCalledTimes(calls);
    expect(within(screen.getByRole('list', { name: 'standup.settings.preview' })).getAllByRole('listitem').map(row => row.textContent)).toEqual(first);
    fireEvent.click(shuffle); expect(random.mock.calls.length).toBeGreaterThan(calls);
    const second = within(screen.getByRole('list', { name: 'standup.settings.preview' })).getAllByRole('listitem').map(row => row.textContent);
    expect(second).not.toEqual(first);
    const previewNames = second.map(text => mocks.users.find(user => text!.includes(user.name))!.name);
    const callsBeforeStart = random.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'standup.startButton' }));
    expect(visibleOrder()).toEqual(previewNames); expect(random).toHaveBeenCalledTimes(callsBeforeStart);
    view.rerender(<LaunchFlow />); expect(visibleOrder()).toEqual(previewNames); expect(random).toHaveBeenCalledTimes(callsBeforeStart);
  });
  it('retains project grouping while shuffling and filters orphan IDs when restoring the launch', () => {
    const groups = groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_project', () => 120, 15);
    const ordered = applyStandupOrder(groups, shuffleStandupOrder(groups, () => 0));
    expect(ordered.map(group => group.group_key)).toEqual(['zeta', 'alpha']);
    expect(ordered[1].members.map(user => user.id)).toEqual(['c', 'b']);
    saveStandupLaunch({ ...settings, sortMode: 'by_project' }, ordered);
    const snapshot = getStandupLaunch()!; snapshot.groups[0].memberIds.push('missing-user', 'inactive');
    const restored = restoreStandupGroups(snapshot, mocks.users, mocks.tasks, () => 120, 15);
    expect(restored.flatMap(group => group.members.map(user => user.id))).toEqual(['a', 'c', 'b']);
    expect(restored.reduce((sum, group) => sum + group.task_count, 0)).toBe(3);
    expect(restored.reduce((sum, group) => sum + group.estimated_duration, 0)).toBe(405);
  });
  it('preserves the selected speaker when another member disappears, then safely advances when the speaker is disabled', async () => {
    saveStandupLaunch(settings, groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_member', () => 120, 15));
    const view = render(<StandupPanel />); fireEvent.click(screen.getByRole('button', { name: 'Casey' }));
    expect(mocks.speaker).toHaveBeenLastCalledWith('c');
    mocks.users = mocks.users.filter(user => user.id !== 'a'); view.rerender(<StandupPanel />);
    expect(screen.getByRole('button', { name: 'Casey' })).toHaveAttribute('aria-current', 'step'); expect(mocks.speaker).toHaveBeenLastCalledWith('c');
    mocks.users = mocks.users.map(user => user.id === 'c' ? { ...user, isActive: false } : user); view.rerender(<StandupPanel />);
    expect(screen.queryByRole('button', { name: 'Casey' })).toBeNull(); expect(screen.getByRole('button', { name: 'Blair' })).toHaveAttribute('aria-current', 'step'); expect(mocks.speaker).toHaveBeenLastCalledWith('b');
    expect(screen.getByText(/1 \/ 1/)).toBeTruthy();
    mocks.users = []; view.rerender(<StandupPanel />);
    expect(screen.getByText(/0 \/ 0/)).toBeTruthy(); expect(screen.getByRole('button', { name: 'button.play' })).toBeDisabled(); expect(mocks.speaker).toHaveBeenLastCalledWith(null);
  });
  it('does not launch a meeting with only inactive members or orphan task assignees', async () => {
    mocks.users = [member('inactive', 'Former member', 'QA', false)];
    render(<LaunchFlow />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'standup.startButton' })).toBeDisabled(); expect(screen.getByText('standup.noActiveMembers')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'standup.settings.preview' })).toBeNull();
  });
  it('does not let an old database response override an explicit sort choice', async () => {
    let resolveDurations!: (value: unknown) => void;
    mocks.durations.mockImplementation(() => new Promise(resolve => { resolveDurations = resolve; }));
    const { result } = renderHook(() => useStandupSettings(['a', 'b']));
    await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    act(() => result.current.updateSettings({ sortMode: 'by_project' }));
    await act(async () => resolveDurations({ data: [], error: null }));
    expect(result.current.settings.sortMode).toBe('by_project'); expect(JSON.parse(localStorage.getItem('livo_standup_settings')!).sortMode).toBe('by_project');
  });
  it('uses both group and member identities for repeated project speakers', () => {
    const groups = groupMembers(mocks.users, [...mocks.tasks, { id: 'extra', assigneeId: 'a', projectId: 'alpha' } as Task], mocks.projects, 'by_project', () => 120, 15);
    const queue = groups.flatMap((group, groupIndex) => group.members.map((user, indexInGroup): QueueItem => ({ member: user, group, groupIndex, indexInGroup })));
    const last = queue[queue.length - 1];
    expect(last.member.id).toBe('a'); expect(resolveStandupCursor(queue, { key: standupQueueKey(last), index: 0 })).toBe(queue.length - 1);
  });
  it.each(['button', 'external-event'])('exits an unplayed standup via %s without claiming completion or prompting to end the sprint', exit => {
    mocks.sprintActive = true; saveStandupLaunch(settings, groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_member', () => 120, 15));
    render(<StandupPanel />);
    if (exit === 'button') fireEvent.click(screen.getByRole('button', { name: 'button.exit' })); else fireEvent(window, new Event('standup-exit'));
    expect(mocks.mode).toHaveBeenCalledWith(false); expect(mocks.speaker).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText('standup.completion.title')).toBeNull(); expect(screen.queryByText('sprint.prompt.description')).toBeNull(); expect(getStandupLaunch()).toBeUndefined();
  });
  it('offers the sprint completion choices only after the final scheduled report', () => {
    mocks.sprintActive = true; saveStandupLaunch(settings, groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_member', () => 120, 15));
    render(<StandupPanel />);
    for (let count = 0; count < 2; count++) { fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' })); expect(screen.queryByText('sprint.prompt.description')).toBeNull(); }
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByText('standup.completion.title')).toBeTruthy(); expect(screen.getByRole('dialog')).toBeTruthy(); expect(screen.getByText('sprint.prompt.description')).toBeTruthy();
    expect(mocks.mode).not.toHaveBeenCalled();
  });
  it('counts project report turns separately from the unique participants in the completion message', () => {
    mocks.tasks.push({ id: 'another-project', assigneeId: 'a', projectId: 'alpha' } as Task);
    const groups = groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_project', () => 120, 15);
    saveStandupLaunch({ ...settings, sortMode: 'by_project' }, groups); render(<StandupPanel />);
    expect(screen.getByText('1 / 4 standup.turnUnit')).toBeTruthy();
    for (let count = 0; count < 4; count++) fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByText('standup.completion.message 3')).toBeTruthy();
  });
});
describe('editing the standup report roster', () => {
  const control = (action: 'moveUp' | 'moveDown' | 'excludeNamed' | 'restoreNamed', name: string) => screen.getByRole('button', { name: `standup.queue.${action} ${name}` });
  const previewNames = () => within(screen.getByRole('list', { name: 'standup.settings.preview' })).getAllByRole('listitem').map(row => mocks.users.find(user => row.textContent?.includes(user.name))?.name);
  const estimatedMinutes = () => screen.getByText(/standup.settings.totalDuration/).textContent;

  it('starts the meeting in the manually adjusted preview order', async () => {
    render(<LaunchFlow />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    fireEvent.click(control('moveDown', 'Alex'));
    expect(previewNames()).toEqual(['Blair', 'Alex', 'Casey']);
    fireEvent.click(control('moveUp', 'Casey'));
    expect(previewNames()).toEqual(['Blair', 'Casey', 'Alex']);
    fireEvent.click(screen.getByRole('button', { name: 'standup.startButton' }));
    expect(visibleOrder()).toEqual(['Blair', 'Casey', 'Alex']);
    expect(mocks.speaker).toHaveBeenLastCalledWith('b');
  });
  it.each(['manual', 'shuffle'])('keeps the %s preview and launch order when older database settings arrive late', async action => {
    let resolveDurations!: (value: unknown) => void;
    mocks.fetchActive.mockResolvedValue({ ...oldSession, data: { ...oldSession.data, sort_mode: 'by_project' } });
    mocks.durations.mockImplementation(() => new Promise(resolve => { resolveDurations = resolve; }));
    render(<LaunchFlow />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    const stored = localStorage.getItem('livo_standup_settings');
    fireEvent.click(action === 'manual' ? control('moveDown', 'Alex') : screen.getByRole('button', { name: 'standup.settings.shuffle' }));
    const expected = previewNames();
    expect(localStorage.getItem('livo_standup_settings')).toBe(stored); expect(mocks.update).not.toHaveBeenCalled();
    await act(async () => resolveDurations({ data: [], error: null }));
    expect(previewNames()).toEqual(expected);
    fireEvent.click(screen.getByRole('button', { name: 'standup.startButton' }));
    expect(visibleOrder()).toEqual(expected); expect(getStandupLaunch()?.settings.sortMode).toBe('by_member');
  });
  it('cancels a keyboard drag with Esc while keeping the launch dialog open', async () => {
    const onCancel = vi.fn(), onOpenChange = vi.fn();
    render(<StandupLaunchDialog open onOpenChange={onOpenChange} onCancel={onCancel} />);
    await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    const handle = screen.getByRole('button', { name: 'standup.queue.dragMember Alex' });
    handle.focus(); fireEvent.keyDown(handle, { key: ' ', code: 'Space' });
    await waitFor(() => expect(handle).toHaveAttribute('aria-pressed', 'true'));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    fireEvent.keyDown(handle, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(handle).not.toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('keeps focus on the excluded person recovery control and restored report handle', async () => {
    render(<StandupLaunchDialog open onOpenChange={() => {}} />);
    await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    const exclude = control('excludeNamed', 'Blair');
    exclude.focus(); fireEvent.click(exclude);
    const restore = control('restoreNamed', 'Blair');
    expect(restore).toHaveFocus();
    fireEvent.click(restore);
    expect(screen.getByRole('button', { name: 'standup.queue.dragMember Blair' })).toHaveFocus();
  });

  it('updates estimated time and starts only the included report roster', async () => {
    render(<LaunchFlow />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    expect(estimatedMinutes()).toContain('7 common.minutes');
    fireEvent.click(control('excludeNamed', 'Blair'));
    expect(previewNames()).toEqual(['Alex', 'Casey']);
    expect(control('restoreNamed', 'Blair')).toBeTruthy();
    expect(estimatedMinutes()).toContain('5 common.minutes');
    fireEvent.click(screen.getByRole('button', { name: 'standup.startButton' }));
    const queue = within(screen.getByRole('list', { name: 'standup.queue.pending' }));
    expect(queue.queryByRole('button', { name: 'Blair' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Alex' })).toHaveAttribute('aria-current', 'step');
    expect(queue.getByRole('button', { name: 'Casey' })).toBeTruthy();
  });

  it('restores a member at the end of the report roster and restores the estimate', async () => {
    render(<LaunchFlow />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    fireEvent.click(control('excludeNamed', 'Alex'));
    fireEvent.click(control('restoreNamed', 'Alex'));
    expect(previewNames()).toEqual(['Blair', 'Casey', 'Alex']);
    expect(estimatedMinutes()).toContain('7 common.minutes');
    fireEvent.click(screen.getByRole('button', { name: 'standup.startButton' }));
    expect(visibleOrder()).toEqual(['Blair', 'Casey', 'Alex']);
  });

  it('preserves exclusions when shuffling or resetting the order', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    render(<LaunchFlow />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    fireEvent.click(control('excludeNamed', 'Blair'));
    fireEvent.click(screen.getByRole('button', { name: 'standup.settings.shuffle' }));
    expect(previewNames()).not.toContain('Blair');
    expect(control('restoreNamed', 'Blair')).toBeTruthy();
    fireEvent.click(control('moveDown', previewNames()[0]!));
    fireEvent.click(screen.getByRole('button', { name: 'standup.queue.reset' }));
    expect(previewNames()).toEqual(['Alex', 'Casey']);
    expect(control('restoreNamed', 'Blair')).toBeTruthy();
    expect(estimatedMinutes()).toContain('5 common.minutes');
    fireEvent.click(screen.getByRole('button', { name: 'standup.startButton' }));
    expect(visibleOrder()).toEqual(['Alex', 'Casey']);
  });

  it('disables starting when everyone is excluded and permits recovery', async () => {
    render(<StandupLaunchDialog open onOpenChange={() => {}} />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    for (const name of ['Alex', 'Blair', 'Casey']) fireEvent.click(control('excludeNamed', name));
    expect(screen.getByRole('button', { name: 'standup.startButton' })).toBeDisabled();
    expect(estimatedMinutes()).toContain('0 common.minutes');
    fireEvent.click(control('restoreNamed', 'Blair'));
    expect(screen.getByRole('button', { name: 'standup.startButton' })).toBeEnabled();
    expect(previewNames()).toEqual(['Blair']);
  });

  it('does not carry this meeting exclusions into the next meeting', async () => {
    const view = render(<LaunchFlow />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    fireEvent.click(control('excludeNamed', 'Blair'));
    fireEvent.click(screen.getByRole('button', { name: 'standup.startButton' }));
    fireEvent.click(screen.getByRole('button', { name: 'button.exit' }));
    expect(getStandupLaunch()).toBeUndefined();
    view.unmount(); render(<LaunchFlow />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(2));
    expect(previewNames()).toEqual(['Alex', 'Blair', 'Casey']);
    expect(screen.queryByRole('button', { name: 'standup.queue.restoreNamed Blair' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'standup.startButton' }));
    expect(visibleOrder()).toEqual(['Alex', 'Blair', 'Casey']);
  });

  it('excludes every project report turn for the selected person', async () => {
    mocks.tasks.push({ id: 'another-project', assigneeId: 'a', projectId: 'alpha' } as Task);
    render(<LaunchFlow />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'standup.sortMode.byProject' }));
    expect(screen.getAllByRole('button', { name: 'standup.queue.excludeNamed Alex' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'standup.queue.excludeNamed Alex' })[0]);
    expect(within(screen.getByRole('list', { name: 'standup.settings.preview' })).queryByText('Alex')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'standup.queue.restoreNamed Alex' })).toHaveLength(1);
    expect(estimatedMinutes()).toContain('5 common.minutes');
    fireEvent.click(screen.getByRole('button', { name: 'standup.startButton' }));
    expect(visibleOrder()).toEqual(['Blair', 'Casey']);
    expect(screen.getByText('1 / 2 standup.turnUnit')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByText('standup.completion.message 2')).toBeTruthy();
  });

  it('reorders project groups and their members without changing which projects they report in', async () => {
    mocks.tasks.push({ id: 'another-project', assigneeId: 'a', projectId: 'alpha' } as Task);
    render(<LaunchFlow />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'standup.sortMode.byProject' }));
    fireEvent.click(control('moveUp', 'Casey'));
    fireEvent.click(control('moveUp', '📁 Zeta'));
    const preview = within(screen.getByRole('list', { name: 'standup.settings.preview' })).getAllByRole('listitem');
    expect(preview[0].textContent).toContain('📁 Zeta');
    expect(preview[1].textContent).toContain('📁 Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'standup.startButton' }));
    expect(visibleOrder()).toEqual(['Alex', 'Alex', 'Casey', 'Blair']);
    expect(getStandupLaunch()?.groups.map(group => ({ project: group.group_key, members: group.memberIds }))).toEqual([
      { project: 'zeta', members: ['a'] }, { project: 'alpha', members: ['a', 'c', 'b'] },
    ]);
  });

  it('undoes an exclusion without losing the previous manual ordering', async () => {
    render(<StandupLaunchDialog open onOpenChange={() => {}} />); await waitFor(() => expect(mocks.durations).toHaveBeenCalledTimes(1));
    fireEvent.click(control('moveDown', 'Alex'));
    fireEvent.click(control('excludeNamed', 'Blair'));
    expect(previewNames()).toEqual(['Alex', 'Casey']);
    const undo = screen.getByRole('button', { name: 'standup.queue.undo' });
    undo.focus(); fireEvent.click(undo);
    expect(screen.getByRole('button', { name: 'standup.queue.dragMember Blair' })).toHaveFocus();
    expect(previewNames()).toEqual(['Blair', 'Alex', 'Casey']);
    expect(screen.queryByRole('button', { name: 'standup.queue.restoreNamed Blair' })).toBeNull();
    expect(estimatedMinutes()).toContain('7 common.minutes');
  });

  it('keeps the current speaker and running timer while pending reports are edited', () => {
    saveStandupLaunch(settings, groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_member', () => 120, 15));
    render(<StandupPanel />); vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'button.play' }));
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText('1:57')).toBeTruthy();
    fireEvent.click(control('moveUp', 'Casey'));
    fireEvent.click(control('excludeNamed', 'Blair'));
    fireEvent.click(control('restoreNamed', 'Blair'));
    const pending = within(screen.getByRole('list', { name: 'standup.queue.pending' }));
    expect(pending.getAllByRole('button').filter(button => ['Blair', 'Casey'].includes(button.getAttribute('aria-label') ?? '')).map(button => button.getAttribute('aria-label'))).toEqual(['Casey', 'Blair']);
    expect(screen.getByRole('button', { name: 'Alex' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'button.pause' })).toBeTruthy();
    expect(screen.getByText('1:57')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('1:56')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByRole('button', { name: 'Casey' })).toHaveAttribute('aria-current', 'step');
  });

  it('only counts reported people as complete after excluding pending and current reports', () => {
    saveStandupLaunch(settings, groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_member', () => 120, 15));
    render(<StandupPanel />);
    fireEvent.click(control('excludeNamed', 'Blair'));
    fireEvent.click(screen.getByRole('button', { name: 'standup.queue.skipCurrent' }));
    expect(screen.getByRole('button', { name: 'Casey' })).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByText('standup.completion.title')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByText('standup.completion.message 1')).toBeTruthy();
  });

  it('lets a meeting with every current report skipped recover without claiming reports or completing the sprint', () => {
    mocks.sprintActive = true;
    saveStandupLaunch(settings, groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_member', () => 120, 15));
    render(<StandupPanel />);
    for (let count = 0; count < 3; count++) fireEvent.click(screen.getByRole('button', { name: 'standup.queue.skipCurrent' }));
    const completion = screen.getByText('standup.completion.message 0').parentElement!;
    expect(screen.queryByText('sprint.prompt.description')).toBeNull();
    expect(screen.queryByRole('button', { name: 'button.play' })).toBeNull();
    fireEvent.click(within(completion).getByRole('button', { name: 'standup.queue.restoreNamed Blair' }));
    expect(screen.queryByText('standup.completion.title')).toBeNull();
    expect(screen.getByRole('button', { name: 'Blair' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'button.play' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByText('standup.completion.message 1')).toBeTruthy();
    expect(screen.getByText('sprint.prompt.description')).toBeTruthy();
  });

  it('restores a preexcluded reporter after advancing to the end of the pending queue without changing the running timer', () => {
    saveStandupLaunch(settings, groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_member', () => 120, 15), ['b']);
    render(<StandupPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByRole('button', { name: 'Casey' })).toHaveAttribute('aria-current', 'step');
    vi.useFakeTimers(); fireEvent.click(screen.getByRole('button', { name: 'button.play' }));
    act(() => { vi.advanceTimersByTime(2000); });
    fireEvent.click(control('restoreNamed', 'Blair'));
    expect(screen.getByRole('button', { name: 'Casey' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'button.pause' })).toBeTruthy();
    expect(screen.getByText('1:58')).toBeTruthy();
    const pending = within(screen.getByRole('list', { name: 'standup.queue.pending' }));
    expect(pending.getByRole('button', { name: 'Blair' })).toBeTruthy();
    expect(pending.queryByRole('button', { name: 'Alex' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByRole('button', { name: 'Blair' })).toHaveAttribute('aria-current', 'step');
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByText('standup.completion.message 3')).toBeTruthy();
  });

  it('excludes future project reports for the current person while preserving their current report and timer', () => {
    mocks.tasks.push({ id: 'another-project', assigneeId: 'a', projectId: 'alpha' } as Task);
    const groups = groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_project', () => 120, 15);
    saveStandupLaunch({ ...settings, sortMode: 'by_project' }, groups); render(<StandupPanel />);
    vi.useFakeTimers(); fireEvent.click(screen.getByRole('button', { name: 'button.play' }));
    act(() => { vi.advanceTimersByTime(2000); });
    fireEvent.click(control('excludeNamed', 'Alex'));
    expect(screen.getByRole('button', { name: 'Alex' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'button.pause' })).toBeTruthy();
    expect(screen.getByText('1:58')).toBeTruthy();
    expect(screen.getByText('1 / 3 standup.turnUnit')).toBeTruthy();
    const pending = within(screen.getByRole('list', { name: 'standup.queue.pending' }));
    expect(pending.queryByRole('button', { name: 'Alex' })).toBeNull();
    for (let count = 0; count < 3; count++) fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByText('standup.completion.message 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'button.backToList' }));
    expect(screen.getByText('standup.queue.completed (3)')).toBeTruthy();
  });

  it('returns the previous speaker to pending when selecting someone else without claiming the unspoken report', () => {
    saveStandupLaunch(settings, groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_member', () => 120, 15));
    render(<StandupPanel />); fireEvent.click(screen.getByRole('button', { name: 'Casey' }));
    const pending = within(screen.getByRole('list', { name: 'standup.queue.pending' }));
    expect(screen.getByRole('button', { name: 'Casey' })).toHaveAttribute('aria-current', 'step');
    expect(pending.getByRole('button', { name: 'Alex' })).toBeTruthy();
    expect(pending.getByRole('button', { name: 'Blair' })).toBeTruthy();
    expect(screen.queryByText(/standup.queue.completed/)).toBeNull();
    fireEvent.click(control('excludeNamed', 'Alex'));
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByRole('button', { name: 'Blair' })).toHaveAttribute('aria-current', 'step');
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByText('standup.completion.message 2')).toBeTruthy();
  });

  it('returns from the sprint prompt to restore an excluded reporter without exiting or replaying completed reports', () => {
    mocks.sprintActive = true;
    saveStandupLaunch(settings, groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_member', () => 120, 15), ['b']);
    render(<StandupPanel />);
    for (let count = 0; count < 2; count++) fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByText('standup.completion.message 2')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'button.backToList' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('standup.completion.title')).toBeNull();
    expect(screen.getByText('standup.queue.completed (2)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'button.play' })).toBeDisabled();
    expect(mocks.mode).not.toHaveBeenCalled();
    fireEvent.click(control('restoreNamed', 'Blair'));
    expect(screen.getByRole('button', { name: 'Blair' })).toHaveAttribute('aria-current', 'step');
    expect(screen.queryByRole('button', { name: 'Alex' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Casey' })).toBeNull();
    expect(screen.getByRole('button', { name: 'button.play' })).toBeEnabled();
    expect(mocks.mode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByText('standup.completion.message 3')).toBeTruthy();
  });

  it('closes the sprint prompt and resumes the recovered report when undoing the exclusion toast', () => {
    mocks.sprintActive = true;
    saveStandupLaunch(settings, groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_member', () => 120, 15));
    render(<StandupPanel />); fireEvent.click(control('excludeNamed', 'Blair'));
    const undo = mocks.toast.mock.calls[0]?.[1]?.action.onClick;
    expect(undo).toBeDefined();
    for (let count = 0; count < 2; count++) fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByText('sprint.prompt.description')).toBeTruthy();
    act(() => undo?.());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('standup.completion.title')).toBeNull();
    expect(screen.getByRole('button', { name: 'Blair' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('standup.queue.completed (2)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'button.play' })).toBeEnabled();
    expect(mocks.mode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByText('standup.completion.message 3')).toBeTruthy();
    expect(screen.getByText('sprint.prompt.description')).toBeTruthy();
  });

  it('resumes a reenabled pending reporter after eligible reports have finished without replaying completed people', () => {
    saveStandupLaunch(settings, groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_member', () => 120, 15));
    const view = render(<StandupPanel />);
    mocks.users = mocks.users.map(user => user.id === 'b' ? { ...user, isActive: false } : user);
    view.rerender(<StandupPanel />);
    for (let count = 0; count < 2; count++) fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByText('standup.completion.message 2')).toBeTruthy();
    mocks.users = mocks.users.map(user => user.id === 'b' ? { ...user, isActive: true } : user);
    view.rerender(<StandupPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'button.backToList' }));
    fireEvent.click(screen.getByRole('button', { name: 'Blair' }));
    expect(screen.getByRole('button', { name: 'Blair' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'button.play' })).toBeEnabled();
    expect(screen.getByText('standup.queue.completed (2)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Alex' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Casey' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByText('standup.completion.message 3')).toBeTruthy();
  });

  it('presents reported people in their actual completion order after changing the current speaker', () => {
    saveStandupLaunch(settings, groupMembers(mocks.users, mocks.tasks, mocks.projects, 'by_member', () => 120, 15));
    render(<StandupPanel />); fireEvent.click(screen.getByRole('button', { name: 'Casey' }));
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByRole('button', { name: 'Alex' })).toHaveAttribute('aria-current', 'step');
    fireEvent.click(screen.getByRole('button', { name: 'button.skipToNext' }));
    expect(screen.getByRole('button', { name: 'Blair' })).toHaveAttribute('aria-current', 'step');
    const history = within(screen.getByText('standup.queue.completed (2)').parentElement!);
    expect(history.getByText('Casey').compareDocumentPosition(history.getByText('Alex')) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
});
