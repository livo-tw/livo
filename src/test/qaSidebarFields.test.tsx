import type { QaState } from '@/lib/qa/domain';
import type { QaManualStateVisibility } from '@/lib/qa/manualStateVisibility';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Project, ProductLine, User, Task } from '@/types';
import type { QaClient } from '@/lib/qa/client';
import { createQaIssue, type QaCommand, type QaIssue, type QaTarget } from '@/lib/qa/domain';
import QaIssueDetail from '@/components/qa/QaIssueDetail';
import { qaEventText, qaEventTitle } from '@/components/qa/qaEventText';
import type { TFunction } from 'i18next';
import QaIssueSidebarFields from '@/components/qa/QaIssueSidebarFields';

const state = vi.hoisted(() => ({ projects: [] as Project[], users: [] as User[] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: state.users }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: state.projects, productLines: [{ id: 'line', name: 'Example line' }] as ProductLine[] }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: [] as Task[] }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ setSelectedTask: vi.fn() }) }));
vi.mock('@/context/DeploymentEnvironmentContext', () => ({ useDeploymentEnvironments: () => ({ ready: true, values: ['Staging', 'Production'] }) }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: {} }));
vi.mock('@/components/knowledge/RelatedKnowledge', () => ({ default: (): null => null }));

const issue: QaIssue = { ...createQaIssue({ projectId: 'p1', title: 'Example bug', actual: 'A valid entry does not save', observedEnvironment: 'Staging', observedVersion: 'found-v1' }, 'example-bug', {
  actor: { id: 'reporter', role: 'member' }, workspaceId: 'default', now: '2026-10-06T00:00:00Z', newId: () => 'example-id', memberIds: new Set(['reporter']), projectIds: new Set(['p1']), taskIds: new Set(), environmentValues: ['Staging'],
}), state: 'in_progress', version: 4, assigneeId: 'dev', qaOwnerId: 'qa', dueDate: '2026-10-20' };
const target: QaTarget = { id: 'target1', environment: 'Production', component: 'API', build: 'fix-v2', required: true, deployedAt: null, deployedBy: null, deploymentEvidence: '' };
beforeEach(() => {
  state.projects = [{ id: 'p1', lineId: 'line', name: 'First project', isArchived: false }, { id: 'p2', lineId: 'line', name: 'Second project', isArchived: false }] as Project[];
  state.users = ['dev', 'qa', 'other'].map(id => ({ id, name: id, role: 'member', isActive: true, jobTitle: id === 'qa' ? 'QA' : 'Engineer', avatar: id[0], color: '#123456', email: `${id}@example.com`, sortOrder: 0 }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function renderDetail(initial: QaIssue, actorId = 'dev', initialAction?: QaCommand['type'], reject?: unknown) {
  const command = vi.fn(async (current: QaIssue, next: QaCommand) => {
    if (reject) throw reject;
    const { type, ...patch } = next;
    return { ...current, ...(type === 'update_fields' ? patch : {}), version: current.version + 1 } as QaIssue;
  });
  const client = { command, versions: vi.fn().mockResolvedValue([]), getManualStateVisibility: async (): Promise<QaManualStateVisibility> => ({ version: 1, hiddenStates: [] as QaState[] }), getFieldConfiguration: vi.fn().mockResolvedValue({ version: 1, fields: [] }) } as unknown as QaClient;
  render(<QaIssueDetail detail={{ issue: initial, comments: [], events: [], attachments: [] }} client={client} actor={{ id: actorId, role: 'member' }} initialAction={initialAction} onRefresh={vi.fn().mockResolvedValue(undefined)} onBack={vi.fn()} />);
  return command;
}

describe('optional QA target labels', () => {
  it.each([
    ['', '', 'Staging'],
    ['API', '', 'Staging / API'],
    ['', 'fix-v3', 'Staging / fix-v3'],
    ['API', 'fix-v3', 'Staging / API / fix-v3'],
  ])('keeps actual component=%s build=%s without empty separators in the target and PASS history', (component, build, label) => {
    const deployed = { ...target, environment: 'Staging', component, build, deployedAt: issue.createdAt, deployedBy: 'dev' };
    renderDetail({ ...issue, state: 'verified', fixCycle: 1, assigneeId: 'dev', qaOwnerId: 'qa', targets: [deployed], runs: [{ id: 'example-run', sequence: 1, fixCycle: 1, targetId: target.id, environment: deployed.environment, component, build, result: 'pass', note: '', testerId: 'qa', createdAt: issue.createdAt }] });
    fireEvent.click(screen.getByRole('tab', { name: /qa.verificationTab/ }));
    expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
    expect(screen.getByText(`qa.result.pass · ${label}`)).toBeInTheDocument();
    expect(screen.queryByText(/Staging \/ \/|Staging \/$/)).not.toBeInTheDocument();
  });
});

describe('direct QA sidebar editing', () => {
  it('sends a complete snapshot and uses the saved revision for the next field edit', async () => {
    const command = renderDetail(issue);
    fireEvent.change(screen.getByLabelText('qa.priority'), { target: { value: '1' } });
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][0].version).toBe(4);
    expect(command.mock.calls[0][1]).toEqual({ type: 'update_fields', projectId: 'p1', assigneeId: 'dev', qaOwnerId: 'qa', severity: issue.severity, priority: 1, dueDate: '2026-10-20' });
    await waitFor(() => expect(screen.getByLabelText('qa.priority')).toHaveValue('1'));
    fireEvent.change(screen.getByLabelText('qa.dueDate'), { target: { value: '' } });
    expect(command).toHaveBeenCalledTimes(1);
    fireEvent.blur(screen.getByLabelText('qa.dueDate'));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls[1][0].version).toBe(5);
    expect(command.mock.calls[1][1]).toMatchObject({ type: 'update_fields', priority: 1, dueDate: null });
  });

  it('lets a scoped team member edit completed metadata without granting status or evidence actions', () => {
    renderDetail({ ...issue, state: 'closed', closedAt: '2026-10-06T00:00:00Z' }, 'other');
    expect(screen.getByLabelText('qa.project')).toBeEnabled();
    expect(screen.getByLabelText('qa.priority')).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'qa.assignee' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'qa.changeState' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'qa.verification' })).toBeNull();
  });

  it('clears assignee or QA owner directly without an acceptance workflow', async () => {
    const command = vi.fn(async () => true);
    render(<QaIssueSidebarFields issue={issue} disabled={false} onCommand={command} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'qa.assignee' }));
    fireEvent.click(await screen.findByRole('option', { name: 'qa.unassigned' }));
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'update_fields', assigneeId: null, qaOwnerId: 'qa' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'qa.qaOwner' }));
    fireEvent.click(await screen.findByRole('option', { name: 'qa.unassigned' }));
    expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'update_fields', assigneeId: 'dev', qaOwnerId: null }));
    expect(screen.queryByText(/acknowledge|acceptAssignment|acceptReview/i)).toBeNull();
  });

  it('uses shared project search, keeps the current archived project, and excludes other archived projects', async () => {
    state.projects = [
      ...Array.from({ length: 6 }, (_, index) => ({ id: `p${index + 1}`, name: `Project ${index + 1}`, lineId: 'line', isArchived: index === 0 } as Project)),
      { id: 'retired', name: 'Other retired project', lineId: 'line', isArchived: true } as Project,
    ];
    const command = vi.fn(async () => true);
    render(<QaIssueSidebarFields issue={issue} disabled={false} onCommand={command} />);
    const project = screen.getByRole('combobox', { name: 'qa.project' });
    expect(project.tagName).toBe('BUTTON');
    fireEvent.click(project);
    expect(await screen.findByRole('option', { name: 'Project 1' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Other retired project' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Project 6' }));
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'update_fields', projectId: 'p6' }));
  });

  it('disables all metadata fields while a command is pending', () => {
    render(<QaIssueSidebarFields issue={issue} disabled onCommand={vi.fn(async () => true)} />);
    for (const label of ['qa.project', 'qa.priority', 'qa.severity', 'qa.dueDate']) expect(screen.getByLabelText(label)).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'qa.assignee' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'qa.qaOwner' })).toBeDisabled();
  });

  it('keeps the current metadata and displays a conflict instead of pretending a save succeeded', async () => {
    const command = renderDetail(issue, 'dev', undefined, { status: 409, code: 'qa_conflict' });
    fireEvent.change(screen.getByLabelText('qa.priority'), { target: { value: '1' } });
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByLabelText('qa.priority')).toHaveValue(String(issue.priority));
    fireEvent.change(screen.getByLabelText('qa.dueDate'), { target: { value: '2026-10-21' } });
    fireEvent.blur(screen.getByLabelText('qa.dueDate'));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText('qa.dueDate')).toHaveValue('2026-10-20'));
  });
});

describe('shorter QA processing forms', () => {
  it('submits a repair with the observed environment and no invented fix version or summary', async () => {
    const command = renderDetail(issue, 'dev', 'submit_fix');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('qa.fixSummary')).not.toBeRequired();
    expect(within(dialog).getByLabelText(/qa.build/)).toHaveValue('');
    expect(within(dialog).getByLabelText(/qa.build/)).not.toBeRequired();
    expect(within(dialog).getByLabelText(/qa.environment/)).toHaveValue('Staging');
    expect(within(dialog).getByLabelText(/qa.environment/)).toBeRequired();
    fireEvent.click(within(dialog).getByRole('button', { name: 'qa.save' }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][1]).toEqual({ type: 'submit_fix', summary: '', targets: [{ environment: 'Staging', component: '', build: '', required: true }] });
  });

  it('prefills the actual prior repair targets rather than claiming the discovered version is fixed', () => {
    renderDetail({ ...issue, targets: [target] }, 'dev', 'submit_fix');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText(/qa.environment/)).toHaveValue('Production');
    expect(within(dialog).getByLabelText(/qa.build/)).toHaveValue('fix-v2');
    expect(within(dialog).getByLabelText(/qa.fixComponent/)).toHaveValue('API');
  });

  it('keeps the formal handoff in More actions and opens its existing panel without creating a record', async () => {
    const command = renderDetail(issue);
    expect(screen.queryByText('qaHandoff.empty')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'qa.moreActions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'qaHandoff.title' }));
    expect(within(await screen.findByRole('dialog')).getByText('qaHandoff.empty')).toBeTruthy();
    expect(command).not.toHaveBeenCalled();
  });
});


describe('metadata audit snapshots', () => {
  it('shows only changed fields with resolved people and projects while retaining the original snapshot', () => {
    const detail = JSON.stringify({ before: { projectId: 'p1', assigneeId: 'dev', qaOwnerId: 'qa', severity: 'low', priority: 3, dueDate: null }, after: { projectId: 'p2', assigneeId: null, qaOwnerId: 'qa', severity: 'low', priority: 1, dueDate: null } });
    const event = { type: 'update_fields', detail };
    const t = ((key: string, values?: Record<string, string>) => values ? `${values.field}: ${values.before} -> ${values.after}` : key) as TFunction;
    const text = qaEventText(event, { t, member: id => id === 'dev' ? 'Alex' : 'Blair', project: id => id === 'p1' ? 'First project' : 'Second project', task: id => id, date: value => value, stateLabel: value => value });
    expect(qaEventTitle(event, t)).toBe('qa.historyEvent.update_fields');
    expect(text).toContain('qa.project: First project -> Second project');
    expect(text).toContain('qa.assignee: Alex -> qa.unassigned');
    expect(text).toContain('qa.priority: priority.medium -> priority.highest');
    expect(text).not.toContain('qa.qaOwner');
    expect(event.detail).toBe(detail);
  });
});
