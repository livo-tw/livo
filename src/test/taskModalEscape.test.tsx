import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CustomField, ProductLine, Project, Status, Task, User } from '@/types';

const state = vi.hoisted(() => ({
  showCreateTask: true, setShowCreateTask: vi.fn(), setSelectedTask: vi.fn(),
  selectedTask: { id: 'example-task', title: 'Example task' } as Task,
  projects: [{ id: 'example-project', name: 'Example project', key: 'EX', lineId: 'example-line', color: '#0065FF', isArchived: false }] as Project[],
  lines: [{ id: 'example-line', name: 'Example line', color: '#0065FF', icon: '', sortOrder: 0 }] as ProductLine[],
  statuses: [{ id: 'example-status', name: 'Open', color: '#0065FF', sortOrder: 0, isDone: false, autoStart: false, autoDone: false }] as Status[],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => true }));
vi.mock('@/hooks/use-media-query', () => ({ useMediaQuery: () => true }));
vi.mock('@/lib/demoMode', () => ({ IS_DEMO_PRO: false, exitDemoMode: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/context/DeploymentEnvironmentContext', () => ({ useDeploymentEnvironments: () => ({ ready: true, values: [] as string[] }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'example-member', currentMember: { id: 'example-member', name: 'Example member', role: 'member' } as User }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as User[] }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ showCreateTask: state.showCreateTask, setShowCreateTask: state.setShowCreateTask,
  requiredFields: { title: true, project: true }, currentView: 'board', selectedTask: state.selectedTask,
  setSelectedTask: state.setSelectedTask, taskDisplayMode: 'modal' }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ selectedProjectId: null as string | null,
  selectedLineId: null as string | null, allProjects: state.projects, productLines: state.lines }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [] as Task[], setAllTasks: vi.fn(), statuses: state.statuses,
  tags: [] as never[], refreshTags: vi.fn(), createTaskInDb: vi.fn(), createSubtask: vi.fn(), refreshTaskSpecs: vi.fn(), refreshTaskChecks: vi.fn(),
  refreshTaskTodos: vi.fn(), refreshStatusLogs: vi.fn(), taskTemplates: [] as never[], customFields: [] as CustomField[], upsertCustomFieldValue: vi.fn() }) }));
vi.mock('@/context/SprintContext', () => ({ useSprintContext: () => ({ currentSprint: null as null }) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ hasFeature: () => false }) }));
vi.mock('@/lib/slackNotify', () => ({ sendSlackNotify: vi.fn() }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/components/RichTextEditorLazy', () => ({ default: (): null => null }));
vi.mock('@/components/create-task/TaskFormCustomFields', () => ({ default: (): null => null }));
vi.mock('@/components/create-task/TaskFormFields', () => ({ default: CalendarField }));
vi.mock('@/components/TaskDetailContent', () => ({ default: CalendarField }));

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import CreateTaskModal from '@/components/CreateTaskModal';
import TaskDetailModal from '@/components/TaskDetailModal';

function CalendarField() {
  return <>
    <input aria-label="Example handled field" onKeyDown={event => { if (event.key === 'Escape') event.preventDefault(); }} />
    <Popover>
      <PopoverTrigger asChild><button type="button">Example due date</button></PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        <Calendar mode="single" defaultMonth={new Date(2026, 9, 1)} initialFocus />
      </PopoverContent>
    </Popover>
  </>;
}

async function dismissCalendar() {
  fireEvent.click(screen.getByRole('button', { name: 'Example due date' }));
  const day = (await screen.findAllByRole('gridcell')).find(cell => cell.textContent?.trim() === '8')!;
  expect(day).toBeDefined();
  fireEvent.keyDown(day, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument());
}

beforeEach(() => { vi.clearAllMocks(); state.showCreateTask = true; });
afterEach(cleanup);

describe('task modal Escape boundaries', () => {
  it('closes only a portaled calendar while retaining a dirty new-task draft', async () => {
    render(<CreateTaskModal />);
    const title = screen.getByPlaceholderText('taskCreate.titlePlaceholder');
    fireEvent.change(title, { target: { value: 'Example unsaved task' } });
    await dismissCalendar();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(title).toHaveValue('Example unsaved task');
    expect(state.setShowCreateTask).not.toHaveBeenCalled();

    fireEvent.keyDown(title, { key: 'Escape' });
    expect(await screen.findByRole('alertdialog')).toHaveAccessibleName('taskCreate.discardTitle');
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(title).toHaveValue('Example unsaved task');
    expect(state.setShowCreateTask).not.toHaveBeenCalled();
  });

  it('still closes a clean create dialog on direct Escape', () => {
    render(<CreateTaskModal />);
    fireEvent.keyDown(screen.getByPlaceholderText('taskCreate.titlePlaceholder'), { key: 'Escape' });
    expect(state.setShowCreateTask).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('leaves a task detail open after calendar Escape and closes it on direct Escape', async () => {
    render(<TaskDetailModal />);
    await dismissCalendar();
    expect(screen.getByRole('dialog', { name: 'Example task' })).toBeInTheDocument();
    expect(state.setSelectedTask).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Example due date' }), { key: 'Escape' });
    expect(state.setSelectedTask).toHaveBeenCalledExactlyOnceWith(null);
  });

  it.each(['create', 'detail'] as const)('does not close the %s dialog when a child already handled Escape', kind => {
    render(kind === 'create' ? <CreateTaskModal /> : <TaskDetailModal />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Example handled field' }), { key: 'Escape' });
    expect(state.setShowCreateTask).not.toHaveBeenCalled();
    expect(state.setSelectedTask).not.toHaveBeenCalled();
  });
});
