import { createRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CustomField, ProductLine, Project, Status, Tag, Task, User } from '@/types';
import type { TaskDetailState } from '@/components/task-detail/hooks/useTaskDetail';

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ approvalsEnabled: false }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/components/PortalConfirmDialog', () => ({ usePortalConfirmDialog: () => ({ confirm: vi.fn(), ConfirmDialog: null as null }) }));
import TaskSidebarFields from '@/components/task-detail/TaskSidebarFields';
import TaskSubtasksTab from '@/components/task-detail/TaskSubtasksTab';

const statuses: Status[] = ['Open', 'Working', 'Code review', 'QA review', 'Ready', 'Complete'].map((name, index) => ({
  id: `state-${index}`, name, color: index === 5 ? '#00875A' : '#6554C0', sortOrder: index,
  isDone: index === 5, autoStart: false, autoDone: false,
}));
const parent: Task = { id: 'task-parent', taskKey: 'EX-1', projectId: 'project-example', title: 'Example parent', statusId: statuses[0].id,
  priority: 'medium', creatorId: 'member-example', sortOrder: 0, createdAt: '2026-10-03T00:00:00Z', commentCount: 0, attachmentCount: 0, deployments: [] };
const child: Task = { ...parent, id: 'task-child', taskKey: 'EX-2', title: 'Example child', parentTaskId: parent.id };
const unrelated: Task = { ...parent, id: 'task-unrelated', taskKey: 'EX-3', title: 'Unrelated example' };

function baseDetail() {
  return { task: parent, statuses, allProjects: [] as Project[], productLines: [] as ProductLine[], users: [] as User[], tags: [] as Tag[], customFields: [] as CustomField[],
    permissions: { canEditProject: false, canDeleteTask: false }, sidebarFieldOrder: ['status'], SIDEBAR_DEFAULT_ORDER: ['status'],
    statusDropdownRef: createRef<HTMLDivElement>(), tagDropdownRef: createRef<HTMLDivElement>(),
    statusDropdownOpen: false, setStatusDropdownOpen: vi.fn(), handleStatusChange: vi.fn(), updateTask: vi.fn(),
    newSubtaskTitle: '', setNewSubtaskTitle: vi.fn(), subtaskInputRef: createRef<HTMLInputElement>(),
    subtaskStatusPickerId: null as string | null, setSubtaskStatusPickerId: vi.fn(), handleCreateSubtask: vi.fn(),
    setSelectedTask: vi.fn(), updateTaskInDb: vi.fn(), isMobile: false };
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); });

describe('task status dropdown search', () => {
  it('searches more than five existing statuses and delegates to the existing transition handler without directly writing the task', async () => {
    const detail = baseDetail();
    render(<TaskSidebarFields detail={detail as unknown as TaskDetailState} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'taskDetail.sidebar.status' }));
    const list = await screen.findByRole('listbox', { name: 'taskDetail.sidebar.status' });
    const search = screen.getByRole('combobox', { name: 'common.search · taskDetail.sidebar.status' });
    fireEvent.change(search, { target: { value: 'A new state that does not exist' } });
    expect(within(list).queryAllByRole('option')).toHaveLength(0);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(detail.handleStatusChange).not.toHaveBeenCalled();
    fireEvent.change(search, { target: { value: 'REVIEW' } });
    expect(within(list).getAllByRole('option').map(option => option.textContent)).toEqual(['Code review', 'QA review']);
    fireEvent.click(within(list).getByRole('option', { name: 'Code review' }));
    expect(detail.handleStatusChange).toHaveBeenCalledExactlyOnceWith('state-2');
    expect(detail.updateTask).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });
  it('preserves the compact menu and transition handler when there are at most five statuses', () => {
    const detail = { ...baseDetail(), statuses: statuses.slice(0, 5), statusDropdownOpen: true };
    render(<TaskSidebarFields detail={detail as unknown as TaskDetailState} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Code review' }));
    expect(detail.handleStatusChange).toHaveBeenCalledExactlyOnceWith('state-2');
    expect(detail.setStatusDropdownOpen).toHaveBeenCalledWith(false);
    expect(detail.updateTask).not.toHaveBeenCalled();
  });
});

describe('subtask status dropdown search', () => {
  it('keeps the coloured dot trigger and updates only the selected child when choosing a searched existing status', async () => {
    const detail = baseDetail();
    function Subtasks() {
      const [tasks, setTasks] = useState([parent, child, unrelated]);
      return <><TaskSubtasksTab detail={{ ...detail, allTasks: tasks, setAllTasks: setTasks } as unknown as TaskDetailState} />
        <output aria-label="Current task states">{tasks.map(task => `${task.id}:${task.statusId}`).join(',')}</output></>;
    }
    render(<Subtasks />);
    const dot = screen.getByRole('combobox', { name: 'taskDetail.subtasks.changeStatus' });
    expect(dot).toHaveStyle({ width: '10px', height: '10px', backgroundColor: '#6554C0' });
    fireEvent.click(dot);
    const list = await screen.findByRole('listbox', { name: 'taskDetail.subtasks.changeStatus' });
    fireEvent.change(screen.getByRole('combobox', { name: 'common.search · taskDetail.subtasks.changeStatus' }), { target: { value: 'complete' } });
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    fireEvent.click(within(list).getByRole('option', { name: 'Complete' }));
    expect(detail.updateTaskInDb).toHaveBeenCalledExactlyOnceWith(child.id, { statusId: 'state-5' });
    expect(screen.getByLabelText('Current task states')).toHaveTextContent('task-parent:state-0,task-child:state-5,task-unrelated:state-0');
    expect(dot).toHaveStyle({ backgroundColor: '#00875A' });
    expect(detail.setSelectedTask).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });
  it('preserves the existing dot and five-option menu without opening the subtask detail', () => {
    const detail = { ...baseDetail(), statuses: statuses.slice(0, 5), allTasks: [parent, child], setAllTasks: vi.fn(), subtaskStatusPickerId: child.id };
    render(<TaskSubtasksTab detail={detail as unknown as TaskDetailState} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Code review' }));
    expect(detail.updateTaskInDb).toHaveBeenCalledExactlyOnceWith(child.id, { statusId: 'state-2' });
    expect(detail.setSelectedTask).not.toHaveBeenCalled();
  });
});
