import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { Project, Status, Task, User } from '@/types';
const mocks = vi.hoisted(() => ({ users: [] as User[], tasks: [] as Task[], projects: [] as Project[], sprintActive: false, speaker: vi.fn(), mode: vi.fn(), fetchActive: vi.fn(), durations: vi.fn(), update: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { count?: number }) => values?.count === undefined ? key : `${key} ${values.count}` }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: mocks.users }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: mocks.tasks, statuses: [] as Status[] }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: mocks.projects }) }));
vi.mock('@/context/SprintContext', () => ({ useSprintContext: () => ({ sprintActive: mocks.sprintActive, currentSprint: undefined as { id: string } | undefined }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ setStandupUserId: mocks.speaker, setStandupMode: mocks.mode }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: null as string | null }) }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); clearStandupLaunch(); });

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
