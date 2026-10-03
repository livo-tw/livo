import type { ReactNode } from 'react';
import type { DragEndEvent } from '@dnd-kit/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQaIssue, type QaActor, type QaIssue, type QaState } from '@/lib/qa/domain';
import { getQaDropIntent } from '@/lib/qa/boardInteraction';
import { DEFAULT_QA_WORKFLOW, type QaWorkflow } from '@/lib/qa/workflow';
import type { QaClient } from '@/lib/qa/client';

const dnd = vi.hoisted(() => ({ end: undefined as ((event: DragEndEvent) => void) | undefined }));
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ onDragEnd, children }: { onDragEnd: (event: DragEndEvent) => void; children: ReactNode }) => { dnd.end = onDragEnd; return <>{children}</>; },
  DragOverlay: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSensor: vi.fn(), useSensors: vi.fn(), PointerSensor: {}, TouchSensor: {}, KeyboardSensor: {},
  KeyboardCode: { Space: 'Space', Esc: 'Escape' }, closestCenter: vi.fn(), pointerWithin: vi.fn(),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), isDragging: false }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/qa/QaIssueCard', () => ({ default: ({ issue, onOpen }: { issue: QaIssue; onOpen: (id: string) => void }) => <button onClick={() => onOpen(issue.id)}>{issue.title}</button> }));
vi.mock('@/components/qa/QaIssueDetail', () => ({ QaFailure: () => <p role="alert">Command failed</p> }));
import QaKanban from '@/components/qa/QaKanban';

const admin: QaActor = { id: 'example-admin', role: 'admin' };
const developer: QaActor = { id: 'example-developer', role: 'member' };
function issue(state: QaState = 'triaged'): QaIssue {
  return { ...createQaIssue({ projectId: 'example-project', title: 'The demo button stops responding', actual: 'Nothing happens', observedEnvironment: 'Stage' }, 'example-bug',
    { actor: admin, workspaceId: 'example-workspace', now: '2026-10-03T00:00:00Z', newId: () => 'example-event', memberIds: new Set([admin.id]), projectIds: new Set(['example-project']), taskIds: new Set() }),
    state, assigneeId: developer.id, qaOwnerId: 'example-tester',
    targets: state === 'verification' ? [{ id: 'example-target', environment: 'Stage', component: '', build: 'example-build', required: true, deployedAt: '2026-10-03T00:00:00Z', deployedBy: developer.id, deploymentEvidence: 'Example deployment' }] : [] };
}
const tester: QaActor = { id: 'example-tester', role: 'member' };
afterEach(cleanup);

describe('QA drops use guarded workflow commands', () => {
  it('does not move within a grouped display column', () => {
    expect(getQaDropIntent(issue('new'), admin, ['new', 'triaged'])).toEqual({ kind: 'none' });
    expect(getQaDropIntent(issue('verification'), admin, ['in_progress', 'verification'])).toEqual({ kind: 'none' });
  });
  it('starts repair directly, but requests required data for assignment and fix submission', () => {
    expect(getQaDropIntent(issue(), developer, ['in_progress'])).toEqual({ kind: 'command', command: { type: 'start_fix' } });
    expect(getQaDropIntent(issue('new'), admin, ['triaged'])).toEqual({ kind: 'form', action: 'triage' });
    expect(getQaDropIntent(issue('in_progress'), developer, ['verification'])).toEqual({ kind: 'form', action: 'submit_fix' });
  });
  it('preserves the chosen verification result and does not manufacture PASS or FAIL evidence', () => {
    expect(getQaDropIntent(issue('verification'), tester, ['verified'])).toEqual({ kind: 'form', action: 'record_verification', result: 'pass' });
    expect(getQaDropIntent(issue('verification'), tester, ['failed'])).toEqual({ kind: 'form', action: 'record_verification', result: 'fail' });
    expect(getQaDropIntent(issue('in_progress'), tester, ['verified'])).toEqual({ kind: 'blocked' });
  });
  it('cannot close a Bug without real passing evidence, even for an administrator', () => {
    expect(getQaDropIntent(issue('in_progress'), admin, ['closed'])).toEqual({ kind: 'blocked' });
    expect(getQaDropIntent(issue('verified'), admin, ['closed'])).toEqual({ kind: 'blocked' });
    const verified = issue('verified');
    verified.targets = [{ id: 'example-target', environment: 'Stage', component: '', build: 'example-build', required: true, deployedAt: verified.updatedAt, deployedBy: developer.id, deploymentEvidence: 'Example deployment record' }];
    verified.runs = [{ id: 'example-run', sequence: 1, fixCycle: 0, targetId: 'example-target', environment: 'Stage', component: '', build: 'example-build', result: 'pass', note: '', testerId: tester.id, createdAt: verified.updatedAt }];
    expect(getQaDropIntent(verified, tester, ['closed'])).toEqual({ kind: 'form', action: 'close', resolution: 'fixed' });
  });
  it('keeps reopen reasons and non-Bug resolution explicit', () => {
    expect(getQaDropIntent(issue('closed'), developer, ['in_progress'])).toEqual({ kind: 'form', action: 'reopen' });
    expect(getQaDropIntent({ ...issue('closed'), assigneeId: null }, tester, ['new', 'triaged'])).toEqual({ kind: 'form', action: 'reopen' });
    expect(getQaDropIntent(issue(), tester, ['dismissed'])).toEqual({ kind: 'form', action: 'close', resolution: 'wont_fix' });
  });
  it('enforces actors and refuses arbitrary backwards jumps', () => {
    expect(getQaDropIntent(issue(), { id: 'example-observer', role: 'member' }, ['in_progress'])).toEqual({ kind: 'blocked' });
    expect(getQaDropIntent(issue('in_progress'), admin, ['new'])).toEqual({ kind: 'blocked' });
  });
  it('does not open an empty verification form for historical PASS or an undeployed candidate', () => {
    expect(getQaDropIntent(issue('verified'), tester, ['failed'])).toEqual({ kind: 'blocked' });
    const candidate = issue('verification'); candidate.targets[0].deployedAt = null;
    expect(getQaDropIntent(candidate, tester, ['verified'])).toEqual({ kind: 'blocked' });
    expect(getQaDropIntent({ ...issue(), qaOwnerId: null }, admin, ['in_progress'])).toEqual({ kind: 'form', action: 'triage' });
  });
});

describe('QA board commands and form navigation', () => {
  const command = vi.fn(), list = vi.fn(), open = vi.fn();
  let current: QaIssue;
  const client = { command, list } as unknown as QaClient;
  const drop = (target: QaState) => act(() => dnd.end!({ active: { id: current.id, data: { current: { issue: current } } }, over: { id: `qa-column-${target}` } } as unknown as DragEndEvent));
  const mount = (workflow: QaWorkflow = DEFAULT_QA_WORKFLOW) => render(<QaKanban client={client} actor={admin} workflow={workflow} filters={{}} onOpen={open} />);
  beforeEach(() => {
    vi.clearAllMocks(); current = issue();
    list.mockImplementation(async ({ states }: { states: QaState[] }) => ({ issues: states.includes(current.state) ? [current] : [], total: states.includes(current.state) ? 1 : 0, hasMore: false }));
  });
  it('waits for server acknowledgement before refetching column counts', async () => {
    let acknowledge!: (value: QaIssue) => void;
    command.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    mount(); await screen.findByText(current.title);
    const originalLoads = list.mock.calls.length;
    drop('in_progress');
    expect(command).toHaveBeenCalledWith(current, { type: 'start_fix' }, expect.any(String));
    expect(list).toHaveBeenCalledTimes(originalLoads);
    current = { ...current, state: 'in_progress', version: 2 };
    await act(async () => acknowledge(current));
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(originalLoads));
    expect(open).not.toHaveBeenCalled();
  });
  it('retains the idempotency key on an uncertain response and prevents other drops until resolved', async () => {
    command.mockRejectedValueOnce({ status: 503, code: 'qa_unavailable' }).mockImplementationOnce(async () => { current = { ...current, state: 'in_progress' }; return current; });
    mount(); await screen.findByText(current.title); drop('in_progress');
    await screen.findByRole('alert');
    const first = command.mock.calls[0];
    drop('dismissed'); expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'qa.retry' }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls[1]).toEqual(first);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('opens a focused form for required data and leaves cancelled submissions unchanged', async () => {
    current = issue('verification'); mount(); await screen.findByText(current.title); drop('failed');
    expect(open).toHaveBeenCalledWith(current.id, 'record_verification', { result: 'fail', resolution: undefined });
    expect(command).not.toHaveBeenCalled(); expect(current.state).toBe('verification');
  });
  it('shows an explanation instead of silently moving to an unavailable state', async () => {
    mount(); await screen.findByText(current.title); drop('closed');
    expect(screen.getByText('qa.dropUnavailable')).toBeTruthy();
    expect(command).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it('ignores a cancelled drop outside all columns', async () => {
    mount(); await screen.findByText(current.title);
    act(() => dnd.end!({ active: { id: current.id, data: { current: { issue: current } } }, over: null } as unknown as DragEndEvent));
    expect(command).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it('retries the failed first page after a project change without mixing the previous project', async () => {
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
