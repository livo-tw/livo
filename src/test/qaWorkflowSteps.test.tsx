import type { QaDisplaySettings } from '@/lib/qa/displaySettings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TFunction } from 'i18next';
import type { User, ProductLine, Task } from '@/types';
const state = vi.hoisted(() => ({ users: [] as User[], tasks: [] as Task[] }));
const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: notices }));
const translate = (key: string, values?: Record<string, unknown>) => values ? `${key}(${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(',')})` : key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: state.users }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [{ id: 'p1', name: 'Example project', color: '#123456' }], productLines: [] as ProductLine[] }) }));
vi.mock('@/context/TaskContext', () => ({ useTaskContext: () => ({ allTasks: state.tasks }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ taskDisplayMode: 'modal', setTaskDisplayMode: vi.fn(), setSelectedTask: vi.fn() }) }));
vi.mock('@/context/DeploymentEnvironmentContext', () => ({ useDeploymentEnvironments: () => ({ ready: true, values: ['Stage'] }) }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: {} }));
vi.mock('@/components/knowledge/RelatedKnowledge', () => ({ default: (): null => null }));
import QaIssueDetail from '@/components/qa/QaIssueDetail';
import { getQaNextAction } from '@/components/qa/QaIssueCard';
import { qaEventText, qaEventTitle } from '@/components/qa/qaEventText';
import { applyQaCommand, createQaIssue, qaEventDetail, qaIdSearch, qaNotificationRecipients, type QaContext, type QaHandoff, type QaIssue, type QaTarget, type QaCommand } from '@/lib/qa/domain';
import type { QaActor, QaDetail } from '@/lib/qa/domain';
import type { QaClient } from '@/lib/qa/client';
import { buildMyAssignments } from '@/lib/myAssignments';

const person = (id: string, name: string): User => ({ id, name, isActive: true, jobTitle: 'Engineer', role: 'member', avatar: name[0], color: '#123456', email: `${id}@example.com`, sortOrder: 1 });
const context = (actor: QaActor = { id: 'reporter', role: 'member' }): QaContext => ({ actor, workspaceId: 'default', now: '2026-10-03T00:00:00.000Z', newId: () => 'example-id',
  memberIds: new Set(['reporter', 'dev', 'qa']), projectIds: new Set(['p1']), taskIds: new Set(), environmentValues: ['Stage'] });
const base = createQaIssue({ projectId: 'p1', title: 'Checkout error', actual: 'Cannot save a valid entry', observedEnvironment: 'Stage' }, 'bug-0000-1234abcd', context());
const owned: QaIssue = { ...base, state: 'in_progress', assigneeId: 'dev', qaOwnerId: 'qa', version: 3 };
const target = (extra: Partial<QaTarget> = {}): QaTarget => ({ id: 't1', environment: 'Stage', component: '', build: 'b1', required: true, deployedAt: '2026-10-03T01:00:00.000Z', deployedBy: 'dev', deploymentEvidence: 'Deployed', ...extra });

beforeEach(() => {
  state.users = [person('reporter', 'Robin'), person('dev', 'Alex'), person('qa', 'Blair')];
  state.tasks = []; notices.success.mockClear(); notices.error.mockClear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function renderDetail(issue: QaIssue, actor: QaActor, extra: Partial<QaDetail> = {}, list = vi.fn(), getManualStateVisibility = vi.fn().mockResolvedValue({ version: 1, hiddenStates: [] })) {
  const command = vi.fn().mockImplementation(async (_issue: QaIssue, next: QaCommand) => ({ ...issue, version: issue.version + 1, ...(next.type === 'set_state' ? { state: (next as unknown as { state: QaIssue['state'] }).state } : {}) }));
  const client = { getManualStateVisibility, getDisplaySettings: async (): Promise<QaDisplaySettings> => ({ version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] }), getFieldConfiguration: vi.fn().mockResolvedValue({ version: 1, fields: [] }), command, list, versions: vi.fn().mockResolvedValue([]) } as unknown as QaClient;
  const detail: QaDetail = { issue, comments: [], events: [], attachments: [], ...extra };
  const props = { detail, client, actor, onRefresh: vi.fn().mockResolvedValue(undefined), onBack: vi.fn() };
  return { ...render(<QaIssueDetail {...props} />), command, list, onRefresh: props.onRefresh };
}

describe('the next step follows what the bug still lacks', () => {
  const lead: QaActor = { id: 'qa', role: 'member' };
  it('asks for owners, a fix, a deployment and a passing verification before closing', () => {
    expect(getQaNextAction({ ...owned, qaOwnerId: null }, lead)?.command).toBe('update_fields');
    expect(getQaNextAction({ ...owned, state: 'new' }, { id: 'dev', role: 'member' })?.command).toBe('start_fix');
    // Moved to verification by hand, without a submitted fix.
    expect(getQaNextAction({ ...owned, state: 'verification', targets: [] }, lead)?.command).toBe('submit_fix');
    expect(getQaNextAction({ ...owned, state: 'verification', targets: [target({ deployedAt: null })] }, { id: 'dev', role: 'member' })?.command).toBe('record_deployment');
    // Verified by hand, but nothing passed yet.
    expect(getQaNextAction({ ...owned, state: 'verified', targets: [target()], runs: [] }, lead)).toEqual({ command: 'record_verification', label: 'addVerificationEvidence' });
    const passed = { ...owned, state: 'verified' as const, fixCycle: 1, targets: [target()], runs: [{ id: 'r1', sequence: 1, fixCycle: 1, targetId: 't1', environment: 'Stage', component: '', build: 'b1', result: 'pass' as const, note: '', testerId: 'qa', createdAt: '2026-10-03T02:00:00.000Z' }] };
    expect(getQaNextAction(passed, lead)?.command).toBe('close');
    renderDetail(passed, lead);
    fireEvent.click(screen.getByRole('tab', { name: /qa.verificationTab/ }));
    expect(screen.queryByLabelText('qa.resultField')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'qa.verification' })).not.toBeInTheDocument();
    expect(getQaNextAction({ ...owned, state: 'closed' }, lead)?.command).toBe('reopen');
  });
});

describe('blockers and reopen reasons', () => {
  it('keeps the reopen reason apart from the blocker and lets a hold be cleared', () => {
    const held = applyQaCommand(owned, { type: 'hold', reason: 'Waiting for the payment sandbox' }, context({ id: 'dev', role: 'member' }));
    expect(held.holdReason).toBe('Waiting for the payment sandbox');
    expect(applyQaCommand(held, { type: 'hold', reason: '' }, context({ id: 'dev', role: 'member' })).holdReason).toBe('');
    const reopened = applyQaCommand({ ...held, state: 'closed', closedAt: '2026-10-03T00:00:00.000Z', resolution: 'fixed' }, { type: 'reopen', reason: 'Happens again on Stage' }, context());
    expect(reopened).toMatchObject({ reopenReason: 'Happens again on Stage', holdReason: '', state: 'in_progress' });
    expect(qaEventDetail(reopened, 'reopen')).toBe('Happens again on Stage');
  });
  it('shows the current blocker with a clear button, and the reopen reason separately', async () => {
    const { command } = renderDetail({ ...owned, holdReason: 'Waiting for the payment sandbox', reopenReason: 'Happens again on Stage' }, { id: 'dev', role: 'member' });
    expect(screen.getByText('qa.holdCurrent')).toBeTruthy();
    expect(screen.getByText('qa.reopenReason')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'qa.clearHold' }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][1]).toEqual({ type: 'hold', reason: '' });
  });
});

describe('moving a bug to a final status by hand', () => {
  it('asks first, because no verification or closing reason is recorded', async () => {
    const { command } = renderDetail(owned, { id: 'reporter', role: 'member' });
    const pick = async () => { await waitFor(() => expect(screen.getByRole('combobox', { name: 'qa.changeState' })).not.toBeDisabled()); fireEvent.click(screen.getByRole('combobox', { name: 'qa.changeState' })); fireEvent.click(await screen.findByRole('option', { name: 'qa.state.closed' })); };
    await pick();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('qa.terminalConfirmDesc')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'common.cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(command).not.toHaveBeenCalled();
    await pick();
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'common.confirm' }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(command.mock.calls[0][1]).toEqual({ type: 'set_state', state: 'closed' });
  });
});

describe('closing as a duplicate', () => {
  it('accepts the short id shown on cards and sends the full id', async () => {
    const list = vi.fn().mockResolvedValue({ issues: [{ ...base, id: 'bug-0000-9999ffff' }], total: 1, hasMore: false });
    const { command } = renderDetail(owned, { id: 'qa', role: 'member' }, {}, list);
    fireEvent.click(screen.getByRole('button', { name: 'qa.moreActions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'qa.close' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox', { name: /qa.resolutionField/ }), { target: { value: 'duplicate' } });
    fireEvent.change(within(dialog).getByLabelText(/qa.duplicateId/), { target: { value: '#9999ffff' } });
    fireEvent.change(within(dialog).getByLabelText(/qa.reason/), { target: { value: 'Same checkout failure' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'qa.save' }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(list).toHaveBeenCalledWith({ projectId: 'p1', search: '#9999ffff', limit: 2 });
    expect(command.mock.calls[0][1]).toMatchObject({ type: 'close', resolution: 'duplicate', duplicateOfId: 'bug-0000-9999ffff' });
  });
});

describe('readable history', () => {
  const t = translate as unknown as TFunction;
  const names: Record<string, string> = { dev: 'Alex', qa: 'Blair' };
  const ctx = { t, member: (id: string) => names[id] ?? id, task: (id: string) => id === 'task-1' ? 'EX-1 · Fix checkout' : id, stateLabel: (value: string) => `state:${value}`, date: () => 'Oct 3' };
  it('turns stored ids and codes into names and words', () => {
    expect(qaEventText({ type: 'triage', detail: 'RD: dev · QA: qa\nhigh · P2\n2026-10-10' }, ctx)).toBe('qa.assignee：Alex · qa.qaOwner：Blair\nqa.severity：qa.severityNames.high · qa.priority：priority.high\nqa.dueDate：2026-10-10');
    expect(qaEventText({ type: 'close', detail: 'duplicate\nSame failure\nbug-0000-9999ffff' }, ctx)).toBe('qa.resolution.duplicate\nSame failure\nqa.duplicateOf(id=#9999ffff)');
    expect(qaEventText({ type: 'request_handoff', detail: JSON.stringify({ nextOwnerId: 'qa', reason: 'Needs the vendor', replyBy: '2026-10-05T00:00:00.000Z', externalDependency: '' }) }, ctx)).toBe('qa.historyHandoffTo(name=Blair)\nNeeds the vendor\nqaHandoff.replyBy：Oct 3');
    expect(qaEventText({ type: 'link_tasks', detail: 'task-1\ntask-gone' }, ctx)).toBe('EX-1 · Fix checkout\ntask-gone');
    expect(qaEventText({ type: 'record_verification', detail: '第 1 輪 · 第 2 次驗證\nStage · - · b1\nFAIL\nStill broken' }, ctx)).toContain('\nqa.result.fail\n');
    expect(qaEventText({ type: 'record_deployment', detail: 'Stage · - · b1 · 必要\n2026-10-03T01:00:00.000Z · dev\nDeployed' }, ctx)).toBe('Stage · - · b1 · 必要\nOct 3 · Alex\nDeployed');
    expect(qaEventTitle({ type: 'hold', detail: '' }, t)).toBe('qa.historyEvent.holdCleared');
    expect(qaEventTitle({ type: 'created', detail: 'x' }, t)).toBe('qa.historyEvent.create');
  });
  it('keeps comments out of the history tab and shows names instead of ids', () => {
    renderDetail(owned, { id: 'qa', role: 'member' }, { events: [
      { id: 'e1', issueId: owned.id, actorId: 'qa', type: 'triage', detail: 'RD: dev · QA: qa\nmedium · P3', version: 2, createdAt: '2026-10-03T00:00:00.000Z' },
      { id: 'e2', issueId: owned.id, actorId: 'dev', type: 'comment', detail: 'comment', version: 3, createdAt: '2026-10-03T01:00:00.000Z' },
    ] });
    const tab = screen.getByRole('tab', { name: /qa.history/ });
    expect(within(tab).getByText('1')).toBeTruthy();
    fireEvent.click(tab);
    expect(screen.getByText(/qa.assignee：Alex/)).toBeTruthy();
    expect(screen.queryByText(/RD: dev/)).toBeNull();
  });
});

describe('shared rules', () => {
  it('sends notifications to the same people on every server', () => {
    const issue = { ...owned, reporterId: 'reporter' };
    expect(qaNotificationRecipients(issue, 'create', 'reporter', ['coordinator'])).toEqual(['coordinator', 'dev', 'qa']);
    expect(qaNotificationRecipients(issue, 'comment', 'qa')).toEqual(['reporter', 'dev']);
    expect(qaNotificationRecipients(issue, 'close', 'qa')).toEqual(['reporter', 'dev']);
    expect(qaNotificationRecipients(issue, 'start_fix', 'dev')).toEqual([]);
    expect(qaNotificationRecipients(issue, 'link_tasks', 'dev')).toEqual([]);
    expect(qaNotificationRecipients(issue, 'submit_fix', 'dev')).toEqual(['qa']);
    expect(qaNotificationRecipients(issue, 'record_verification', 'qa')).toEqual(['dev']);
  });
  it('treats "#" and full ids as id searches and everything else as title words', () => {
    expect(qaIdSearch('#1234abcd')).toBe('1234abcd');
    expect(qaIdSearch(' #ab ')).toBe('ab');
    expect(qaIdSearch('00000000-0000-4000-8000-00000000abcd')).toBe('00000000-0000-4000-8000-00000000abcd');
    expect(qaIdSearch('1234abcd')).toBeNull();
    expect(qaIdSearch('#a b')).toBeNull();
  });
  it('puts a handoff waiting on me in my assignments until it is resolved', () => {
    const handoff: QaHandoff = { id: 'h1', reason: 'Vendor', nextOwnerId: 'me', replyBy: null, externalDependency: '', requestedBy: 'qa', requestedAt: '2026-10-03T00:00:00.000Z', acceptedBy: null, acceptedAt: null, resolvedBy: null, resolvedAt: null, resolutionEvidence: '' };
    const waiting = { ...owned, assigneeId: 'dev', qaOwnerId: 'qa', handoff };
    expect(buildMyAssignments([], [], [waiting], 'me')[0]?.roles).toEqual(['handoff']);
    expect(buildMyAssignments([], [], [{ ...waiting, handoff: { ...waiting.handoff, resolvedBy: 'me', resolvedAt: '2026-10-03T03:00:00.000Z', resolutionEvidence: 'Done' } }], 'me')).toEqual([]);
  });
});

describe('manual state visibility read guards in the actual issue detail', () => {
  it('keeps manual changes disabled on a read failure and enables only fresh visible choices after retry', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ version: 1, hiddenStates: ['triaged', 'closed'] });
    renderDetail(owned, { id: 'dev', role: 'member' }, {}, vi.fn(), read);
    const trigger = screen.getByRole('combobox', { name: 'qa.changeState' });
    expect(trigger).toBeDisabled();
    expect(await screen.findByText('qa.manualStates.loadFailed')).toBeInTheDocument();
    expect(trigger).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'qa.retry' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'qa.changeState' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('combobox', { name: 'qa.changeState' }));
    expect(screen.queryByRole('option', { name: 'qa.state.triaged' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'qa.state.closed' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'qa.state.verified' })).toBeInTheDocument();
  });
  it('displays the hidden current state but never adds it to the choices', async () => {
    const read = vi.fn().mockResolvedValue({ version: 1, hiddenStates: ['triaged', 'closed'] });
    renderDetail({ ...owned, state: 'triaged' }, { id: 'dev', role: 'member' }, {}, vi.fn(), read);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'qa.changeState' })).not.toBeDisabled());
    const trigger = screen.getByRole('combobox', { name: 'qa.changeState' });
    expect(within(trigger).getByText('qa.state.triaged')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByRole('option', { name: 'qa.state.triaged' })).not.toBeInTheDocument();
  });
});


describe('formal PASS automatically completes the current work', () => {
  const lead: QaActor = { id: 'qa', role: 'member' };
  const run = (targetId: string, sequence: number) => ({ id: `r${sequence}`, sequence, fixCycle: 1, targetId, environment: 'Stage', component: '', build: 'b1', result: 'pass' as const, note: '', testerId: 'qa', createdAt: '2026-10-03T01:00:00.000Z' });
  const candidate = (alreadyPassed = 2): QaIssue => ({ ...owned, state: 'verification', fixCycle: 1,
    targets: [target(), target({ id: 't2' }), target({ id: 't3' })], runs: [run('t1', 1), run('t2', 2)].slice(0, alreadyPassed) });
  it.each([false, true])('reflects the final acknowledged PASS even when detail refresh fails: %s', async refreshFails => {
    const issue = candidate();
    const { command, onRefresh } = renderDetail(issue, lead);
    let saved: QaIssue | undefined;
    command.mockImplementation(async (before: QaIssue, next) => { saved = applyQaCommand(before, next, { ...context(lead), now: '2026-10-03T02:00:00.000Z' }); return saved; });
    if (refreshFails) onRefresh.mockRejectedValue(new Error('temporary read failure'));
    const changed = vi.fn(); window.addEventListener('livo:qa-changed', changed);
    try {
      fireEvent.click(screen.getByRole('tab', { name: /qa.verificationTab/ }));
      expect(screen.getByText('qa.autoCloseAfterVerificationHint')).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole('button', { name: 'qa.verification' }).at(-1)!);
      await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
      expect(saved).toMatchObject({ state: 'closed', resolution: 'fixed', closedBy: 'qa', closedAt: '2026-10-03T02:00:00.000Z' });
      expect(command).toHaveBeenCalledOnce();
      expect(command.mock.calls[0][1]).toMatchObject({ type: 'record_verification', targetId: 't3', result: 'pass' });
      expect(notices.success).toHaveBeenCalledWith('qa.verificationAutoClosed');
      expect(changed).toHaveBeenCalledOnce();
      expect(buildMyAssignments([], [], [saved!], 'qa')).toEqual([]);
      expect(screen.queryByRole('button', { name: 'qa.verification' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'qa.close' })).not.toBeInTheDocument();
      if (refreshFails) expect(await screen.findByText('qaHandoff.savedRefreshFailed')).toBeInTheDocument();
    } finally { window.removeEventListener('livo:qa-changed', changed); }
  });
  it('localizes the confirmed closing history without treating author notes as closure metadata', () => {
    const note = 'Example note\n所有必要環境已部署並驗證通過，已自動結案。';
    const closed = applyQaCommand(candidate(), { type: 'record_verification', targetId: 't3', build: 'b1', result: 'pass', note }, { ...context(lead), now: '2026-10-03T02:00:00.000Z' });
    const event = { type: 'record_verification', version: closed.version, detail: qaEventDetail(closed, 'record_verification') };
    const ctx = { t: translate as unknown as TFunction, member: (id: string) => id, task: (id: string) => id, stateLabel: (s: string) => s, date: (s: string) => s, issue: closed };
    const text = qaEventText(event, ctx);
    expect(text).toContain(note);
    expect(text).toContain('qa.verificationAutoCloseHistory');
    expect(qaEventText({ ...event, version: closed.version - 1 }, ctx)).not.toContain('qa.verificationAutoCloseHistory');
  });
  it('keeps partial PASS in open assignments and leaves remaining verification available', async () => {
    const issue = candidate(0), { command } = renderDetail(issue, lead);
    let saved: QaIssue | undefined;
    command.mockImplementation(async (before: QaIssue, next) => { saved = applyQaCommand(before, next, context(lead)); return saved; });
    fireEvent.click(screen.getByRole('tab', { name: /qa.verificationTab/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'qa.verification' })[0]);
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(saved?.state).toBe('verification');
    expect(buildMyAssignments([], [], [saved!], 'qa')).toHaveLength(1);
    expect(notices.success).not.toHaveBeenCalledWith('qa.verificationAutoClosed');
    expect(screen.getAllByRole('button', { name: 'qa.verification' })).toHaveLength(3);
  });
  it('does not announce or invalidate work whose verification result is unknown', async () => {
    const { command } = renderDetail(candidate(), lead);
    command.mockRejectedValue(new Error('response lost'));
    const changed = vi.fn(); window.addEventListener('livo:qa-changed', changed);
    try {
      fireEvent.click(screen.getByRole('tab', { name: /qa.verificationTab/ }));
      fireEvent.click(screen.getAllByRole('button', { name: 'qa.verification' }).at(-1)!);
      await waitFor(() => expect(notices.error).toHaveBeenCalled());
      expect(changed).not.toHaveBeenCalled();
      expect(notices.success).not.toHaveBeenCalled();
    } finally { window.removeEventListener('livo:qa-changed', changed); }
  });
});
