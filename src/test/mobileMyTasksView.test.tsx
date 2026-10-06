import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '@/types';

const state = vi.hoisted(() => ({ openTask: vi.fn(), mobile: true }));
const task = { id: 'task-assigned', taskKey: 'EX-1', title: 'Alpha assigned task', projectId: 'project-example', statusId: 'open', assigneeId: 'member-self', reviewerId: 'member-other', priority: 'medium', createdAt: '2026-10-07T00:00:00Z' } as Task;
const reviewed = { ...task, id: 'task-reviewed', taskKey: 'EX-2', title: 'Beta reviewed task', assigneeId: 'member-other', reviewerId: 'member-self' };
const both = { ...task, id: 'task-both', taskKey: 'EX-3', title: 'Gamma shared role task', reviewerId: 'member-self' };
const outside = { ...task, id: 'task-outside', taskKey: 'EX-4', title: 'Outside project task', projectId: 'other-project' };

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string, options?: { key?: string }) => options?.key ? `${key} ${options.key}` : key }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => state.mobile }));
vi.mock('@/hooks/useProjectScope', () => ({ useProjectScope: () => ({ kind: 'project', inScope: (id: string) => id === 'project-example' }), useScopedProjectFilter: (): void => {} }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'member-self' }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ setSelectedTask: state.openTask, setCurrentView: vi.fn(), featureToggles: { qa: false }, featureTogglesReady: true }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [task, reviewed, both, outside], statuses: [{ id: 'open', name: 'Open', isDone: false, sortOrder: 0 }] }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [{ id: 'member-self', name: 'Example member', sortOrder: 1 }, { id: 'member-other', name: 'Another member', sortOrder: 2 }] }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [{ id: 'project-example', name: 'Example project' }] }) }));
vi.mock('@/context/SprintContext', () => ({ useSprintContext: () => ({ sprints: [] as never[] }) }));
vi.mock('@/hooks/useListColumns', () => ({ useListColumns: () => ({ columnConfig: { visibleColumns: [{ key: 'taskKey', label: 'Key', fixed: true }, { key: 'title', label: 'Title', fixed: true }, { key: 'status', label: 'Status' }, { key: 'assignee', label: 'Assignee' }] }, renderCell: (value: Task, key: string) => <span>{key}:{value.taskKey}</span> }) }));
vi.mock('@/components/MultiSelectDropdown', () => ({ default: (): null => null }));
vi.mock('@/components/project/ProjectOptions', () => ({ ProjectMultiSelect: (): null => null }));
vi.mock('@/components/ColumnConfigDropdown', () => ({ default: (): null => null }));
vi.mock('@/components/TaskCard', () => ({ default: ({ task: value }: { task: Task }) => <button onClick={() => state.openTask(value)}>{value.taskKey} {value.title}</button> }));
vi.mock('@/components/BulkActionBar', () => ({ default: ({ selectedIds }: { selectedIds: Set<string> }) => <output aria-label="Selected tasks">{[...selectedIds].join(',')}</output> }));

import MyTasksView from '@/components/MyTasksView';

afterEach(() => { cleanup(); state.openTask.mockClear(); state.mobile = true; localStorage.clear(); });

describe('mobile legacy personal task list', () => {
  it('shows the same scoped assigned/reviewed cards once, with visible status and assignee', () => {
    render(<MyTasksView />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.queryByText('Outside project task')).toBeNull();
    expect(screen.getByText('status:EX-1')).toBeInTheDocument();
    expect(screen.getByText('assignee:EX-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'EX-1 Alpha assigned task' }));
    expect(state.openTask).toHaveBeenCalledExactlyOnceWith(task);
  });

  it('selects cards independently and removes hidden selections when the role filter changes', () => {
    render(<MyTasksView />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'list.selectTask EX-2' }));
    expect(screen.getByLabelText('Selected tasks')).toHaveTextContent('task-reviewed');
    expect(state.openTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'myTasks.assignedToMe' }));
    expect(screen.queryByRole('checkbox', { name: 'list.selectTask EX-2' })).toBeNull();
    expect(screen.queryByLabelText('Selected tasks')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'button.selectAll' }));
    expect(screen.getByLabelText('Selected tasks')).toHaveTextContent('task-assigned,task-both');
  });

  it('keeps sorting and board/list switching over the same task set', () => {
    render(<MyTasksView />);
    fireEvent.click(screen.getByRole('button', { name: 'Title' }));
    fireEvent.click(screen.getByRole('button', { name: 'Title' }));
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Gamma shared role task');
    fireEvent.click(screen.getByRole('button', { name: 'myTasks.boardMode' }));
    expect(screen.getByRole('button', { name: 'EX-2 Beta reviewed task' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'myTasks.listMode' }));
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Gamma shared role task');
  });

  it('retains the desktop table', () => {
    state.mobile = false;
    render(<MyTasksView />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
  });
});
