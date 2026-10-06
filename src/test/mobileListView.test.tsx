import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Task } from '@/types';

const state = vi.hoisted(() => ({ openTask: vi.fn(), mobile: true }));
const parent = { id: 'task-parent', taskKey: 'EX-1', title: 'Example parent task', projectId: 'project-example', statusId: 'open', priority: 'medium', createdAt: '2026-10-06T00:00:00Z' } as Task;
const child = { ...parent, id: 'task-child', taskKey: 'EX-2', title: 'Example child task', parentTaskId: parent.id } as Task;

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string, options?: { key?: string }) => options?.key ? `${key} ${options.key}` : key }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => state.mobile }));
vi.mock('@/hooks/useProjectColor', () => ({ useProjectColor: () => () => '#336699' }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ setSelectedTask: state.openTask }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ selectedProjectId: 'project-example', allProjects: [{ id: 'project-example', name: 'Example project' }], productLines: [] as never[] }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [parent, child], statuses: [{ id: 'open', name: 'Open', isDone: false }], tags: [] as never[] }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as never[] }) }));
vi.mock('@/context/SprintContext', () => ({ useSprintContext: () => ({ sprintActive: false, currentSprint: null as null, sprints: [] as never[] }) }));
vi.mock('@/hooks/useListColumns', () => ({ useListColumns: () => ({ columnConfig: { visibleColumns: [{ key: 'taskKey', label: 'Key', fixed: true }, { key: 'title', label: 'Title', fixed: true }, { key: 'status', label: 'Status' }, { key: 'assignee', label: 'Assignee' }] }, renderCell: (task: Task, key: string) => <span>{key}:{task.id}</span> }) }));
vi.mock('@/components/DepartmentFilter', () => ({ default: (): null => null }));
vi.mock('@/components/MultiSelectDropdown', () => ({ default: (): null => null }));
vi.mock('@/components/project/ProjectOptions', () => ({ ProjectMultiSelect: (): null => null }));
vi.mock('@/components/ColumnConfigDropdown', () => ({ default: (): null => null }));
vi.mock('@/components/BulkActionBar', () => ({ default: ({ selectedIds }: { selectedIds: Set<string> }) => <output aria-label="Selected tasks">{[...selectedIds].join(',')}</output> }));

import ListView from '@/components/ListView';

afterEach(() => { cleanup(); state.openTask.mockClear(); state.mobile = true; });

describe('mobile task list', () => {
  it('keeps task selection separate from opening a card and allows selecting all', () => {
    render(<ListView />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'list.selectTask EX-1' }));
    expect(screen.getByLabelText('Selected tasks')).toHaveTextContent('task-parent');
    expect(state.openTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'EX-1 Example parent task' }));
    expect(state.openTask).toHaveBeenCalledExactlyOnceWith(parent);
    fireEvent.click(screen.getByRole('checkbox', { name: 'button.selectAll' }));
    expect(screen.getByLabelText('Selected tasks')).toHaveTextContent('task-parent,task-child');
  });

  it('provides an accessible child-task toggle on the mobile card', () => {
    render(<ListView />);
    const toggle = screen.getByRole('button', { name: 'sidebar.collapse · EX-1' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(screen.queryByRole('button', { name: 'EX-2 Example child task' })).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'EX-2 Example child task' })).toBeInTheDocument();
    expect(state.openTask).not.toHaveBeenCalled();
  });
});
