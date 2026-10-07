import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQaIssue, type QaActor, type QaIssue } from '@/lib/qa/domain';
import type { QaClient } from '@/lib/qa/client';
import { DEFAULT_QA_WORKFLOW } from '@/lib/qa/workflow';

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string, options?: { title?: string }) => options?.title ? `${key}: ${options.title}` : key }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [{ id: 'example-project', name: 'Example project' }] }) }));
vi.mock('@/context/MemberContext', () => ({ useMemberContext: () => ({ users: [] as never[] }) }));
vi.mock('@/hooks/useProjectColor', () => ({ useProjectColor: () => () => '#008' }));
vi.mock('@/components/ConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(), ConfirmDialog: null as ReactNode }) }));
vi.mock('@/components/qa/QaIssueDetail', () => ({ QaFailure: () => <p role="alert">Command failed</p> }));
vi.mock('@/components/qa/QaFields', () => ({ qaButton: '' }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }));

// Use the actual QaKanban, QaIssueCard and dnd-kit sensors. DOM measurements
// enable drop hit testing; native scroll and overscroll still need a real phone.
import QaKanban from '@/components/qa/QaKanban';

const actor: QaActor = { id: 'example-admin', role: 'admin' };
function exampleIssue(): QaIssue {
  return { ...createQaIssue({ projectId: 'example-project', title: 'Example bug card', actual: 'Example failure', observedEnvironment: 'Stage' }, 'example-bug',
    { actor, workspaceId: 'example-workspace', now: '2026-10-07T00:00:00Z', newId: () => 'example-event', memberIds: new Set([actor.id]), projectIds: new Set(['example-project']), taskIds: new Set() }),
    state: 'triaged', assigneeId: actor.id, qaOwnerId: actor.id };
}
const point = (x = 350, y = 100) => ({ identifier: 1, clientX: x, clientY: y });
const start = (node: HTMLElement) => fireEvent.touchStart(node, { touches: [point()], changedTouches: [point()] });
const move = (node: HTMLElement, x: number, y = 100) => fireEvent.touchMove(node, { touches: [point(x, y)], changedTouches: [point(x, y)] });
const end = (node: HTMLElement, x = 350, y = 100) => fireEvent.touchEnd(node, { touches: [], changedTouches: [point(x, y)] });
const rect = (x: number, y: number, width: number, height: number): DOMRect => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) });

describe('QA board touch interaction', () => {
  const list = vi.fn(), command = vi.fn(), open = vi.fn();
  const client = { list, command } as unknown as QaClient;
  let current: QaIssue;
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); current = exampleIssue();
    list.mockImplementation(async ({ states }: { states: string[] }) => ({ issues: states.includes(current.state) ? [current] : [], total: states.includes(current.state) ? 1 : 0, hasMore: false }));
    command.mockImplementation(async (old: QaIssue, change: { state: QaIssue['state'] }) => { current = { ...old, state: change.state, version: old.version + 1 }; return current; });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const columns = [...document.querySelectorAll('section[aria-label^="qa.state."]')];
      const column = this.closest('section[aria-label^="qa.state."]');
      const index = column ? columns.indexOf(column) : -1;
      if (this === column) return rect(index * 280, 40, 260, 500);
      if (column) return rect(index * 280 + 8, 80, 244, 180);
      return rect(0, 0, 2400, 800);
    });
  });
  afterEach(async () => {
    await act(async () => {}); cleanup(); act(() => { vi.runOnlyPendingTimers(); });
    vi.useRealTimers(); vi.restoreAllMocks();
  });
  const mount = async () => { await act(async () => { render(<QaKanban client={client} actor={actor} workflow={DEFAULT_QA_WORKFLOW} filters={{}} onOpen={open} />); }); };
  const handle = () => screen.getByRole('button', { name: `board.dragCard: ${current.title}` });
  const title = () => screen.getByText(current.title);
  const overlayVisible = () => screen.queryAllByText(current.title).length === 2;

  it.each([1, 4, 7])('does not capture a slow vertical card swipe of %s px after 700 ms', async (distance) => {
    await mount(); const text = title(); start(text);
    expect(move(text, 350, 100 + distance)).toBe(true);
    act(() => { vi.advanceTimersByTime(700); });
    expect(move(text, 350, 100 + distance)).toBe(true); end(text, 350, 100 + distance);
    expect(overlayVisible()).toBe(false); expect(command).not.toHaveBeenCalled();
    fireEvent.click(text); expect(open).toHaveBeenCalledExactlyOnceWith(current.id, undefined, undefined);
  });

  it('keeps ordinary card swipes native in both axes', async () => {
    await mount(); const text = title();
    for (const [x, y] of [[390, 100], [350, 140]]) {
      start(text); expect(move(text, x, y)).toBe(true);
      act(() => { vi.advanceTimersByTime(400); }); end(text, x, y);
    }
    expect(overlayVisible()).toBe(false); expect(command).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });

  it('uses a distinct non-nested handle and changes a label once without creating deployment or verification evidence', async () => {
    await mount(); const target = handle();
    expect(target.parentElement!.closest('button')).toBeNull();
    fireEvent.click(target); expect(open).not.toHaveBeenCalled();
    start(target); act(() => { vi.advanceTimersByTime(299); }); expect(overlayVisible()).toBe(false);
    act(() => { vi.advanceTimersByTime(1); }); expect(overlayVisible()).toBe(true);
    expect(move(target, 700)).toBe(false); act(() => { vi.advanceTimersByTime(20); });
    await act(async () => { end(target, 700); });
    expect(command).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: current.id, state: 'triaged' }), { type: 'set_state', state: 'in_progress' }, expect.any(String));
    expect(current.targets).toEqual([]); expect(current.runs).toEqual([]); expect(open).not.toHaveBeenCalled();
  });

  it('cancels an early handle swipe without a drop and keeps the next normal tap usable', async () => {
    await mount(); const target = handle(); start(target);
    expect(move(target, 390)).toBe(true); act(() => { vi.advanceTimersByTime(400); }); end(target, 390);
    expect(overlayVisible()).toBe(false); expect(command).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(60); }); fireEvent.click(title()); expect(open).toHaveBeenCalledExactlyOnceWith(current.id, undefined, undefined);
  });

  it('keeps the next-action button separate from touching or dragging the card', async () => {
    await mount(); const action = screen.getByRole('button', { name: 'qa.startFix' }); start(action);
    act(() => { vi.advanceTimersByTime(400); }); end(action);
    expect(overlayVisible()).toBe(false); expect(command).not.toHaveBeenCalled();
    fireEvent.click(action); expect(open).toHaveBeenCalledExactlyOnceWith(current.id, 'start_fix', undefined);
  });

  it('retains Space/Escape on the card and handle, and Enter opens the card', async () => {
    await mount(); const card = title().closest('li')!;
    for (const target of [card, handle()]) {
      target.focus(); fireEvent.keyDown(target, { code: 'Space' }); expect(overlayVisible()).toBe(true);
      act(() => { vi.advanceTimersByTime(1); });
      await act(async () => { fireEvent.keyDown(document, { code: 'Escape' }); });
      expect(overlayVisible()).toBe(false); act(() => { vi.advanceTimersByTime(60); });
    }
    expect(command).not.toHaveBeenCalled(); fireEvent.keyDown(card, { key: 'Enter', code: 'Enter' });
    expect(open).toHaveBeenCalledExactlyOnceWith(current.id, undefined, undefined);
  });
});
