import { createRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CustomField, ProductLine, Project, Status, Tag, Task, User } from '@/types';
import type { RequiredFieldsConfig } from '@/context/UIContext';
import type { TaskDetailState } from '@/components/task-detail/hooks/useTaskDetail';

vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }),
}));
// Announcements have their own tests (taskFlows.test.tsx).
vi.mock('@/hooks/useTaskAnnouncements', () => ({ useTaskAnnouncements: () => ({ actor: null as null, users: [] as never[], projects: [] as never[], statuses: [] as never[] }) }));
vi.mock('@/lib/taskAnnouncements', () => ({ announceStatusChange: vi.fn(), announceAssignment: vi.fn() }));
const createState = vi.hoisted(() => ({ required: {} as Partial<RequiredFieldsConfig>, open: vi.fn() }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ approvalsEnabled: false, requiredFields:createState.required,openCreateSubtask:createState.open }) }));
// Sub-task changes use the shared status rules; none are configured here.
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => ({ select: async () => ({ data: [] as never[], error: null as null }) }) } }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ statusLogs: [] as never[], statuses: [] as never[] }) }));
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
  createState.required = {}; createState.open.mockReset();
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
    // Completing a sub-task records when, as on the board and in the detail view.
    expect(detail.updateTaskInDb).toHaveBeenCalledExactlyOnceWith(child.id, { statusId: 'state-5', completedAt: expect.any(String) });
    expect(screen.getByLabelText('Current task states')).toHaveTextContent('task-parent:state-0,task-child:state-5,task-unrelated:state-0');
    expect(dot).toHaveStyle({ backgroundColor: '#00875A' });
    expect(detail.setSelectedTask).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });
  it('preserves the existing dot and five-option menu without opening the subtask detail', async () => {
    const detail = { ...baseDetail(), statuses: statuses.slice(0, 5), allTasks: [parent, child], setAllTasks: vi.fn(), subtaskStatusPickerId: child.id };
    render(<TaskSubtasksTab detail={detail as unknown as TaskDetailState} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Code review' }));
    await waitFor(() => expect(detail.updateTaskInDb).toHaveBeenCalledExactlyOnceWith(child.id, { statusId: 'state-2' }));
    expect(detail.setSelectedTask).not.toHaveBeenCalled();
  });
});

describe('subtask quick entry escalates to the shared complete form only when needed', () => {
  it.each(['background','requirement','startDate','tags','notes','checks','todos','gitlabUrl','deployments'] as const)('collects required %s before creating a child', key => {
    createState.required = {[key]:true}; const detail = {...baseDetail(),allTasks:[parent],setAllTasks:vi.fn(),newSubtaskTitle:'Child draft'};
    render(<TaskSubtasksTab detail={detail as unknown as TaskDetailState} />);
    fireEvent.click(screen.getByRole('button',{name:'taskCreate.subtaskTitle'}));
    expect(createState.open).toHaveBeenCalledExactlyOnceWith(parent.id,'Child draft'); expect(detail.handleCreateSubtask).not.toHaveBeenCalled();
  });
  it('collects a required custom field through the same form', () => {
    const custom: CustomField = {id:'field-example',projectId:parent.projectId,fieldName:'Example answer',fieldType:'text',isRequired:true,sortOrder:0,createdAt:''};
    const detail = {...baseDetail(),allTasks:[parent],setAllTasks:vi.fn(),newSubtaskTitle:'Child custom draft',customFields:[custom]};
    render(<TaskSubtasksTab detail={detail as unknown as TaskDetailState} />);
    fireEvent.keyDown(screen.getByPlaceholderText('taskDetail.subtasks.newPlaceholder'),{key:'Enter'});
    expect(createState.open).toHaveBeenCalledExactlyOnceWith(parent.id,'Child custom draft'); expect(detail.handleCreateSubtask).not.toHaveBeenCalled();
  });
  it('keeps title-only creation working when all required values can be collected by the quick entry', () => {
    const detail = {...baseDetail(),allTasks:[parent],setAllTasks:vi.fn(),newSubtaskTitle:'Simple child'};
    render(<TaskSubtasksTab detail={detail as unknown as TaskDetailState} />);
    fireEvent.click(screen.getByRole('button',{name:'taskCreate.subtaskTitle'}));
    expect(detail.handleCreateSubtask).toHaveBeenCalledOnce(); expect(createState.open).not.toHaveBeenCalled();
  });
  it('opens the full form when the parent cannot supply a required due date and prevents nested entry', () => {
    createState.required={dueDate:true}; const detail={...baseDetail(),allTasks:[parent],setAllTasks:vi.fn(),newSubtaskTitle:'Dated child'};
    const {rerender}=render(<TaskSubtasksTab detail={detail as unknown as TaskDetailState} />);
    fireEvent.click(screen.getByRole('button',{name:'taskCreate.subtaskTitle'})); expect(createState.open).toHaveBeenCalledWith(parent.id,'Dated child');
    rerender(<TaskSubtasksTab detail={{...detail,task:child} as unknown as TaskDetailState} />);
    expect(screen.queryByRole('button',{name:'taskCreate.subtaskTitle'})).toBeNull();
  });
});
