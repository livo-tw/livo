import type { QaDisplaySettings } from '@/lib/qa/displaySettings';
import type { QaState } from '@/lib/qa/domain';
import type { QaManualStateVisibility } from '@/lib/qa/manualStateVisibility';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { User, ProductLine, Task } from '@/types';
const state = vi.hoisted(() => ({ users: [] as User[], tasks: [] as Task[] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => key === 'qa.waitingForAction' ? `${key}: ${values?.name}: ${values?.action}` : key }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: state.users }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [{ id: 'p1', name: 'Example project', color: '#123456' }], productLines: [] as ProductLine[] }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: state.tasks }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ taskDisplayMode: 'modal', setTaskDisplayMode: vi.fn(), setSelectedTask: vi.fn() }) }));
vi.mock('@/context/DeploymentEnvironmentContext', () => ({ useDeploymentEnvironments: () => ({ ready: true, values: ['Stage'] }) }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: {} }));
import UserSelect from '@/components/UserSelect';
import QaIssueDetail from '@/components/qa/QaIssueDetail';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { createQaIssue } from '@/lib/qa/domain';
import type { QaActor, QaDetail } from '@/lib/qa/domain';
import type { QaClient } from '@/lib/qa/client';
import { qaStateColors } from '@/components/qa/QaBadges';

const person = (id: string, name: string, isActive = true, jobTitle = 'Engineer'): User => ({ id, name, isActive, jobTitle, role: 'member', avatar: name[0], color: '#123456', email: `${id}@example.com`, sortOrder: 1 });
const issue = createQaIssue({ projectId: 'p1', title: 'Checkout error', actual: 'Cannot save a valid entry', expected: 'A valid entry is saved', observedEnvironment: 'Stage', qaOwnerId: null }, 'bug1', { actor: { id: 'reporter', role: 'member' }, workspaceId: 'default', now: '2026-10-03T00:00:00Z', newId: () => 'example-id', memberIds: new Set(['reporter']), projectIds: new Set(['p1']), taskIds: new Set() });
const detail: QaDetail = { issue, comments: [], events: [], attachments: [] };
beforeEach(() => {
  state.users = [person('dev', 'Alex', true, 'Engineer'), person('qa', 'Blair', true, 'QA'), person('inactive', 'Casey', false)];
  state.tasks = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function choose(label: string, name: RegExp) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name }));
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  expect(screen.getByRole('combobox', { name: label })).toHaveTextContent(name);
}
function renderDetail(overrides: Partial<QaDetail> = {}, actor: QaActor = { id: 'admin', role: 'admin' }) {
  const command = vi.fn().mockResolvedValue(issue), upload = vi.fn().mockResolvedValue({ id: 'file1' });
  const client = { getDisplaySettings: async (): Promise<QaDisplaySettings> => ({ version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] }), getManualStateVisibility: async (): Promise<QaManualStateVisibility> => ({ version: 1, hiddenStates: [] as QaState[] }), getFieldConfiguration: vi.fn().mockResolvedValue({ version: 1, fields: [] }), command, upload, versions: vi.fn().mockResolvedValue([]) } as unknown as QaClient;
  const props = { detail: { ...detail, ...overrides }, client, actor, onRefresh: vi.fn().mockResolvedValue(undefined), onBack: vi.fn() };
  return { ...render(<QaIssueDetail {...props} />), command, upload, props };
}

describe('QA direct state selection', () => {
  it('moves historical PASS directly to FAIL with coloured choices and without creating verification or deployment evidence', async () => {
    const historical: QaDetail['issue'] = { ...issue, state: 'verified', targets: [], runs: [] };
    const { command, props, rerender } = renderDetail({ issue: historical }, { id: 'reporter', role: 'member' });
    const failed = { ...historical, state: 'failed' as const, version: historical.version + 1 };
    command.mockResolvedValue(failed);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'qa.changeState' })).not.toBeDisabled());
    const picker = screen.getByRole('combobox', { name: 'qa.changeState' });
    expect(picker).not.toBeDisabled();
    fireEvent.click(picker);
    const option = await screen.findByRole('option', { name: 'qa.state.failed' });
    expect(option.querySelector('[data-status-dot]')).toHaveStyle({ backgroundColor: qaStateColors.failed });
    fireEvent.click(option);
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][1]).toEqual({ type: 'set_state', state: 'failed' });
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByLabelText(/qa.targetBuild/)).toBeNull();
    expect(historical.targets).toEqual([]); expect(historical.runs).toEqual([]);
    rerender(<QaIssueDetail {...props} detail={{ ...props.detail, issue: failed }} />);
    expect(screen.getByRole('combobox', { name: 'qa.changeState' })).toHaveTextContent('qa.state.failed');
    expect(screen.getByRole('combobox', { name: 'qa.changeState' }).querySelector('[data-status-dot]')).toHaveStyle({ backgroundColor: qaStateColors.failed });
  });
  it('keeps the direct state control visible but disabled for an unrelated member', () => {
    const { command } = renderDetail({ issue: { ...issue, state: 'verified' } }, { id: 'visitor', role: 'member' });
    expect(screen.getByRole('combobox', { name: 'qa.changeState' })).toBeDisabled();
    expect(command).not.toHaveBeenCalled();
  });
  it('preserves an acknowledged state through a failed refresh and retries only the reload', async () => {
    const historical: QaDetail['issue'] = { ...issue, state: 'verified', targets: [], runs: [] };
    const { command, props } = renderDetail({ issue: historical });
    const failed = { ...historical, state: 'failed' as const, version: historical.version + 1 };
    command.mockResolvedValue(failed);
    props.onRefresh.mockRejectedValueOnce(new TypeError('reload unavailable')).mockResolvedValue(undefined);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'qa.changeState' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('combobox', { name: 'qa.changeState' }));
    fireEvent.click(await screen.findByRole('option', { name: 'qa.state.failed' }));
    await screen.findByText('qaHandoff.savedRefreshFailed');
    expect(screen.getByRole('combobox', { name: 'qa.changeState' })).toHaveTextContent('qa.state.failed');
    expect(screen.queryByRole('button', { name: 'qa.retryCommand' })).toBeNull();
    expect(screen.getByRole('button', { name: 'qa.back' })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'qa.refresh' }));
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalledTimes(2));
    expect(command).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('combobox', { name: 'qa.changeState' })).toHaveTextContent('qa.state.failed');
  });
});

describe('shared UserSelect form and dialog behavior', () => {
  it('does not leave an old search portal or steal focus during a rapid switch between owners', async () => {
    const view = render(<form><UserSelect label="Developer" name="developer" /><UserSelect label="Tester" name="tester" /></form>);
    fireEvent.click(screen.getByRole('combobox', { name: 'Developer' }));
    fireEvent.click(await screen.findByRole('option', { name: /Alex/ }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Tester' }));
    const search = await screen.findByRole('combobox', { name: 'common.search · Tester' });
    expect(screen.queryByRole('combobox', { name: 'common.search · Developer' })).toBeNull();
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: 'Blair' } });
    fireEvent.click(screen.getByRole('option', { name: /Blair/ }));
    const data = new FormData(view.container.querySelector('form')!);
    expect(data.get('developer')).toBe('dev'); expect(data.get('tester')).toBe('qa');
  });
  it('searches active members in a portal and submits their IDs through the original form', async () => {
    const submit = vi.fn();
    const view = render(<form onSubmit={event => { event.preventDefault(); submit(new FormData(event.currentTarget).get('owner')); }}><UserSelect name="owner" label="Owner" required activeOnly emptyLabel="Choose" /><button>Save</button></form>);
    fireEvent.click(screen.getByText('Save'));
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Owner' })).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getByRole('combobox', { name: 'Owner' }));
    const search = await screen.findByRole('combobox', { name: 'common.search · Owner' });
    expect(view.container.contains(search)).toBe(false);
    expect(screen.queryByRole('option', { name: /Casey/ })).toBeNull();
    fireEvent.change(search, { target: { value: 'qa' } });
    expect(screen.queryByRole('option', { name: /Alex/ })).toBeNull();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(screen.getByRole('combobox', { name: 'Owner' })).toHaveTextContent('Blair');
    fireEvent.click(screen.getByText('Save'));
    expect(submit).toHaveBeenCalledWith('qa');
  });

  it('keeps existing controlled task picker behavior and optional clearing', async () => {
    const change = vi.fn();
    function TaskPicker() {
      const [value, setValue] = useState('dev');
      return <UserSelect value={value} onChange={next => { setValue(next); change(next); }} allowEmpty emptyLabel="Unassigned" label="Assignee" />;
    }
    render(<TaskPicker />);
    await choose('Assignee', /Blair/);
    expect(change).toHaveBeenCalledWith('qa');
    fireEvent.click(screen.getByRole('combobox', { name: 'Assignee' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Unassigned' }));
    expect(change).toHaveBeenLastCalledWith('');
    expect(screen.getByRole('combobox', { name: 'Assignee' })).toHaveTextContent('Unassigned');
  });

  it.each(['inactive', 'missing'])('explains historical %s selection but requires an active replacement', async old => {
    const view = render(<form><UserSelect name="owner" label="Owner" defaultValue={old} required activeOnly /></form>);
    const trigger = screen.getByRole('combobox', { name: 'Owner' });
    expect(trigger).toHaveTextContent(old === 'inactive' ? 'Casey' : 'common.memberUnavailable');
    if (old === 'inactive') expect(trigger).toHaveTextContent('common.inactive');
    expect(new FormData(view.container.querySelector('form')!).get('owner')).toBe('');
    await choose('Owner', /Alex/);
    expect(new FormData(view.container.querySelector('form')!).get('owner')).toBe('dev');
  });

  it('supports Arrow keys and Escape inside a dialog without closing that dialog or submitting', async () => {
    const close = vi.fn(), submit = vi.fn();
    render(<Dialog open onOpenChange={close}><DialogContent aria-describedby={undefined}><DialogTitle>Task form</DialogTitle><form onSubmit={submit}><UserSelect label="Owner" name="owner" required activeOnly /><button>Save</button></form></DialogContent></Dialog>);
    const trigger = screen.getByRole('combobox', { name: 'Owner' });
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const search = await screen.findByRole('combobox', { name: 'common.search · Owner' });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.keyDown(search, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(close).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('invalidates a newly deactivated member and prevents changes while disabled', async () => {
    const change = vi.fn();
    const view = render(<form><UserSelect label="Owner" name="owner" value="dev" onChange={change} activeOnly required /></form>);
    state.users = state.users.map(user => user.id === 'dev' ? { ...user, isActive: false } : user);
    view.rerender(<form><UserSelect label="Owner" name="owner" value="dev" onChange={change} activeOnly required disabled /></form>);
    expect(screen.getByRole('combobox', { name: 'Owner' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Owner' })).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getByRole('combobox', { name: 'Owner' }));
    expect(screen.queryByRole('listbox')).toBeNull(); expect(change).not.toHaveBeenCalled();
  });
});

describe('QA detail uses shared controls with a focused next action', () => {
  it('prefers QA and project developers in the direct sidebar while allowing every active member', async () => {
    state.users = [person('pm', 'Morgan', true, 'PM'), person('other', 'Reese', true, 'FE'), person('qa', 'Blair', true, 'QA'), person('dev', 'Alex', true, 'BE'), person('reviewer', 'Taylor', true, 'SRE'), person('inactive', 'Casey', false, 'QA')];
    state.tasks = [{ id: 'same', projectId: 'p1', assigneeId: 'dev', reviewerId: 'reviewer' }, { id: 'other', projectId: 'p2', assigneeId: 'other' }] as Task[];
    const { command } = renderDetail();
    command.mockImplementation(async (current, next) => { const { type, ...patch } = next; return type === 'update_fields' ? { ...current, ...patch, version: current.version + 1 } : current; });
    expect(screen.getByRole('button', { name: 'qa.assignOwners' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'qa.triage' })).toBeNull();
    fireEvent.click(screen.getByRole('combobox', { name: 'qa.assignee' }));
    let options = within(await screen.findByRole('listbox')).getAllByRole('option');
    expect(options).toHaveLength(6); expect(options[0]).toHaveTextContent('qa.unassigned');
    ['Alex', 'Taylor', 'Morgan', 'Reese', 'Blair'].forEach((name, index) => expect(options[index + 1]).toHaveTextContent(name));
    expect(screen.queryByRole('option', { name: /Casey/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: /Morgan/ }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'qa.assignee' })).toHaveTextContent('Morgan'));
    fireEvent.click(screen.getByRole('combobox', { name: 'qa.qaOwner' }));
    options = within(await screen.findByRole('listbox')).getAllByRole('option');
    expect(options).toHaveLength(6);
    ['Blair', 'Morgan', 'Reese', 'Alex', 'Taylor'].forEach((name, index) => expect(options[index + 1]).toHaveTextContent(name));
    fireEvent.change(screen.getByRole('combobox', { name: 'common.search · qa.qaOwner' }), { target: { value: 'Morgan' } });
    fireEvent.click(await screen.findByRole('option', { name: /Morgan/ }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'qa.qaOwner' })).toHaveTextContent('Morgan'));
    expect(command.mock.calls[0][1]).toMatchObject({ type: 'update_fields', assigneeId: 'pm', qaOwnerId: null });
    expect(command.mock.calls[1][0]).toMatchObject({ version: issue.version + 1 });
    expect(command.mock.calls[1][1]).toMatchObject({ type: 'update_fields', assigneeId: 'pm', qaOwnerId: 'pm' });
    expect(command.mock.calls.every(call => ![call[1].assigneeId, call[1].qaOwnerId].includes('inactive'))).toBe(true);
  });

  it('starts an assigned repair in one click without an empty confirmation form', async () => {
    const assigned = { ...issue, state: 'triaged' as const, assigneeId: 'dev', qaOwnerId: 'qa' };
    const { command, props } = renderDetail({ issue: assigned });
    fireEvent.click(screen.getByRole('button', { name: 'qa.startFix' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(assigned, { type: 'start_fix' }, expect.any(String)));
    expect(screen.queryByRole('dialog', { name: 'qa.startFix' })).toBeNull();
    await waitFor(() => expect(props.onRefresh).toHaveBeenCalledOnce());
  });
  it('starts the repair from the card button in one click too, and only once', async () => {
    const assigned = { ...issue, state: 'triaged' as const, assigneeId: 'admin', qaOwnerId: 'qa' };
    const command = vi.fn().mockResolvedValue({ ...assigned, state: 'in_progress', version: assigned.version + 1 });
    const client = { getDisplaySettings: async (): Promise<QaDisplaySettings> => ({ version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] }), getManualStateVisibility: async (): Promise<QaManualStateVisibility> => ({ version: 1, hiddenStates: [] as QaState[] }), getFieldConfiguration: vi.fn().mockResolvedValue({ version: 1, fields: [] }), command, upload: vi.fn(), versions: vi.fn().mockResolvedValue([]) } as unknown as QaClient;
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const view = render(<QaIssueDetail detail={{ ...detail, issue: assigned }} client={client} actor={{ id: 'admin', role: 'admin' }} initialAction="start_fix" onRefresh={onRefresh} onBack={vi.fn()} />);
    await waitFor(() => expect(command).toHaveBeenCalledWith(assigned, { type: 'start_fix' }, expect.any(String)));
    expect(screen.queryByRole('dialog')).toBeNull();
    view.rerender(<QaIssueDetail detail={{ ...detail, issue: assigned }} client={client} actor={{ id: 'admin', role: 'admin' }} initialAction="start_fix" onRefresh={onRefresh} onBack={vi.fn()} />);
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(command).toHaveBeenCalledTimes(1);
  });
  it.each(['fail', 'blocked'] as const)('submits one real %s verification with an optional blank note', async result => {
    const candidate = { ...issue, state: 'verification' as const, assigneeId: 'dev', qaOwnerId: 'qa', targets: [{ id: 'example-target', environment: 'Stage', component: '', build: 'example-1', required: true, deployedAt: issue.updatedAt, deployedBy: 'dev', deploymentEvidence: 'Example evidence' }] };
    const { command } = renderDetail({ issue: candidate });
    fireEvent.click(screen.getByRole('button', { name: 'qa.verification' }));
    expect(screen.getAllByRole('button', { name: 'qa.verification' })).toHaveLength(1);
    expect(screen.getByText('qa.completeInPanel')).toBeTruthy();
    expect(screen.getByLabelText('qa.note')).not.toBeVisible();
    fireEvent.change(screen.getByLabelText('qa.resultField'), { target: { value: result } });
    expect(screen.getByLabelText(/qa.note/)).toBeVisible(); expect(screen.getByLabelText(/qa.note/)).not.toBeRequired();
    fireEvent.click(screen.getByRole('button', { name: 'qa.verification' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(candidate, { type: 'record_verification', targetId: 'example-target', build: 'example-1', result, note: '' }, expect.any(String)));
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('suggests direct owner editing and keeps optional triage in More with only active IDs', async () => {
    const { command } = renderDetail();
    expect(screen.getAllByRole('button', { name: 'qa.assignOwners' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'qa.triage' })).toBeNull(); expect(screen.queryByRole('button', { name: 'qa.close' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'qa.moreActions' }));
    expect(await screen.findByRole('menuitem', { name: 'qa.close' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'qa.triage' }));
    const dialog = await screen.findByRole('dialog', { name: 'qa.triage' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'qa.save' })); expect(command).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'qa.assignee' }));
    expect(screen.queryByRole('option', { name: /Casey/ })).toBeNull(); fireEvent.click(await screen.findByRole('option', { name: /Alex/ }));
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'qa.qaOwner' })); fireEvent.click(await screen.findByRole('option', { name: /Blair/ }));
    fireEvent.change(within(dialog).getByLabelText(/qa.severity/), { target: { value: 'high' } });
    expect(Object.fromEntries(new FormData(dialog.querySelector('form')!))).toMatchObject({ assigneeId: 'dev', qaOwnerId: 'qa', severity: 'high', priority: '3' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'qa.save' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(issue, expect.objectContaining({ type: 'triage', assigneeId: 'dev', qaOwnerId: 'qa', severity: 'high' }), expect.any(String)));
  });

  it('opens a secondary edit dialog through the menu while preserving keyboard focus', async () => {
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'qa.moreActions' }));
    const edit = await screen.findByRole('menuitem', { name: 'qa.edit' });
    await waitFor(() => expect(edit).toHaveFocus());
    fireEvent.keyDown(edit, { key: 'End' });
    // Delete is kept last, after a separator, for those allowed to delete.
    expect(screen.getByRole('menuitem', { name: 'qa.delete' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    fireEvent.click(edit);
    await screen.findByRole('dialog', { name: 'qa.edit' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByLabelText(/qa.titleField/)).toBeTruthy();
  });

  it('deletes a bug after one confirmation and leaves the record', async () => {
    const remove = vi.fn().mockResolvedValue(undefined), onDeleted = vi.fn();
    const client = { getDisplaySettings: async (): Promise<QaDisplaySettings> => ({ version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] }), getManualStateVisibility: async (): Promise<QaManualStateVisibility> => ({ version: 1, hiddenStates: [] as QaState[] }), getFieldConfiguration: vi.fn().mockResolvedValue({ version: 1, fields: [] }), versions: vi.fn().mockResolvedValue([]), delete: remove } as unknown as QaClient;
    render(<QaIssueDetail detail={detail} client={client} actor={{ id: 'admin', role: 'admin' }} onRefresh={vi.fn()} onBack={vi.fn()} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole('button', { name: 'qa.moreActions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'qa.delete' }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'common.confirm' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(remove).toHaveBeenCalledWith(detail.issue);
  });

  it('offers delete to the reporter of a new bug and to QA admins, not to other members', async () => {
    const open = async (actor: QaActor, state: QaDetail['issue']['state'] = 'new') => {
      const view = renderDetail({ issue: { ...issue, state } }, actor);
      // No menu at all when the member has nothing else to do here.
      const more = screen.queryByRole('button', { name: 'qa.moreActions' });
      if (!more) { view.unmount(); return false; }
      fireEvent.click(more);
      await screen.findAllByRole('menuitem');
      const found = !!screen.queryByRole('menuitem', { name: 'qa.delete' });
      view.unmount();
      return found;
    };
    expect(await open({ id: 'reporter', role: 'member' })).toBe(true);
    expect(await open({ id: 'reporter', role: 'member' }, 'triaged')).toBe(false);
    expect(await open({ id: 'qa-lead', role: 'member', qaAdmin: true }, 'triaged')).toBe(true);
    expect(await open({ id: 'visitor', role: 'member' })).toBe(false);
  });

  it('explains who acts next to another member and hides unauthorized controls', () => {
    renderDetail({ issue: { ...issue, state: 'in_progress', assigneeId: 'dev', qaOwnerId: 'qa' } }, { id: 'visitor', role: 'member' });
    expect(screen.getByText('qa.waitingForAction: Alex: qa.submitFix')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'qa.submitFix' })).toBeNull();
    // Anyone may change the owners, so More actions is there for every member.
    expect(screen.getByRole('button', { name: 'qa.moreActions' })).toBeTruthy();
  });

  it('offers only this project tasks and requires explicit removal of stale existing links', async () => {
    state.tasks = [
      { id: 'same', projectId: 'p1', taskKey: 'EX-1', title: 'This project task' },
      { id: 'other', projectId: 'p2', taskKey: 'EX-2', title: 'Other project task' },
      { id: 'old-other', projectId: 'p2', taskKey: 'EX-3', title: 'Previously linked elsewhere' },
    ] as Task[];
    const linked = { ...issue, taskIds: ['old-other', 'missing-task'] };
    const { command } = renderDetail({ issue: linked });
    fireEvent.click(screen.getByRole('button', { name: 'qa.moreActions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'qa.taskLinks' }));
    const dialog = await screen.findByRole('dialog', { name: 'qa.taskLinks' });
    expect(within(dialog).queryByRole('checkbox', { name: /Other project task/ })).toBeNull();
    expect(within(dialog).getByRole('checkbox', { name: /Previously linked elsewhere/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'missing-task' })).toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'qa.save' })).toBeDisabled();
    fireEvent.submit(dialog.querySelector('form')!);
    expect(command).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Previously linked elsewhere/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'missing-task' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /This project task/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'qa.save' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(linked, { type: 'link_tasks', taskIds: ['same'] }, expect.any(String)));
    expect(linked.taskIds).toEqual(['old-other', 'missing-task']);
  });

  it('prioritizes issue content and existing files; reveals upload only on demand and locks it during upload', async () => {
    let finish!: (file: object) => void;
    const { upload, container } = renderDetail({ attachments: [{ id: 'old', issueId: issue.id, fileName: 'existing.txt', mimeType: 'text/plain', size: 1, uploadedBy: 'qa', createdAt: issue.createdAt }] });
    upload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    expect(screen.getByText(issue.actual)).toBeTruthy();
    expect(screen.getByText(issue.expected)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'qa.steps' })).toBeNull();
    expect(screen.getByText('existing.txt')).toBeTruthy();
    expect(screen.queryByLabelText('qa.attach')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'qa.addAttachment' }));
    fireEvent.change(screen.getByLabelText('qa.attach'), { target: { files: [new File(['proof'], 'proof.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'qa.hideAttachmentUpload' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'qa.back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'qa.moreActions' })).toBeDisabled();
    expect(container.querySelector('input[type=file]')).toBeDisabled();
    await act(async () => finish({ id: 'uploaded' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'qa.back' })).toBeEnabled());
  });
});
