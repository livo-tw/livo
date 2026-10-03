import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Project, ProductLine, User } from '@/types';
import { createProjectColorResolver, LEGACY_PROJECT_COLOR, suggestProjectColor } from '@/lib/projectColors';

const state = vi.hoisted(() => ({
  projects: [] as Project[], lines: [{ id: 'line', name: 'Line', color: '#0065FF', icon: '', sortOrder: 0 }] as ProductLine[],
  editing: null as Project | null, update: vi.fn(async () => {}), create: vi.fn(async () => null),
  setShow: vi.fn(), setEditing: vi.fn(), acquire: vi.fn(), release: vi.fn(), track: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: state.projects, productLines: state.lines, createProjectInDb: state.create, updateProjectInDb: state.update }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as User[] }) }));
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: null as string | null }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ showCreateProject: true, setShowCreateProject: state.setShow, editingProject: state.editing, setEditingProject: state.setEditing }) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => ({ hasFeature: () => false }) }));
vi.mock('@/hooks/usePresenceLock', () => ({ usePresenceLock: () => ({ viewers: [] as never[], trackEditing: state.track, isLockedBy: (): string | null => null, acquireLock: state.acquire, releaseLock: state.release }) }));
vi.mock('@/hooks/useFocusTrap', () => ({ useFocusTrap: () => ({ current: null as HTMLElement | null }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/activityLog', () => ({ logActivity: vi.fn() }));

import QaIssueCard from '@/components/qa/QaIssueCard';
import CreateProjectModal from '@/components/CreateProjectModal';
import { ProjectCheckboxList } from '@/components/project/ProjectOptions';
import { ProjectBadge } from '@/components/ui/badges';
import { useProjectColor } from '@/hooks/useProjectColor';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { createQaIssue } from '@/lib/qa/domain';

const projects: Project[] = [
  { id: 'p-a', name: 'Project A', lineId: 'line', key: 'PA', color: LEGACY_PROJECT_COLOR, isArchived: false },
  { id: 'p-b', name: 'Project B', lineId: 'line', key: 'PB', color: LEGACY_PROJECT_COLOR, isArchived: false },
];
function BadgeSurface({ project }: { project: Project }) {
  const color = useProjectColor();
  return <ProjectBadge name={project.name} color={color(project)} />;
}
afterEach(() => { cleanup(); vi.clearAllMocks(); state.editing = null; });

describe('shared project colour surfaces', () => {
  it('shows the same workspace-resolved colour in QA, a shared badge and a filtered project picker', () => {
    state.projects = projects;
    const issue = createQaIssue({ projectId: 'p-b', title: 'A bug', actual: 'Observed', observedEnvironment: 'Stage' }, 'bug', {
      actor: { id: 'reporter', role: 'member' }, workspaceId: 'default', now: '2026-10-03T00:00:00Z',
      newId: () => 'x', memberIds: new Set(['reporter']), projectIds: new Set(projects.map(p => p.id)), taskIds: new Set(),
    });
    render(<><div data-testid="qa"><QaIssueCard issue={issue} actor={{ id: 'reader', role: 'member' }} onOpen={vi.fn()} /></div>
      <div data-testid="badge"><BadgeSurface project={projects[1]} /></div>
      <div data-testid="picker"><ProjectCheckboxList groups={groupProjectsByLine(state.lines, [projects[1]])} selected={[]} onToggle={vi.fn()} /></div></>);
    const expected = createProjectColorResolver(projects)('p-b');
    expect(within(screen.getByTestId('qa')).getByText('Project B')).toHaveStyle({ color: expected });
    expect(within(screen.getByTestId('badge')).getByText('Project B')).toHaveStyle({ color: expected });
    expect(screen.getByTestId('picker').querySelector('span')).toHaveStyle({ backgroundColor: expected });
    expect(state.projects.map(project => project.color)).toEqual([LEGACY_PROJECT_COLOR, LEGACY_PROJECT_COLOR]);
  });

  it('editing a name does not persist the display fallback as a project colour', async () => {
    state.projects = projects; state.editing = projects[1];
    render(<CreateProjectModal />);
    fireEvent.change(screen.getByDisplayValue('Project B'), { target: { value: 'Project B renamed' } });
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(state.update).toHaveBeenCalledWith('p-b', { name: 'Project B renamed' }));
  });

  it('new project colour defaults use the complete catalog and keep the choice visible', () => {
    state.projects = projects;
    render(<CreateProjectModal />);
    const suggested = suggestProjectColor(projects);
    expect(screen.getByRole('button', { name: `project.colorLabel: ${suggested}` })).toHaveAttribute('aria-pressed', 'true');
  });
});
