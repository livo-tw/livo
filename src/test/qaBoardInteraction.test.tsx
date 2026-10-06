import type { ReactNode } from 'react';
import type { DragEndEvent } from '@dnd-kit/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQaIssue, QA_STATES, type QaActor, type QaIssue, type QaState } from '@/lib/qa/domain';
import { getQaDropIntent } from '@/lib/qa/boardInteraction';
import { hasQaNavigationGuard } from '@/lib/qa/navigationGuard';
import { DEFAULT_QA_WORKFLOW, type QaWorkflow } from '@/lib/qa/workflow';
import type { QaClient } from '@/lib/qa/client';

const dnd = vi.hoisted(() => ({ end: undefined as ((event: DragEndEvent) => void) | undefined, draggable: vi.fn() }));
const notices = vi.hoisted(() => ({ loading: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() }));
vi.mock('sonner', () => ({ toast: notices }));
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ onDragEnd, children }: { onDragEnd: (event: DragEndEvent) => void; children: ReactNode }) => { dnd.end = onDragEnd; return <>{children}</>; },
  DragOverlay: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSensor: vi.fn(), useSensors: vi.fn(), MouseSensor: class { static activators: never[] = []; }, TouchSensor: class { static activators: never[] = []; }, KeyboardSensor: {},
  KeyboardCode: { Space: 'Space', Esc: 'Escape' }, closestCenter: vi.fn(), pointerWithin: vi.fn(),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDraggable: (options: unknown) => { dnd.draggable(options); return { attributes: {}, listeners: {}, setNodeRef: vi.fn(), isDragging: false }; },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/qa/QaIssueCard', () => ({ default: ({ issue, onOpen }: { issue: QaIssue; onOpen: (id: string) => void }) => <button onClick={() => onOpen(issue.id)}>{issue.title}</button> }));
vi.mock('@/components/qa/QaIssueDetail', () => ({ QaFailure: () => <p role="alert">Command failed</p> }));
import QaKanban from '@/components/qa/QaKanban';

const admin: QaActor = { id: 'example-admin', role: 'admin' };
const developer: QaActor = { id: 'example-developer', role: 'member' };
const tester: QaActor = { id: 'example-tester', role: 'member' };
function issue(state: QaState = 'triaged'): QaIssue {
  return { ...createQaIssue({ projectId: 'example-project', title: 'The demo button stops responding', actual: 'Nothing happens', observedEnvironment: 'Stage' }, 'example-bug',
    { actor: admin, workspaceId: 'example-workspace', now: '2026-10-03T00:00:00Z', newId: () => 'example-event', memberIds: new Set([admin.id]), projectIds: new Set(['example-project']), taskIds: new Set() }),
    state, assigneeId: developer.id, qaOwnerId: tester.id };
}
afterEach(cleanup);

describe('QA drops directly change labels without creating verification evidence', () => {
  it('does not move within a grouped display column', () => {
    expect(getQaDropIntent(issue('new'), admin, ['new', 'triaged'], 'triaged')).toEqual({ kind: 'none' });
    expect(getQaDropIntent(issue('verification'), admin, ['in_progress', 'verification'])).toEqual({ kind: 'none' });
  });
  it('lets participants move forwards and backwards across all canonical states', () => {
    for (const actor of [admin, developer, tester]) for (const from of QA_STATES) for (const to of QA_STATES) {
      expect(getQaDropIntent(issue(from), actor, [to])).toEqual(from === to ? { kind: 'none' } : { kind: 'command', command: { type: 'set_state', state: to } });
    }
  });
  it('allows historical PASS to FAIL, and moving unassigned bugs without mandatory forms', () => {
    expect(getQaDropIntent(issue('verified'), tester, ['failed'])).toEqual({ kind: 'command', command: { type: 'set_state', state: 'failed' } });
    expect(getQaDropIntent({ ...issue('new'), assigneeId: null, qaOwnerId: null }, admin, ['verification'])).toEqual({ kind: 'command', command: { type: 'set_state', state: 'verification' } });
    expect(issue('verified').targets).toEqual([]); expect(issue('verified').runs).toEqual([]);
  });
  it('uses the canonical column ID for custom groups rather than its first state', () => {
    expect(getQaDropIntent(issue('failed'), admin, ['new', 'triaged'], 'triaged')).toEqual({ kind: 'command', command: { type: 'set_state', state: 'triaged' } });
  });
  it('blocks observers and invalid destinations without using an arbitrary command', () => {
    expect(getQaDropIntent(issue(), { id: 'example-observer', role: 'member' }, ['in_progress'])).toEqual({ kind: 'blocked', reason: 'permission' });
    expect(getQaDropIntent(issue(), admin, [])).toEqual({ kind: 'blocked', reason: 'invalid' });
    expect(getQaDropIntent(issue(), admin, ['new'], 'failed')).toEqual({ kind: 'blocked', reason: 'invalid' });
  });
});

describe('QA board state updates provide visible feedback and recover safely', () => {
  const command = vi.fn(), list = vi.fn(), open = vi.fn();
  let current: QaIssue;
  const client = { command, list } as unknown as QaClient;
  const drop = (target: QaState) => act(() => dnd.end!({ active: { id: current.id, data: { current: { issue: current } } }, over: { id: `qa-column-${target}` } } as unknown as DragEndEvent));
  const mount = (workflow: QaWorkflow = DEFAULT_QA_WORKFLOW, actor = admin) => render(<QaKanban client={client} actor={actor} workflow={workflow} filters={{}} onOpen={open} />);
  const column = (state: QaState) => within(screen.getByRole('region', { name: `qa.state.${state}` }));
  beforeEach(() => {
    vi.clearAllMocks(); current = issue();
    command.mockImplementation(async (old: QaIssue, change: { state: QaState }) => { current = { ...old, state: change.state, version: old.version + 1 }; return current; });
    list.mockImplementation(async ({ states }: { states: QaState[] }) => ({ issues: states.includes(current.state) ? [current] : [], total: states.includes(current.state) ? 1 : 0, hasMore: false }));
  });
  it('moves optimistically, announces progress and refetches only after acknowledgement', async () => {
    let acknowledge!: (value: QaIssue) => void;
    command.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    mount(); await screen.findByText(current.title);
    const originalLoads = list.mock.calls.length;
    drop('in_progress');
    expect(command).toHaveBeenCalledWith(current, { type: 'set_state', state: 'in_progress' }, expect.any(String));
    expect(column('in_progress').getByText(current.title)).toBeTruthy(); expect(column('triaged').queryByText(current.title)).toBeNull();
    expect(column('in_progress').getByText('1')).toBeTruthy(); expect(column('triaged').getByText('0')).toBeTruthy();
    expect(notices.loading).toHaveBeenCalledWith('qa.dropSaving', expect.objectContaining({ position: 'top-center' }));
    expect(list).toHaveBeenCalledTimes(originalLoads);
    current = { ...current, state: 'in_progress', version: 2 };
    await act(async () => acknowledge(current));
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(originalLoads));
    expect(column('in_progress').getByText('1')).toBeTruthy(); expect(notices.success).toHaveBeenCalledWith('qa.dropSaved', expect.objectContaining({ position: 'top-center' }));
    expect(open).not.toHaveBeenCalled();
  });
  it('retains the command ID after an uncertain response, rolls back, and retries once', async () => {
    command.mockRejectedValueOnce({ status: 503, code: 'qa_unavailable' }).mockImplementationOnce(async (old: QaIssue, change: { state: QaState }) => { current = { ...old, state: change.state }; return current; });
    mount(); await screen.findByText(current.title); drop('in_progress');
    await screen.findByRole('alert');
    expect(column('triaged').getByText(current.title)).toBeTruthy(); expect(column('in_progress').queryByText(current.title)).toBeNull();
    expect(notices.error).toHaveBeenCalledWith('qa.dropFailed', expect.objectContaining({ description: 'qa.dropUncertain', duration: Infinity, position: 'top-center' }));
    const first = command.mock.calls[0];
    drop('dismissed'); expect(command).toHaveBeenCalledTimes(1); expect(notices.info).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'qa.retry' }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls[1]).toEqual(first);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('changes historical PASS to FAIL directly without an extra form', async () => {
    current = issue('verified'); mount(); await screen.findByText(current.title); drop('failed');
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ state: 'verified' }), { type: 'set_state', state: 'failed' }, expect.any(String)));
    expect(open).not.toHaveBeenCalled(); expect(current.runs).toEqual([]); expect(current.targets).toEqual([]);
  });
  it('explains permission refusals in an immediate toast with an Open Bug action', async () => {
    mount(DEFAULT_QA_WORKFLOW, { id: 'example-observer', role: 'member' }); await screen.findByText(current.title); drop('closed');
    expect(command).not.toHaveBeenCalled();
    expect(dnd.draggable).toHaveBeenCalledWith(expect.objectContaining({ disabled: false }));
    const options = notices.error.mock.calls[0][1]; expect(options.description).toBe('qa.dropPermission'); expect(options.position).toBe('top-center');
    options.action.onClick(); expect(open).toHaveBeenCalledWith(current.id, undefined, undefined);
  });
  it('rolls back server permission errors and offers opening the bug instead of retrying forbidden actions', async () => {
    command.mockRejectedValueOnce({ status: 403, code: 'qa_forbidden' }); mount(); await screen.findByText(current.title); drop('failed');
    await screen.findByRole('alert'); expect(column('triaged').getByText(current.title)).toBeTruthy(); expect(screen.queryByRole('button', { name: 'qa.retry' })).toBeNull();
    notices.error.mock.calls[0][1].action.onClick(); expect(open).toHaveBeenCalledWith(current.id, undefined, undefined);
  });
  it('protects uncertain commands from navigation and confirms a lost acknowledgement by refreshing', async () => {
    command.mockImplementationOnce(async (old: QaIssue, change: { state: QaState }) => {
      current = { ...old, state: change.state, version: old.version + 1 };
      throw { status: 503, code: 'qa_unavailable' };
    });
    const pending = vi.fn(); render(<QaKanban client={client} actor={admin} workflow={DEFAULT_QA_WORKFLOW} filters={{}} onOpen={open} onPendingChange={pending} />);
    await screen.findByText(current.title); drop('failed'); await screen.findByRole('alert');
    expect(hasQaNavigationGuard()).toBe(true); expect(pending).toHaveBeenLastCalledWith(true);
    fireEvent.click(column('triaged').getByRole('button', { name: current.title })); expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'qa.refresh' }));
    await waitFor(() => expect(column('failed').getByText(current.title)).toBeTruthy());
    await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
    expect(hasQaNavigationGuard()).toBe(false); expect(notices.dismiss).toHaveBeenCalled(); expect(command).toHaveBeenCalledTimes(1);
  });
  it('keeps acknowledged status while a refreshed column fails and recovers without double-counting', async () => {
    let fail = false;
    list.mockImplementation(async ({ states }: { states: QaState[] }) => {
      if (fail && states.includes('failed')) throw { status: 503 };
      return { issues: states.includes(current.state) ? [current] : [], total: states.includes(current.state) ? 1 : 0, hasMore: false };
    });
    mount(); await screen.findByText(current.title); fail = true; drop('failed');
    await screen.findByRole('alert'); expect(column('failed').getByText(current.title)).toBeTruthy(); expect(column('failed').getByText('1')).toBeTruthy();
    fail = false; fireEvent.click(column('failed').getByRole('button', { name: 'qa.refresh' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull()); expect(column('failed').getByText('1')).toBeTruthy();
    await waitFor(() => expect(dnd.draggable).toHaveBeenLastCalledWith(expect.objectContaining({ disabled: false })));
  });
  it('reloads in place when a bug changed in the detail view, without dropping an unconfirmed move', async () => {
    const props = { client, actor: admin, workflow: DEFAULT_QA_WORKFLOW, filters: {}, onOpen: open };
    const view = render(<QaKanban {...props} reloadToken={0} />);
    await screen.findByText(current.title);
    current = { ...current, state: 'in_progress' };
    view.rerender(<QaKanban {...props} reloadToken={1} />);
    await waitFor(() => expect(column('in_progress').getByText(current.title)).toBeTruthy());
    expect(column('triaged').queryByText(current.title)).toBeNull();
    command.mockRejectedValueOnce({ status: 503 });
    drop('triaged'); await screen.findByRole('alert');
    const loads = list.mock.calls.length;
    view.rerender(<QaKanban {...props} reloadToken={2} />);
    expect(list).toHaveBeenCalledTimes(loads); expect(screen.getByRole('button', { name: 'qa.retry' })).toBeTruthy();
  });
  it('ignores a cancelled drop outside all columns', async () => {
    mount(); await screen.findByText(current.title);
    act(() => dnd.end!({ active: { id: current.id, data: { current: { issue: current } } }, over: null } as unknown as DragEndEvent));
    expect(command).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(notices.loading).not.toHaveBeenCalled();
  });
  it('retries page zero after a project change without showing the previous project', async () => {
    const old = { ...current, title: 'Old project Bug', projectId: 'example-project-a' };
    const next = { ...current, id: 'example-next-bug', title: 'Next project Bug', projectId: 'example-project-b' };
    let failed = false;
    list.mockImplementation(async ({ states, projectId, offset }: { states: QaState[]; projectId: string; offset: number }) => {
      if (!states.includes('triaged')) return { issues: [], total: 0, hasMore: false };
      if (projectId === 'example-project-a') return { issues: [old], total: 21, hasMore: true };
      if (!failed) { failed = true; throw { status: 503 }; }
      return { issues: offset === 0 ? [next] : [], total: 1, hasMore: false };
    });
    const props = { client, actor: admin, workflow: DEFAULT_QA_WORKFLOW, onOpen: open };
    const view = render(<QaKanban {...props} filters={{ projectId: 'example-project-a' }} />);
    await screen.findByText(old.title);
    view.rerender(<QaKanban {...props} filters={{ projectId: 'example-project-b' }} />);
    await screen.findByRole('alert'); expect(screen.queryByText(old.title)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'qa.refresh' }));
    await screen.findByText(next.title);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'example-project-b', states: ['triaged'], offset: 0 }), expect.any(AbortSignal));
    expect(screen.queryByText(old.title)).toBeNull();
  });
});
