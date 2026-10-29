import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Status, Task } from '@/types';
import { useDashboardData } from '@/components/dashboard/useDashboardData';
import DashboardProductLines from '@/components/dashboard/DashboardProductLines';
import DashboardProjectProgress from '@/components/dashboard/DashboardProjectProgress';
import MemberListView from '@/components/MemberListView';
import { useMemberManage } from '@/components/member-manage/useMemberManage';
import { useWorkReport } from '@/components/work-report/useWorkReport';
import { generateReportContent } from '@/lib/reportGenerator';

const state = vi.hoisted(() => ({
  tasks: [] as Task[], statuses: [] as Status[],
  users: [{ id: 'me', name: 'Alex', jobTitle: 'Engineer', role: 'super_admin', isActive: true, avatar: 'A', color: '#123456' }],
  projects: [{ id: 'p1', name: 'Project one', key: 'ONE', color: '#123456', lineId: 'line' }, { id: 'p2', name: 'Project two', key: 'TWO', color: '#654321', lineId: 'line' }],
  lines: [{ id: 'line', name: 'Product line' }],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key, language: 'en' } }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: state.tasks, statuses: state.statuses, statusLogs: [] as never[], comments: [] as never[] }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: state.users, refreshUsers: vi.fn() }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: state.projects, productLines: state.lines }) }));
vi.mock('@/context/SprintContext', () => ({ useSprintContext: () => ({ sprints: [] as never[], currentSprint: null as null, sprintActive: false }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'me', currentMember: { id: 'me', role: 'super_admin' }, permissions: { canViewMemberList: true } }) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ hasFeature: () => false }) }));
vi.mock('@/hooks/useProjectScope', () => ({ useProjectScope: () => ({ projectIds: null as null }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/usePresenceLock', () => ({ usePresenceLock: () => ({ viewers: [] as never[], acquireLock: vi.fn(), releaseLock: vi.fn(), isLockedBy: (): null => null }) }));
vi.mock('@/components/ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(), ConfirmDialog: null as null }) }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => {
  const query: Record<string, unknown> = {};
  for (const key of ['select', 'eq', 'order']) query[key] = () => query;
  query.limit = async (): Promise<{ data: never[]; error: null }> => ({ data: [], error: null });
  query.maybeSingle = async (): Promise<{ data: null; error: null }> => ({ data: null, error: null });
  return query;
} } }));

const task = (id: string, statusId: string, projectId = 'p1'): Task => ({
  id, statusId, projectId, taskKey: id, title: id, priority: 'medium', creatorId: 'me', assigneeId: 'me', sortOrder: 0,
  commentCount: 0, attachmentCount: 0, deployments: [],
  createdAt: '2026-10-26T10:00:00.000Z',
  ...(statusId === 'done' ? { completedAt: '2026-10-28T10:00:00.000Z' } : {}),
  ...(statusId === 'cancel' ? { completedAt: '2026-10-28T10:00:00.000Z', createdAt: '2026-09-01T10:00:00.000Z' } : {}),
});
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
  state.statuses = [
    { id: 'todo', name: 'Open', isDone: false, sortOrder: 0, color: '#111111', autoStart: false, autoDone: false },
    { id: 'done', name: 'Completed', isDone: true, sortOrder: 1, color: '#222222', autoStart: false, autoDone: true }, // Legacy rows lack isCancelled.
    { id: 'cancel', name: 'Custom terminal label', isDone: true, isCancelled: true, sortOrder: 2, color: '#333333', autoStart: false, autoDone: false },
  ];
  state.tasks = [task('D1', 'done'), task('D2', 'done'), task('C1', 'cancel'), task('C2', 'cancel'), task('P1', 'todo'), task('P2', 'todo', 'p2')];
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('completed statistics distinguish cancellation from terminal work', () => {
  it('counts the same six cards as 2 completed, 2 cancelled and 2 open at line/project scope', () => {
    const { result } = renderHook(useDashboardData);
    expect(result.current.lineData[0]).toMatchObject({ total: 6, done: 2, cancelled: 2, active: 2, pct: 33 });
    expect(result.current.projectProgressData.find(project => project.id === 'p1')).toMatchObject({ total: 5, done: 2, cancelled: 2, inProgress: 1, pct: 40 });
    expect(result.current.projectProgressData.find(project => project.id === 'p2')).toMatchObject({ total: 1, done: 0, cancelled: 0, inProgress: 1, pct: 0 });
    expect(result.current.teamData[0].avgCreateToComplete).toBe(2);
  });
  it('retains legacy done rows without the new flag and uses flags rather than a translated status name', () => {
    state.statuses[1].name = 'Cancelled'; // A label alone cannot reclassify a legacy done status.
    state.statuses[2].name = 'Completed';
    const { result } = renderHook(useDashboardData);
    expect(result.current.lineData[0]).toMatchObject({ done: 2, cancelled: 2, active: 2 });
    expect(result.current.statusData.map(status => status.count)).toEqual([2, 2, 2]);
  });
  it('renders cancellations separately without adding them to completed or active cards', () => {
    const { result } = renderHook(useDashboardData);
    const { unmount } = render(<DashboardProductLines lineData={result.current.lineData} />);
    expect(screen.getByText('dashboard.completed').previousElementSibling).toHaveTextContent('2');
    expect(screen.getByText('dashboard.cancelled').previousElementSibling).toHaveTextContent('2');
    expect(screen.getByText('dashboard.inProgress').previousElementSibling).toHaveTextContent('2');
    expect(screen.getByText('33%')).toBeInTheDocument();
    unmount();
    render(<DashboardProjectProgress projectProgressData={result.current.projectProgressData.filter(project => project.id === 'p1')} />);
    expect(screen.getByText('dashboard.completed').previousElementSibling).toHaveTextContent('2');
    expect(screen.getByText('dashboard.cancelled').previousElementSibling).toHaveTextContent('2');
    expect(screen.getByText('dashboard.inProgress').previousElementSibling).toHaveTextContent('1');
    expect(screen.getByText('40%')).toBeInTheDocument();
  });
  it('does not put a cancelled card without completedAt back into overdue or active totals', () => {
    state.tasks = [task('cancel-no-time', 'cancel')]; delete state.tasks[0].completedAt;
    state.tasks[0].dueDate = '2026-01-01';
    const { result } = renderHook(useDashboardData);
    expect(result.current.lineData[0]).toMatchObject({ total: 1, done: 0, cancelled: 1, active: 0, pct: 0 });
    expect(result.current.overdueTasks).toBe(0);
    expect(result.current.teamData[0].overdue).toBe(0);
  });
  it('member list and administration count completed statuses, not every terminal timestamp', async () => {
    const { result } = renderHook(useMemberManage);
    await act(async () => {});
    expect(result.current.memberStats[0].completedCount).toBe(2);
    render(<MemberListView />);
    const row = screen.getByText('Alex').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('2')).toBeInTheDocument();
    expect(within(row!).queryByText('4')).not.toBeInTheDocument();
  });
  it('automatic report templates exclude cancellation from completed and open counts', () => {
    const report = generateReportContent({ reportType: 'daily', tasks: state.tasks, statuses: state.statuses, memberId: 'me', customTemplate: '{{task_count}}/{{completed_count}}/{{in_progress_count}}/{{overdue_count}}' });
    expect(report.content).toBe('6/2/2/0');
  });
  it('manual report statistics keep cancellations out of both completed and unfinished buckets', async () => {
    const { result } = renderHook(useWorkReport);
    await act(async () => {});
    expect(result.current).toMatchObject({ completedCount: 2, inProgressCount: 2, overdueCount: 0 });
  });
});
