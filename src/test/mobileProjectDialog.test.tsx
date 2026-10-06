import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ProductLine, Project, Task, User } from '@/types';

type UiState = {
  showCreateProject: boolean;
  setShowCreateProject: (show: boolean) => void;
  editingProject: Project | null;
  setEditingProject: (project: Project | null) => void;
  currentView: string;
  setCurrentView: (view: string) => void;
  setSelectedTask: (task: Task | null) => void;
  setStandupMode: (enabled: boolean) => void;
  approvalsEnabled: boolean;
  featureTogglesReady: boolean;
  featureToggles: { qa: boolean; releases: boolean };
};
const state = vi.hoisted(() => ({
  ui: {} as UiState,
  navigated: vi.fn(), create: vi.fn(async (): Promise<string | null> => null), update: vi.fn(async (): Promise<void> => {}),
  deleted: vi.fn(async (): Promise<void> => {}), acquire: vi.fn(), release: vi.fn(), track: vi.fn(),
  projects: [{ id: 'example-project', lineId: 'example-line', name: 'Example project', key: 'EX', color: '#0065FF', isArchived: false }] as Project[],
  lines: [{ id: 'example-line', name: 'Example product line', icon: '', color: '#0065FF', sortOrder: 0 }] as ProductLine[],
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => true }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => state.ui }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'example-member', currentMember: { role: 'admin' } as User,
  permissions: { canEditProject: true, canDeleteProject: true, canViewMemberList: false, canManageMembers: false } }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: state.projects, productLines: state.lines,
  selectedProjectId: null as string | null, selectedLineId: null as string | null, setSelectedProjectId: vi.fn(), setSelectedLineId: vi.fn(),
  createProjectInDb: state.create, updateProjectInDb: state.update, deleteProjectInDb: state.deleted }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [] as Task[] }) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ hasFeature: () => true }) }));
vi.mock('@/hooks/useProjectScope', () => ({ scopeChangeBlocked: () => false, sidebarEntry: () => 'scope', viewAfterScopeChange: () => 'board' }));
vi.mock('@/hooks/usePresenceLock', () => ({ usePresenceLock: () => ({ viewers: [] as never[], trackEditing: state.track,
  isLockedBy: (): string | null => null, acquireLock: state.acquire, releaseLock: state.release }) }));
vi.mock('@/components/StandupLaunchDialog', () => ({ default: (): null => null }));
vi.mock('@/components/UpgradePrompt', () => ({ default: (): null => null }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));

import AppSidebar from '@/components/AppSidebar';
import CreateProjectModal from '@/components/CreateProjectModal';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

function ProjectNavigation() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  state.ui = { showCreateProject, setShowCreateProject, editingProject, setEditingProject, currentView: 'board',
    setCurrentView: vi.fn(), setSelectedTask: vi.fn(), setStandupMode: vi.fn(), approvalsEnabled: false,
    featureTogglesReady: true, featureToggles: { qa: false, releases: false } };
  return <>
    <button id="livo-navigation-toggle" onClick={() => setSidebarOpen(true)}>Example navigation</button>
    <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <SheetContent side="left" aria-describedby={undefined}>
        <SheetTitle>Example sidebar</SheetTitle>
        <AppSidebar onNavigate={() => { state.navigated(); setSidebarOpen(false); }} />
      </SheetContent>
    </Sheet>
    <CreateProjectModal />
  </>;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.style.pointerEvents = '';
});
afterEach(() => { cleanup(); document.body.style.pointerEvents = ''; });

describe('mobile project dialogs', () => {
  it('closes the mobile Sheet before editing, so the project name receives usable focus', async () => {
    render(<ProjectNavigation />);
    fireEvent.contextMenu(await screen.findByRole('button', { name: /Example project/ }), { clientX: 40, clientY: 120 });
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    const editor = await screen.findByRole('dialog', { name: 'project.editTitle' });
    expect(state.navigated).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Example sidebar' })).not.toBeInTheDocument());
    const name = within(editor).getByRole('textbox', { name: 'project.nameLabel' });
    await waitFor(() => expect(name).toHaveFocus());
    expect(getComputedStyle(name).pointerEvents).not.toBe('none');
    fireEvent.change(name, { target: { value: 'Example project edited locally' } });
    expect(name).toHaveValue('Example project edited locally');
    fireEvent.click(within(editor).getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'project.editTitle' })).not.toBeInTheDocument());
    expect(state.update).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it('retains the sidebar after cancelling its nested delete confirmation', async () => {
    render(<ProjectNavigation />);
    fireEvent.contextMenu(await screen.findByRole('button', { name: /Example project/ }), { clientX: 40, clientY: 120 });
    fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
    const confirmation = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirmation).getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Example sidebar' })).toBeInTheDocument();
    expect(state.navigated).not.toHaveBeenCalled();
    expect(state.deleted).not.toHaveBeenCalled();
  });
});
